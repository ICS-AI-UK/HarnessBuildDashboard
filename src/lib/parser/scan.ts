/**
 * Event scanning (SPEC.md §2.1).
 *
 * Line-wise, tracking fenced-code state so a `###` inside a code block is never
 * mistaken for an event header — transcripts quote their own format often.
 */

import { createHash } from 'node:crypto';
import type { ParseWarning } from './types';

export type RawEvent = {
  seq: number;
  tsUtc: Date;
  role: string;
  account: string | null;
  kind: 'think' | 'message';
  body: string;
  actionCount: number;
};

export type ScanResult = {
  transcriptRef: string | null;
  declaredRangeText: string | null;
  declaredMessageCount: number | null;
  events: RawEvent[];
  warnings: ParseWarning[];
};

// `### <ts> — <Role> (<Account>) [<kind>]`, with the account optional.
// The separator is U+2014 EM DASH; never split on ASCII '-'.
const HEADER_RE =
  /^###\s+(?<ts>\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\s*—\s*(?<role>.+?)\s*(?:\((?<account>[^)]*)\)\s*)?\[(?<kind>think|message)\]\s*$/;

const FENCE_RE = /^\s*(```|~~~)/;
const ACTION_RE = /^>\s*\[action\]\s*$/;

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fingerprintEvent(
  tsIso: string,
  role: string,
  kind: string,
  body: string,
): string {
  return sha256(`${tsIso}|${role}|${kind}|${body}`);
}

export function scanTranscript(text: string): ScanResult {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  const warnings: ParseWarning[] = [];
  const events: RawEvent[] = [];

  let transcriptRef: string | null = null;
  let declaredRangeText: string | null = null;
  let declaredMessageCount: number | null = null;

  let inFence = false;
  let fenceToken = '';
  let current: { header: RegExpMatchArray; bodyLines: string[] } | null = null;
  let sawHeader = false;

  const flush = () => {
    if (!current) return;
    const g = current.header.groups!;
    const body = current.bodyLines.join('\n').trim();
    const ts = new Date(g.ts);
    if (Number.isNaN(ts.getTime())) {
      warnings.push({
        code: 'bad-timestamp',
        message: `Unparsable timestamp "${g.ts}" — event skipped.`,
      });
      current = null;
      return;
    }
    const actionCount = current.bodyLines.filter((l) => ACTION_RE.test(l.trim()))
      .length;
    events.push({
      seq: events.length,
      tsUtc: ts,
      role: g.role.trim(),
      account: g.account?.trim() ?? null,
      kind: g.kind as 'think' | 'message',
      body,
      actionCount,
    });
    current = null;
  };

  for (const line of lines) {
    // Fence tracking runs before header matching, so quoted transcripts are inert.
    const fence = line.match(FENCE_RE);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceToken = fence[1];
      } else if (fence[1] === fenceToken) {
        inFence = false;
        fenceToken = '';
      }
      if (current) current.bodyLines.push(line);
      continue;
    }

    if (!inFence) {
      const header = line.match(HEADER_RE);
      if (header) {
        flush();
        current = { header, bodyLines: [] };
        sawHeader = true;
        continue;
      }
    }

    if (current) {
      current.bodyLines.push(line);
      continue;
    }

    // Preamble, before the first header.
    if (!sawHeader) {
      const ref = line.match(/^#\s*Chat transcript:\s*(\S+)/i);
      if (ref) transcriptRef = ref[1];
      const declared = line.match(/^Messages from\s+(.+?)(?:\s*—\s*(\d[\d,]*)\s+messages?)?\s*$/i);
      if (declared) {
        declaredRangeText = declared[1].trim();
        if (declared[2]) declaredMessageCount = Number(declared[2].replace(/,/g, ''));
      }
    }
  }
  flush();

  if (inFence) {
    warnings.push({
      code: 'unclosed-fence',
      message: 'An unterminated code fence was found; later headers may have been skipped.',
    });
  }

  if (events.length === 0) {
    warnings.push({
      code: 'no-events',
      message: 'No event headers matched. Is this a transcript export?',
    });
    return { transcriptRef, declaredRangeText, declaredMessageCount, events, warnings };
  }

  // Timestamps out of order: sort by time, keep original order as the tiebreak.
  const withIndex = events.map((e, i) => ({ e, i }));
  const sorted = [...withIndex].sort(
    (a, b) => a.e.tsUtc.getTime() - b.e.tsUtc.getTime() || a.i - b.i,
  );
  const wasReordered = sorted.some((s, i) => s.i !== i);
  if (wasReordered) {
    warnings.push({
      code: 'out-of-order',
      message: 'Events were not in timestamp order; they have been sorted.',
    });
  }
  const ordered = sorted.map((s, i) => ({ ...s.e, seq: i }));

  if (declaredMessageCount !== null && declaredMessageCount !== ordered.length) {
    warnings.push({
      code: 'count-mismatch',
      message: `The file declares ${declaredMessageCount} messages; ${ordered.length} event headers were parsed. The parsed count is authoritative.`,
    });
  }

  return {
    transcriptRef,
    declaredRangeText,
    declaredMessageCount,
    events: ordered,
    warnings,
  };
}
