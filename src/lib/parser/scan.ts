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
  /** Credits this message cost, when the export records them. */
  credits: number | null;
  /** The model that produced it, when the export names one. */
  model: string | null;
};

/** The `## Credit usage` block some exports carry, as declared by the platform. */
export type DeclaredCredits = {
  total: number | null;
  byDay: Record<string, number>;
};

/** The `## Models used` block, as declared by the platform. */
export type DeclaredModel = {
  model: string;
  messages: number;
  credits: number;
};

export type ScanResult = {
  transcriptRef: string | null;
  declaredRangeText: string | null;
  declaredMessageCount: number | null;
  declaredCredits: DeclaredCredits | null;
  declaredModels: DeclaredModel[] | null;
  events: RawEvent[];
  warnings: ParseWarning[];
};

// `### <ts> — <Role> (<Account>) [<kind>] (<n> credits)`, account and credits
// both optional — exports differ, and an operator's own message costs nothing.
// The separator is U+2014 EM DASH; never split on ASCII '-'.
const HEADER_RE =
  /^###\s+(?<ts>\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\s*—\s*(?<role>.+?)\s*(?:\((?<account>[^)]*)\)\s*)?\[(?<kind>think|message)\]\s*(?:\(\s*(?<credits>\d+(?:\.\d+)?)\s*credits?\s*\)\s*)?(?:\[(?<model>[^\]]+)\]\s*)?$/;

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
  let declaredCreditTotal: number | null = null;
  const declaredCreditsByDay: Record<string, number> = {};
  const declaredModelRows: DeclaredModel[] = [];
  let block: 'none' | 'credits' | 'models' = 'none';

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
      credits: g.credits === undefined ? null : Number(g.credits),
      model: g.model?.trim() || null,
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

      // `Messages from <date|range> — N messages`
      const declared = line.match(/^Messages from\s+(.+?)(?:\s*—\s*(\d[\d,]*)\s+messages?)?\s*$/i);
      if (declared) {
        declaredRangeText = declared[1].trim();
        if (declared[2]) declaredMessageCount = Number(declared[2].replace(/,/g, ''));
      }

      // `Exported <timestamp> — N messages` (a different export's wording).
      // The export time says nothing about which days the file covers, so it is
      // not treated as a range — only the message count is taken.
      const exported = line.match(/^Exported\s+(\S+)\s*—\s*(\d[\d,]*)\s+messages?\s*$/i);
      if (exported) {
        declaredMessageCount = Number(exported[2].replace(/,/g, ''));
      }

      // Preamble blocks: `## Credit usage` (a total, then `| Date | Credits |`)
      // and `## Models used` (`| Model | Messages | Credits |`).
      if (/^##\s*Credit usage/i.test(line)) block = 'credits';
      else if (/^##\s*Models used/i.test(line)) block = 'models';
      else if (/^##\s/.test(line)) block = 'none';

      if (block === 'credits') {
        const total = line.match(/^Total:\s*([\d,]+(?:\.\d+)?)\s*credits?/i);
        if (total) declaredCreditTotal = Number(total[1].replace(/,/g, ''));

        const row = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d,]+(?:\.\d+)?)\s*\|/);
        if (row) declaredCreditsByDay[row[1]] = Number(row[2].replace(/,/g, ''));
      }

      if (block === 'models') {
        const row = line.match(
          /^\|\s*([^|\s][^|]*?)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+(?:\.\d+)?)\s*\|/,
        );
        // Skip the header row and the `| --- |` separator.
        if (row && !/^-+$/.test(row[1]) && !/^model$/i.test(row[1])) {
          declaredModelRows.push({
            model: row[1],
            messages: Number(row[2].replace(/,/g, '')),
            credits: Number(row[3].replace(/,/g, '')),
          });
        }
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

  const declaredCredits: DeclaredCredits | null =
    declaredCreditTotal === null && Object.keys(declaredCreditsByDay).length === 0
      ? null
      : { total: declaredCreditTotal, byDay: declaredCreditsByDay };

  const declaredModels: DeclaredModel[] | null = declaredModelRows.length ? declaredModelRows : null;

  if (events.length === 0) {
    warnings.push({
      code: 'no-events',
      message: 'No event headers matched. Is this a transcript export?',
    });
    return {
      transcriptRef,
      declaredRangeText,
      declaredMessageCount,
      declaredCredits,
      declaredModels,
      events,
      warnings,
    };
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
    declaredCredits,
    declaredModels,
    events: ordered,
    warnings,
  };
}
