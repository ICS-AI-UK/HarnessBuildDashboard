# Harness Build Dashboard

Upload agent chat transcripts, infer cycle statistics from their timestamps, and read them as a
build dashboard — per day, per project, and across the portfolio.

[`SPEC.md`](SPEC.md) is the specification this implements; section numbers are cited in the code.

## Running locally

```bash
npm install
```

```bash
npm run dev
```

That is the whole setup. There is no database to install or provision: data is stored as documents
under `.data/`, which is created on first write and gitignored.

```bash
npm test
```

## Deploying to Netlify

Connect the repository. [`netlify.toml`](netlify.toml) sets the build and loads
`@netlify/plugin-nextjs`; nothing else needs configuring, and it runs on the free tier.

On Netlify the same document store is backed by **Netlify Blobs**, which is included on the free
plan and needs no provisioning. Locally it falls back to the filesystem. The two drivers sit behind
one interface in [`src/lib/store/index.ts`](src/lib/store/index.ts), so nothing above that file
knows which is in use. Set `STORAGE_DRIVER=filesystem|netlify-blobs` to force one, or `STORAGE_DIR`
to move the local directory.

**Platform limits this design works within.** A Netlify function accepts at most a 6 MB request body
and runs for at most 60 seconds, neither configurable.

- Uploads are **chunked**, so file size is not bounded by the request limit.
- Imports store **aggregates**, not a row per event. A 25 MB, 36,720-event transcript parses in ~10 s
  and commits in ~13 s, writing about thirty documents. A per-event schema would write tens of
  thousands of rows and would not fit in the time limit.
- Evidence views rebuild event detail by re-parsing the stored transcript on demand, so nothing is
  lost by not storing events.

## What it does

**Projects** — each holds its own transcripts, calendar, settings and dashboard. Working language,
timezone and the operator-answer threshold are per project.

**Multi-day imports** — one file may contain any number of days. Days come from the event
timestamps, never from the filename or the transcript's own `Messages from …` line, both of which
are displayed but not trusted. A three-week import populates three weeks of calendar and leaves the
quiet days between it blank.

**Overlap resolution** — exports are often cumulative, so a later one re-covers days an earlier one
already did. Whole-file hashing cannot catch that, because the files genuinely differ, so every
event carries a fingerprint and each day is classified and resolved on its own: new, identical,
superset, subset, disjoint or partial. Pooling is offered only where two records share nothing;
everywhere else the defaults are skip or supersede, so no event is ever counted twice. Every
decision is reversible from the transcript screen.

**Calendar** — a month grid, per project or across all, shaded by cycle count, distinguishing a day
with no upload from a day that has one but resolved no cycles.

**Averages** — the portfolio view offers both *macro* (mean of each project's own value, every
project counting once) and *pooled* (recomputed over every cycle). Pooled medians recompute from the
combined cycle set rather than averaging medians; macro averages the per-project medians and says
so. Projects below their minimum cycle count are excluded and listed.

## Metrics

Cycle count and duration percentiles, reasoning steps, minutes per step, step latency, the
elapsed-day partition, dispatch-length and work-size correlations, mid-work operator interruptions,
unrecorded authorisations, and language drift. Definitions are in [`SPEC.md`](SPEC.md) §5.

Conventions applied throughout: R-7 percentiles; Pearson *r* suppressed below n = 8 or when a
variable is constant; empty sets render as `—` rather than `0`; open cycles counted but excluded
from duration figures, and measured only up to the next dispatch; a cycle that crosses midnight
counted wholly on the day it began — except in the elapsed-day partition, which clips at midnight so
its bands sum to each day's window.

No model is involved in any figure or insight. Everything is reproducible from the transcript alone.

## Layout

```
src/lib/store/      document store: Netlify Blobs or the local filesystem
src/lib/repo.ts     documents in, domain objects out; day rebuilds
src/lib/parser/     scan → language → cycle resolution → pipeline (pure, no I/O)
src/lib/metrics/    statistics, day slices, per-day computation, aggregation
src/lib/overlap.ts  per-day overlap classification
src/lib/ingest.ts   analyse (dry run), commit, re-parse for evidence
src/app/            pages and API routes
tests/              golden-file, multi-day, overlap and store round-trip tests
```

## Tests

The supplied transcript is a fixture with its derived values asserted, so any pipeline change that
moves them has to move them deliberately: 612 events, 24 cycles, 456 in-cycle reasoning steps, one
mid-work operator answer, 12 French close-out drifts of which 11 unchallenged, 176 minutes of
operator wait.

Two tests matter most. One imports a 7-day export and then a cumulative re-export covering the same
days, and asserts the overlapping days report exactly what they did after the first import alone.
The other asserts that an import writes a handful of documents rather than a row per event.

A parse benchmark is included but skipped by default, since it needs a large fixture:

```bash
BENCH=1 BENCH_FILE=/path/to/big.md npx vitest run tests/bench.test.ts
```
