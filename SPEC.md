# Harness Build Dashboard — Specification

**Status:** Draft v1.0 · **Date:** 22 September 2026 · **Owner:** Lee Englestone

---

## 1. Purpose

A web application that ingests agent **chat transcript files**, infers **cycle statistics** from the
message timestamps and content, and presents them as a **Build Dashboard** in the style of the
"ICS.AI SMART:LGR — Build Dashboard, 21 September 2026" report.

Three capabilities distinguish it from a one-off report:

1. **Projects** — transcripts are grouped into named projects, each with its own dashboard.
2. **Calendar** — a month view showing which days have transcripts uploaded, per project and across all.
3. **Averages** — cross-project aggregate figures, so one project can be read against the portfolio.

A single uploaded file may contain **any number of days** of chat. Multi-day is the normal case, not
an exception: days are derived from event timestamps, one import can populate a whole month of the
calendar, and overlapping re-exports are detected and resolved per day rather than double-counted
(§3.4).

### 1.1 Scope assumptions

These were not specified and are taken as reasonable defaults; each is cheap to change.

| Assumption | Default taken |
|---|---|
| Stack | Next.js 15 (App Router) + TypeScript |
| Persistence | A document store, not a database: aggregates and raw transcripts as keyed JSON/text (§8) |
| Deployment | Netlify on the free tier, and the same code running locally with nothing installed (§12) |
| Charts | Recharts; server-computed values, client-rendered charts |
| Transcript source | Files are exported by the agent harness; the app never talks to the harness |

**Why a document store rather than a database.** The app stores what it computes, not what it read:
one record per project, one per transcript, one per project-day. A 28-day import writes about 30
documents where a per-event schema would write 36,000 rows to hold the same fifty numbers a day.
That keeps it inside a free Netlify account, removes any external service from local development,
and makes an import fast enough to finish inside a serverless function's time limit. Event-level
evidence is not lost: the raw transcript is stored, and detail views rebuild from it on demand
(§7.4, §7.5).

---

## 2. Input format

### 2.1 File shape

Plain UTF-8 Markdown. Verified against
`chat-e5ab9fac8b0647539a15aa97b04bff10-2026-09-21.md` (5,210 lines, 612 events).

```
# Chat transcript: e5ab9fac8b0647539a15aa97b04bff10
Messages from 2026-09-21 — 645 messages

### 2026-09-21T07:58:59.496156Z — Team Leader (ICS_AI) [think]
I'm getting started.

### 2026-09-21T07:59:06.462844Z — Team Leader (ICS_AI) [think]
The operator has sent a new attachment — reading it to determine the next cycle's scope.
> [action]

### 2026-09-21T08:01:04.215082Z — User (ICS_AI) [message]
Submitted
```

**Preamble** (optional, lines before the first `###`):

- `# Chat transcript: <transcript_ref>` — an opaque id, used for de-duplication and display.
- `Messages from <YYYY-MM-DD> — <N> messages` — a *declared* range and count. The declared date may
  be a single day, a range (`Messages from 2026-09-15 to 2026-09-21`), or absent. **It is recorded
  for display only and never used for bucketing** — the days a transcript covers are always derived
  from the event timestamps (§3.4). Likewise the declared count is advisory; the parser trusts its
  own count and surfaces a mismatch as a warning, not an error (the sample declares 645 and yields
  612 parsable event headers).

The filename may also carry a date (`chat-<ref>-2026-09-21.md`). This is treated the same way:
displayed, never trusted. A file named for one day but containing a week of events is imported as a
week.

**Preamble blocks.** Newer exports carry two summary tables before the first event:

```
Exported 2026-09-24T16:21:31.469Z — 1022 messages

## Credit usage
Total: 15543.87 credits

| Date | Credits |
| --- | --- |
| 2026-09-23 | 6815.31 |

## Models used

| Model | Messages | Credits |
| --- | --- | --- |
| claude-opus-5 | 931 | 15543.87 |
```

Both are **declared** figures: recorded, displayed and reconciled against, but
never authoritative. `Exported <timestamp>` states when the file was written and
says nothing about the days it covers, so unlike `Messages from …` it is not
read as a range.

**Event header grammar:**

```
### <ISO-8601 timestamp> — <Role> (<Account>) [<kind>] (<n> credits) [<model>]
```

The account, the credit suffix and the model suffix are each **optional** and
appear in that order. Exports differ between versions, an operator's own message
costs nothing so carries no credits, and older exports name no model at all. A
pattern anchored on the kind silently drops every priced message: when that
happened here, 81 of 921 events survived and an entire role disappeared, so the
grammar is tested against both an export that carries these suffixes and one
that does not.

- `<timestamp>` — RFC 3339, microsecond precision, `Z`-suffixed (UTC).
- `—` — U+2014 EM DASH, space-padded. Parsers must not split on ASCII `-`.
- `<Role>` — free text. Observed: `Team Leader`, `Engineer`, `User`.
- `<Account>` — parenthesised, e.g. `ICS_AI`.
- `<kind>` — `think` or `message`.

**Body** — every line after the header up to the next `### ` header at column 0, trimmed.
A `### ` occurring inside a fenced code block is **not** an event header; the parser tracks fence
state (``` and ~~~) while scanning.

**Action markers** — a body line of exactly `> [action]` denotes an elided tool invocation.
Multiple markers may appear in one body. These are counted as **tool actions**, distinct from
reasoning steps.

### 2.2 Role semantics

| Role | Meaning |
|---|---|
| `User` | The human **operator**. Everything else is the agent system. |
| `Team Leader` | Orchestrator. Receives operator instruction, issues a **dispatch**, receives the engineer's report, writes the **close-out** back to the operator. |
| `Engineer` | Worker. Does the cycle; its `[message]` is the internal completion report. |

Roles are **not** hard-coded. Each project carries a role map (§6.2) so a differently-named
harness (`Lead`, `Worker`, `Operator`) can be ingested without code changes. The map assigns each
observed role exactly one **role class**: `operator`, `orchestrator`, or `worker`.

---

## 3. Derived domain model

```
Project ──< Transcript ──< (day contribution)
                │
                └──< Day ──< Cycle / OperatorTurn / LanguageDrift / PlatformError
```

Events exist during parsing and in the evidence views, but are not stored (§8): what persists is a
day's cycles, turns, drifts and errors, plus the raw transcript they were derived from.

### 3.1 Event

One parsed `###` block. Stored verbatim plus: `seq` (0-based file order), `ts_utc`, `role`,
`role_class`, `kind`, `body`, `body_chars`, `action_count`.

### 3.2 Cycle

The central unit. A cycle is **dispatch → close-out**, both `orchestrator` + `message` events.

**Classification.** Orchestrator messages alternate dispatch, close-out, dispatch, close-out…
Relying on parity alone is brittle, so each orchestrator message is scored and the sequence is then
resolved:

*Dispatch signals* (+1 each):
- Body matches `^\**(CYCLE\s+)?[A-Z][A-Z0-9]*(-[A-Z0-9]+)*\b.*—` — a tag then an em dash
  (`CYCLE SEED-1 — RUN THE DECISIONS SEED`, `MAP-1 READ-BACK — STRICTLY READ-ONLY`).
- Contains `Authorisation:` / `Authorization:`, `Type:`, `Working language:`, `=== ` section rules.
- Preceded within 3 events by an orchestrator `[think]` matching `dispatch|registering|task \d+`.

*Close-out signals* (+1 each):
- Body matches `\b(is done|is complete|complete|terminé|halted|halt(ed)? at Step 0|clos)\b` near the start.
- Followed within 3 events by an operator message **or** by an orchestrator `[think]` matching
  `getting started`.
- Contains a ledger/verdict block (`Ledger:`, `Verdict`, `**(1)**`).

**Resolution.** Take the highest-scoring assignment over the sequence subject to the constraint
that dispatches and close-outs alternate and a dispatch precedes its close-out
(a simple two-state Viterbi pass). Ties break to alternation starting at `dispatch`.
On the sample this yields **24 clean pairs, 0 unmatched**.

Every cycle records `classification_confidence`; anything below 0.7 is flagged in the UI and can be
corrected by hand (§7.5). A dispatch with no close-out becomes an **open cycle**: counted, excluded
from duration statistics, shown as such. Its work is measured up to the **next dispatch**, not to the
end of the file — running it to the end would attribute the rest of the transcript to it, and with
several open cycles the same events would be counted once per cycle.

**Cycle fields:**

| Field | Derivation |
|---|---|
| `tag` | First `[A-Z][A-Z0-9-]*` token of the dispatch body (`SEED-1`, `AREA-4`, `D3-A`), else `#<n>` |
| `started_at` | Dispatch `ts_utc` |
| `ended_at` | Close-out `ts_utc` |
| `duration_s` | `ended_at − started_at` |
| `dispatch_chars` | Dispatch `body_chars` (the relayed dispatch, always present) |
| `operator_dispatch_chars` | Chars of the operator message that authorised it, `NULL` if attached (§5.7) |
| `reasoning_steps` | Count of `kind = think` events strictly between dispatch and close-out |
| `tool_actions` | Sum of `action_count` over the same range |
| `operator_answers` | Count of mid-work operator answers in the same range (§5.6) |
| `cycle_type` | Parsed from `Type:` in the dispatch (`BUILD`, `MIXED`, `INVESTIGATION`), else `UNKNOWN` |
| `halted` | Close-out matches `halt(ed)?\b` |
| `authorisation_recorded` | See §5.7 |

### 3.3 Operator turn

Any `operator` + `message` event, classified by body length (§5.6).

### 3.4 Day — and multi-day imports

**A single import routinely contains many days of chat.** One transcript covering three weeks is as
ordinary as one covering an afternoon, and the model treats the multi-day case as the normal one.

- **Transcript ↔ day is many-to-many.** A transcript covers every day on which it has at least one
  event; a day may be covered by several transcripts. Neither side is the owner. The join is
  materialised as `transcript_day` (§8) so the calendar and day dashboards are single indexed reads.
- **Bucketing** is by the date of each **event timestamp**, never by the filename or preamble (§2.1).
- **Cycle day** is the date of the cycle's `started_at`. A cycle that runs across midnight belongs
  wholly to the day it began, and its duration is not split — splitting a cycle would make
  "median cycle" meaningless. The one deliberate exception is the elapsed-day partition (§5.5),
  which clips at midnight so that its bands still sum to the day.
- **Timezone.** The project's `timezone` (default `UTC`) determines where day boundaries fall.
  Changing it re-buckets every transcript in the project and rebuilds its rollups — a confirmed
  action, since it moves historical figures.
- **Sparse coverage is expected.** A transcript spanning 1–21 September with work on nine of those
  days covers nine days, not twenty-one. Days with events but no resolved cycles are covered but
  empty, and the calendar distinguishes the two (§6.3).

#### 3.4.1 Overlapping transcripts

The significant hazard of multi-day imports: exports are often **cumulative**, so a later export
re-covers days an earlier one already did. Left alone this silently doubles every figure on the
overlapping days — the failure would look like a productive week rather than an error.

Whole-file SHA-256 (§6.2) does not catch this, because the files genuinely differ. Overlap is
therefore detected at **event level**:

- Every event carries a `fingerprint` = SHA-256 of `ts_utc | role | kind | body`, unique within a
  project.
- On import, the incoming events' fingerprints are matched against those already stored for the
  project. The result is classified per day:

| Per-day result | Meaning | Default |
|---|---|---|
| **New** | No fingerprints for that day exist yet | Import |
| **Identical** | Every fingerprint already present, and no extras | Skip, note in the report |
| **Superset** | All existing fingerprints present, plus new ones | Supersede: the new transcript becomes authoritative for that day, the old one's contribution is retired |
| **Subset** | Every incoming fingerprint already present, and the existing record has more — a truncated re-export | Skip: the record already held is the fuller one |
| **Disjoint** | No fingerprints in common (e.g. two products, or two sessions on one day) | Pool: both contribute, the day's cycles combine |
| **Partial** | Some shared, some not, in both directions — neither record contains the other | Skip, flagged as needing a decision |

**Pooling a day that shares events is not offered.** Pooling two records that overlap counts the
shared events twice, and a doubled day reads as a productive one rather than as an error — it is the
single failure this mechanism exists to prevent. So `pool` is available only for **disjoint** days,
and no default action for an overlapping day is ever `import` or `pool`: every default is `skip` or
`supersede`, both of which leave each event counted exactly once. Where neither record contains the
other, the app declines to guess and asks.

Resolution is **per day, not per file**: one import may add four new days, supersede two, and skip
one, and the parse report states exactly that. Retirement is by a `superseded` flag on the
transcript-day join, never by deleting events, so any decision is reversible from the transcript
detail screen (§7.5).

**Resolutions are re-checked at commit.** A preview is taken against the project as it stood at that
moment, so anything committed in between — another file in the same batch, or another person — can
make the answer unsafe: a day previewed as *new* may be held by the time it commits, and importing it
again would count its events twice. The commit therefore re-classifies each day and honours a stored
resolution only if the freshly computed overlap still permits it, falling back to the safe default and
reporting what it did instead. The guarantee does not depend on the client: the preview can be as
stale as it likes and the figures stay right.

---

## 4. Statistical conventions

Applied uniformly so figures are reproducible.

- **Percentiles** — linear interpolation between order statistics (R-7, i.e. Excel `PERCENTILE.INC`,
  NumPy default). Reported alongside `n`.
- **Median** — the 50th percentile under the same method.
- **Correlation** — Pearson *r*, reported to 2 dp with `n`. Suppressed and shown as `—` when
  `n < 8` or either variable is constant.
- **Rounding** — computed at full precision, rounded only for display: minutes to 1 dp,
  seconds to 1 dp, correlations to 2 dp, percentages to whole numbers.
- **Empty sets** — render as `—`, never `0`. A day with no cycles is distinct from a day with zero
  errors.
- **Open cycles** — excluded from duration, percentile and correlation statistics; included in counts,
  with the exclusion stated in the tile footnote.

---

## 5. Metric catalogue

Every figure on the reference dashboard, with its definition. Section numbers map to the PDF.

### 5.1 Headline strip

| Metric | Definition |
|---|---|
| **Cycles** | Count of resolved cycles in scope |
| **Reasoning steps** | Count of `think` events in scope (the sample: 456 in-cycle, ~19/cycle) |
| **Platform errors** | Count of platform-error incidents (§5.8) |
| **Window** | `min(ts)` – `max(ts)` over events in scope, rendered `08:00–16:00`. Over a multi-day scope this is computed **per day** and reported as a range of daily windows plus the count of active days (`08:00–17:20 across 9 active days`), never as one span from the first event to the last — that would read as a 21-day working day. |

### 5.2 The day at a glance

Per project (the reference shows two columns; the app shows one column per project in scope).

| Row | Definition |
|---|---|
| Cycles | `count(cycles)` |
| Median cycle | `median(duration_s)` in minutes |
| 90th percentile | `p90(duration_s)` in minutes |
| Longest cycle | `max(duration_s)` in minutes |
| Minutes per reasoning step | `median(duration_s / 60 / reasoning_steps)` over cycles with `steps > 0` |
| Step latency, median | `median(Δt)` between consecutive agent events **within** a cycle, seconds |
| Platform errors | §5.8 |
| Mid-work operator answers | §5.6 |

> **Step latency** deliberately excludes gaps that cross a cycle boundary — those are operator wait,
> not agent latency. Measured this way the sample gives 12.8 s median, consistent with the
> reference's 11.1 s / 15.2 s bands.

### 5.3 Cycle time distribution

Histogram (or strip plot) of `duration_s` in minutes, one series per project in scope, with median
and p90 rules overlaid. Caption: `Minutes, dispatch to close-out — <n> cycles`.

### 5.4 Complexity vs. duration

Pearson *r* between `dispatch_chars` and `duration_s`, per project and pooled, plus the observed
character range. The reference's finding — "dispatch length and complexity cost you nothing" — is a
**conclusion**, not a stored value; the app presents *r*, *n* and the range, and the insight engine
(§5.10) may attach the narrative when the rule fires.

Also computed, as the contrast: Pearson *r* between `reasoning_steps` and `duration_s`.
This is expected to be strongly positive (reference: +0.99 / +0.96).

Where `operator_dispatch_chars` is available for enough cycles, the same correlation is offered
against the *operator's own* dispatch rather than the relayed one, since attached dispatches make
this sparse.

### 5.5 Where the elapsed day goes

The wall-clock day is partitioned, with no double counting:

| Band | Definition |
|---|---|
| **In-cycle** | Σ `duration_s` |
| **Operator wait** | Σ gaps from a close-out to the next dispatch (sample: 175.9 min) |
| **Pre-first / post-last** | From window start to first dispatch, and last close-out to window end |

Rendered as a stacked bar. Operator wait is labelled as **not an agent cost**.

**Day boundaries.** This is the one metric where intervals are **clipped at midnight**: a cycle or a
wait that crosses into the next day contributes to each day only the part that fell within it.
Without clipping the bands would not sum to the day's window. This is deliberately different from
the cycle-level statistics in §5.2, which attribute a whole cycle to its start day — the two answer
different questions ("where did this day go?" versus "how long do cycles take?") and each panel
states which convention it uses.

**Multi-day scopes.** Over a range, the partition is computed per day and then summed, so days with
no activity contribute nothing rather than inflating "operator wait" with overnight gaps. A gap from
a close-out at 16:00 to the next dispatch at 09:00 the following morning is **not** 17 hours of
operator wait: each day's window (§5.1) bounds its own bands.

### 5.6 Mid-work operator answers

An operator turn is an **answer** (interruption) when `body_chars < answer_threshold`
(default **600**, per project). Otherwise it is a **pasted dispatch**.

Validated on the sample: the single answer was 9 chars (`Submitted`); every dispatch was
683–3,441 chars. The gap is wide, so the threshold is not delicate — but it is configurable, and the
Settings screen plots the actual length distribution with the threshold overlaid so it can be set
by eye.

Reported: count of answers; count of dispatches; `answers / (answers + dispatches)` as the
**interruption rate**; the verbatim answer texts (the reference lists `"Skip"`, `"Yes"`,
`"Submitted"`); and answers attributed to the cycle they landed inside.

### 5.7 Attached-dispatch audit gap

When the operator attaches rather than pastes a dispatch, the transcript records **no operator
message at all** — the cycle's stated authority is absent from the record.

A cycle is `authorisation_recorded = false` when no operator `message` event classified as a
dispatch occurs between the previous close-out and this dispatch.

Reported: `n unrecorded / n cycles` (the reference: 6 of 31), and a reconstructed timeline excerpt
showing the hole, as the PDF does:

```
08:34:29  Team Leader [message]  SEED-1 is done...
              << your instruction goes here, and is not recorded >>
08:46:05  Team Leader [think]    I'm getting started.
08:46:36  Team Leader [message]  CYCLE FIN-1 — its own version, relayed to Alex
```

### 5.8 Platform errors

Detected by matching event bodies against a **rule set** — an ordered list of
`{ id, label, pattern, severity }` seeded with the reference's categories (overload, container
failure, quota exhaustion, corruption) and editable per project. Consecutive matches of the same
rule within 120 s collapse into one incident.

Because the rule set is editable, every platform-error figure links to the matching events so a
false positive is one click from visible.

### 5.9 Language drift

| Metric | Definition |
|---|---|
| **Replies in non-working language** | Agent `message` events whose detected language ≠ the project's `working_language` |
| **Times English was requested** | Operator or orchestrator messages matching the request patterns (`Working language: English`, `Ask me in English`, `in English`) |
| **Unchallenged drifts** | Drifts with no such request in the following `k` events (default 3) or before the next dispatch |

Detection uses a compact n-gram language identifier (e.g. `franc`) over the body with code blocks,
inline code, URLs and file paths stripped — those are English-looking noise inside otherwise French
prose. Confidence below a threshold yields `undetermined`, not a drift.

Validated: the sample's 12 French close-outs were all found by this approach, matching the
reference's characterisation that the drifts were close-out reports — the verdicts the day's
decisions rest on.

Drift is also broken out by **event class** (dispatch / close-out / internal), because a drifted
close-out is the finding.

### 5.10 Insights ("Four things worth doing")

A deterministic rule engine over the computed metrics, each rule emitting a headline, a one-line
justification citing its own numbers, and a link to the evidence. Seed rules:

| Rule | Fires when |
|---|---|
| Halt on language drift | `unchallenged_drifts > 0` |
| Paste dispatches, do not attach them | `unrecorded_authorisations / cycles > 0.1` |
| Investigate interruptions | `interruption_rate` exceeds the portfolio average by > 10 pp |
| Keep writing dispatches in full | `\|r(dispatch_chars, duration)\| < 0.2` and `n ≥ 8` |

Rules live in a config file, not in component code. No LLM is involved — figures on this dashboard
must be reproducible from the transcript alone.

---

### 5.11 Credit spend

Exports that price their messages carry `(n credits)` on each header. These are **per-message costs,
not a running total** — the early rise in a conversation is context growing, not an accumulator — and
they sum to the platform's own daily figures. Summing a cumulative series instead would overstate a
day by orders of magnitude, so the two are told apart by checking the sum against the declared table.

| Metric | Definition |
|---|---|
| **Credits** | Σ recorded credits. `null`, not `0`, when no event carries them |
| **Credits per day** | Total ÷ **days that carry credit data**, not days in range |
| **Median day** | Median of the daily totals (R-7) |
| **Credits per cycle** | Total ÷ cycles on credit-bearing days |
| **Credits per reasoning step** | Total ÷ steps on credit-bearing days |
| **Spend by role** | Credits grouped by role class — operator turns are free |
| **Costliest day** | The highest daily total, and its multiple of the average |

Averages divide by credit-bearing days deliberately: spreading a fortnight's spend over thirty
calendar days understates the rate a team is actually burning at.

**Reconciliation.** Per-message figures are rounded to 2 dp, so summing hundreds of them drifts from
the declared daily total by a few hundredths. The panel states both and calls a gap under 1% what it
is — rounding — while saying plainly when it is larger than rounding explains.

**An export without credits reads as unknown, not free.** Every derived rate is suppressed rather
than dividing by nothing, and the panel says the transcripts do not record spend.

### 5.12 Credit burndown

A stated balance, drawn down by recorded spend and projected forward.

The projection separates two rates, because conflating them is the easy way to be wrong by a factor
of two:

- **Per active day** — what a working day costs.
- **Per calendar day** — that rate scaled by how often days are worked.

**The rate is taken from the most recent working days, not from all of them** (default: 7).
Spend per message climbs steeply as a conversation accumulates context — measured at **33x** between
the first and last day of one six-day build, from 24 to 781 credits a message. Averaging a rising
curve projects at a rate the team has already left behind, and overstates the runway exactly when the
balance matters most. The panel reports the recent rate against the lifetime one and says which way
spend is moving whenever they differ by more than a quarter.

A team spending 7,500 credits on each of nine days in a fortnight is burning ~4,800 a calendar day,
not 7,500. **Runway is quoted in calendar days**, since that is what a date on a budget means, and
the working cadence it assumes is stated alongside it.

| Field | Derivation |
|---|---|
| `spentSinceAsOf` | Σ credits on days ≥ the balance date. Earlier spend is already reflected in the stated figure |
| `remainingNow` | `balance − spentSinceAsOf` |
| `activeDayDensity` | credit-bearing days ÷ calendar days since the balance date |
| `exhaustionDate` | Projected forward one calendar day at a time, so the line lands on a real date |

States: `ok`, `exhausted` (spend already exceeds the balance — reported, never projected into the
negative), `no-rate`, `no-data`. The chart draws recorded spend solid and the projection dashed, so a
forecast is never mistaken for a measurement.

**Scope.** Each project carries its own optional balance and shows its own burndown. The portfolio
carries one account-wide balance and shows a combined burndown, summing every project's spend per
day against the single pool.

### 5.13 Models used

Exports that name a model carry it in brackets at the end of each header, and list totals in a
`## Models used` block.

Per day, and over a range, the app tallies **messages and credits separately per model**, because
they disagree: on the sample, one model accounts for 3% of messages and 0% of spend. Message counts
include the operator's free turns; credits do not. The chart stacks models per day, with the measure
switchable between messages and credits.

`primaryModel` is the model producing the most messages that day. An export naming no model yields
an empty tally rather than a fabricated one.
---

## 6. Features

### 6.1 Projects

CRUD over projects. Fields: `name`, `slug`, `description`, `colour` (chart series colour),
`working_language` (default `en`), `timezone` (default `UTC`), `answer_threshold` (default 600),
`role_map`, `archived`.

**Clearing a project** deletes every transcript it holds, the raw files kept for evidence, and every
figure derived from them, while keeping the project and its settings — so a project can be emptied
and started again without losing its timezone, working language and thresholds. **Deleting a project**
removes the project record as well.

Both are irreversible and both sit behind a typed-name confirmation: the button stays disabled until
the project''s name is typed exactly, and the consequences are listed in full before the field rather
than after it. The clear-data panel states what is currently held ("2 transcripts across 10 days") so
the scale of the action is visible before it is taken.

Archiving hides a project from the default lists and **excludes it from cross-project averages**,
without deleting anything.

### 6.2 Upload

- Drag-and-drop or file picker. Multiple files per drop. `.md` and `.txt`, ≤ 25 MB each.
- The target project is chosen before upload; upload from inside a project pre-selects it.
- **De-duplication** is two-stage. First, SHA-256 of file bytes, scoped to the project — an exact
  re-upload is rejected outright with a link to the existing transcript. Second, event-level
  fingerprint matching (§3.4.1), which is what actually catches cumulative re-exports, since those
  differ as files but repeat whole days.
- **Overlap resolution is per day.** The upload screen shows a day-by-day table — date, events, cycles,
  and the classification from §3.4.1 — with a default action per row and a control to change it.
  A ten-day import that overlaps three existing days resolves those three and imports the other seven,
  in one action. A **bulk control** applies one choice to all rows of a given classification, so a
  cumulative re-export is not twenty individual decisions.
- Parsing is synchronous for files under ~5 MB and queued otherwise, with a progress state. Large
  multi-day imports report progress in days processed, not bytes read.
- The **parse report** is always shown: events parsed, days covered, cycles resolved per day,
  declared-vs-parsed message count, roles observed and how they mapped, low-confidence cycles,
  unmatched dispatches, per-day overlap decisions, and warnings. Nothing is silently dropped.
- A **dry-run preview** is available before committing, and is the default when an import touches
  days that already have data — a multi-day import is exactly the case where committing blind is
  expensive to unpick.

### 6.3 Calendar

A month grid, `‹ September 2026 ›`, with an all-projects mode and a single-project mode.

- **Day cell** shows the date, a presence indicator per project (a coloured dot in the project's
  colour), and the day's cycle count.
- **One upload lights many cells.** Coverage comes from `transcript_day`, so a three-week import
  marks every day it actually contains events for — and leaves the quiet days between unmarked.
  Hovering a covered day names the transcript(s) covering it; a day covered by more than one shows
  the count.
- **Shading** encodes cycle count (a sequential ramp), so density reads at a glance. Legend included;
  colour is never the only signal — the count is printed.
- Days with **no upload** are visually distinct from days with an upload but zero cycles.
- Clicking a day opens that day's dashboard. Clicking a dot opens it filtered to that project.
- A year heat-strip above the grid gives 12-month context.
- Keyboard navigable (arrows move the focused day, Enter opens it); cells carry accessible labels
  (`21 September 2026, SMART:LGR, 24 cycles`).

### 6.4 Dashboards

Three scopes, one shared set of metric components:

1. **Day** — one project, one day. The closest analogue of the reference PDF. It pools every
   contributing transcript for that day (§3.4.1), and names them, so a day assembled from two imports
   is visibly that.
2. **Project** — one project, a date range. Per-day series for every headline metric, plus the
   range's pooled figures. This is the default landing scope for a project, since one multi-day import
   is more likely to raise "how did the fortnight go?" than a single-day question. Range figures are
   always accompanied by the count of **active days**, so a 30-day range with six working days is not
   read as a month of work.
3. **Portfolio** — all non-archived projects, a date range. Comparison and averages (§6.5).

Every dashboard carries the same date-range control (day / week / month / custom) and an export
(§6.6). Every figure is click-through to its underlying events.

### 6.5 Averages across projects

Both averaging modes are computed, because they answer different questions, and mixing them is the
usual way a dashboard like this misleads:

| Mode | Definition | Use |
|---|---|---|
| **Macro** (default) | Mean of each project's own value — every project counts once | "What does a typical project look like?" |
| **Pooled** | Recompute the metric over all cycles from all projects | "What happened across the estate?" |

For medians and percentiles, *pooled* recomputes from the combined cycle set — it never averages
medians. *Macro* averages the per-project medians and labels itself as doing so.

The portfolio view shows, per metric: each project's value, the average (mode-toggled), and each
project's **deviation** from it. A project more than 1 standard deviation from the mean is
highlighted, with `n` shown so a two-project average is not read as a law. Projects with fewer than
`min_cycles` (default 5) in range are excluded from the average and listed as excluded.

### 6.6 Export

- **PNG / PDF** of a dashboard, laid out like the reference report.
- **CSV** of the cycle table and of the per-day metric series.
- **JSON** of the full computed metric set for a scope — the contract an external report can build on.

---

## 7. Screens

| # | Screen | Route | Contents |
|---|---|---|---|
| 7.1 | Projects | `/` | Project cards: name, transcripts, days covered, last upload, cycles, median cycle, sparkline. New-project and upload actions. |
| 7.2 | Project | `/p/[slug]` | Header figures for the range, calendar for the project, per-day trend charts, transcript list. |
| 7.3 | Day dashboard | `/p/[slug]/d/[date]` | The reference layout: headline strip, at-a-glance table, cycle-time distribution, correlation panel, elapsed-day bar, interruptions, drift, audit gap, insights. |
| 7.4 | Cycle detail | `/p/[slug]/c/[id]` | Dispatch and close-out in full, the event timeline between them with per-step latency, tool-action markers, detected language per message, all derived fields. |
| 7.5 | Transcript detail | `/t/[id]` | Parse report; **days-covered table** (date, events, cycles, overlap status, superseding transcript if retired) with per-day links into the day dashboard and the ability to revisit an overlap decision; raw event table with filters (role, kind, day, contains); cycle-boundary override UI; re-parse; delete. |
| 7.6 | Calendar | `/calendar` | All-projects month grid, year strip, project filter. |
| 7.7 | Portfolio | `/portfolio` | Cross-project comparison and averages, macro/pooled toggle. |
| 7.8 | Upload | `/upload` | Drop zone, project selector, dry-run preview, parse report. |
| 7.9 | Project settings | `/p/[slug]/settings` | Role map, working language, timezone, answer threshold with the length-distribution plot, platform-error rules, insight rules. |

**Cycle-boundary override (7.5).** Low-confidence classifications, and any classification the user
disagrees with, can be corrected: an orchestrator message can be forced to `dispatch`, `closeout` or
`neither`. Overrides are stored against the event, survive re-parsing, and are listed on the parse
report so a dashboard built on manual corrections says so.

---

## 8. Data model

Documents, not tables. Keys are slash-separated; the store is Netlify Blobs on Netlify and a
`.data/` directory locally, behind one interface (§12).

```
projects/<slug>.json              the project record
raw/<slug>/<sha256>.md            the transcript as uploaded, kept for evidence
transcripts/<slug>/<sha256>.json  metadata, parse report, per-day contributions,
                                  boundary overrides
days/<slug>/<YYYY-MM-DD>.json     one day: a slice per contributing transcript,
                                  plus that day's computed metrics
uploads/<uploadId>/<nnnnn>        staged chunks, deleted once the import resolves
```

**Project** — slug (the identity), name, description, colour, working language, timezone, answer
threshold, minimum cycles for the portfolio average, role map, archived flag, timestamps.

**Transcript** — sha256 (the identity), filename, byte size, declared range and count, parsed event
count, first and last event, parser version, upload time; the parse report; `boundaryOverrides`
keyed by event sequence so a correction survives re-parsing; and one entry per covered day carrying
its overlap class, whether it contributes, and what superseded it.

**Day** — one **slice** per contributing transcript, and the metrics computed from the contributing
ones. A slice holds what the metrics need and nothing more:

```ts
{
  day, eventCount, firstEventAt, lastEventAt, englishRequests,
  fingerprints,          // truncated to 64 bits, for overlap detection (§3.4.1)
  cycles, turns, drifts, errors
}
```

Per-event rows are deliberately absent. The only things the metrics ever needed from the events were
the day's first and last timestamps and how many there were; everything else is already a cycle, a
turn, a drift or an error. A day keeps retired slices as well as contributing ones, so restoring a
superseded contribution is a recompute rather than a re-parse.

A day's metrics are derived, and are rebuilt whenever a transcript in that project-day is added,
retired, restored, deleted, or when a setting that affects derivation changes. Reading a day filters
to contributions that still count, which is what keeps a superseded overlap from being counted twice.
## 9. API

| Method | Route | Notes |
|---|---|---|
| `GET/POST` | `/api/projects` | List, create |
| `PUT` | `/api/uploads/:id?index=N` | Stage one chunk of a transcript |
| `POST` | `/api/uploads/:id` | Analyse (`dryRun`) or commit the staged file, with `dayResolutions` |
| `DELETE` | `/api/uploads/:id` | Discard staged chunks |
| `GET` | `/api/metrics?slug&from&to` | Full metric set plus insights for a scope |
| `GET` | `/api/cycles?slug&from&to` | Cycle table; `?format=csv` supported |
| `GET` | `/api/calendar?from&to[&slug]` | Day → coverage and cycle counts |

Transcripts are addressed by the SHA-256 of their bytes, and projects by slug; there are no opaque
ids. Every metric response carries `{ value, n, method }` rather than a bare number, so the UI can
render `—` for empty sets and footnote the method without guessing.

Uploads are chunked because a single request body is capped at 6 MB on the deployment target (§12),
and a multi-day export is routinely larger. The client stages the file in sub-cap pieces, then
analyses and commits by key, so the same path runs locally and in production.
## 10. Parsing pipeline

1. **Read** — decode UTF-8, strip BOM, normalise `\r\n` → `\n`.
2. **Scan** — line-wise, tracking fenced-code state; emit event headers and bodies.
3. **Normalise** — parse timestamps to UTC; assign each event its `day` in the project timezone;
   map roles to role classes; count `> [action]` markers; compute each event's `fingerprint`.
4. **Partition by day** — group events into days and compute per-day coverage. Everything downstream
   is day-aware from here on.
5. **Classify overlap** — match fingerprints against the project's existing events and derive the
   per-day overlap class (§3.4.1). On a dry run the pipeline stops here and returns the report.
6. **Detect language** — per `message` event, on code-stripped text.
7. **Resolve cycles** — score and alternate (§3.2); apply stored overrides. Cycle resolution runs over
   the **whole transcript in timestamp order**, not per day, so a dispatch before midnight pairs with
   its close-out after it; the resulting cycle is then assigned to the day it started.
8. **Classify operator turns** — threshold on `body_chars` (§5.6).
9. **Detect** — platform errors (§5.8), drifts and challenges (§5.9), audit gaps (§5.7).
10. **Persist** — events, `transcript_day` rows with their resolutions, cycles, turns, drifts, errors;
    retire superseded day contributions; then rebuild `daily_metric` for every affected day.
11. **Report** — return the parse report.

The pipeline is a pure function of `(file bytes, project settings, overrides)`, which makes it
directly testable and makes re-parse deterministic.

### 10.1 Edge cases

| Case | Handling |
|---|---|
| Event timestamps out of order | Sort by `ts_utc`, keep `seq` as the tiebreak; warn |
| Identical timestamps | Stable order by `seq` |
| Cycle spans midnight | Assigned wholly to the day of `started_at`; duration not split. The elapsed-day partition (§5.5) clips it, and says so |
| Transcript spans several days | The normal case (§3.4). Events bucketed per day; one `transcript_day` row per covered day |
| Transcript covers days with gaps | Only days with events are covered; the quiet days stay blank on the calendar |
| Re-export repeating earlier days | Detected by event fingerprint; resolved per day (§3.4.1). Default for a clean superset is to supersede, so figures do not double |
| Two transcripts, same day, disjoint | Both contribute; the day's cycles pool. Shown as a multi-transcript day on the calendar |
| Import crosses a DST boundary | Day boundaries follow the project timezone's local dates; the affected day is 23 or 25 hours and the elapsed-day window reflects that |
| Project timezone changed | Every transcript re-bucketed and all rollups rebuilt, behind a confirmation, because historical figures move |
| Import spans months or years | Supported; the calendar year-strip and range controls are the intended entry points rather than the month grid |
| Dispatch with no close-out | Open cycle: counted, excluded from duration statistics, flagged |
| Close-out with no dispatch | Warned, discarded from cycle statistics, listed in the parse report |
| Zero `[think]` events in a cycle | `minutes_per_step` undefined for that cycle; excluded from its median |
| No `User` events at all | All authorisations unrecorded; the audit-gap panel says so explicitly |
| Unknown role encountered | Mapped to `worker` by default; surfaced in the parse report for correction |
| Declared ≠ parsed message count | Warning with both numbers; parsed count is authoritative |
| Empty or header-less file | Parse fails cleanly with the reason; nothing persisted |
| Duplicate file | Rejected with a link to the existing transcript |

---

## 11. Non-functional

- **Performance** — measured, not estimated: a 25 MB / 36,720-event transcript parses in ~10 s and
  commits in ~13 s end to end. Dashboards read stored day aggregates, never the raw transcripts, so
  they are unaffected by import size. Evidence views re-parse on demand and are the only place where
  a very large transcript is slow to open.
- **Determinism** — identical input plus identical settings yields identical figures. No wall-clock
  or random input to any metric.
- **Accessibility** — WCAG 2.2 AA. Charts have accessible names and a table equivalent; colour is
  never the sole carrier of meaning; full keyboard navigation on the calendar.
- **Privacy** — transcripts may contain sensitive project detail. They are stored only in the
  configured document store, no external calls are made at runtime, and language detection runs
  in-process.
- **Observability** — parse failures are retained with the input hash and stack, viewable in-app.

### 11.1 Testing

- **Golden-file tests** — the supplied transcript is a fixture with its expected derived values
  asserted (24 cycles, 456 in-cycle reasoning steps, 1 operator answer, 12 drifts, 175.9 min operator
  wait). Any change to the pipeline that moves these numbers must move them deliberately.
- **Multi-day fixtures** — a synthetic transcript spanning 12 days with gaps, a midnight-crossing
  cycle, and a DST transition, asserting per-day cycle counts and that the midnight cycle appears on
  exactly one day.
- **Overlap fixtures** — the pair that matters most: a 7-day export and a cumulative 14-day export
  covering the same first week. Asserting that after both imports the overlapping days report the
  **same figures as after the first import alone** is the regression test that protects every number
  on the dashboard.
- **Property tests** — elapsed-day bands sum to their day's window; cycles never overlap; a cycle
  belongs to exactly one day; percentiles are monotonic in the requested quantile; total cycles over a
  range equals the sum of its days.
- **Fixtures for every edge case** in §10.1.

---

## 12. Deployment

The same code runs in both environments; only the storage driver differs, and it is selected at
runtime.

| | Local | Netlify |
|---|---|---|
| Documents | `.data/` on disk | Netlify Blobs, strong consistency |
| Install | nothing beyond `npm install` | nothing; Blobs needs no provisioning |
| Selected by | default | `NETLIFY=true` in the build and functions |

`STORAGE_DRIVER=filesystem\|netlify-blobs` forces one, and `STORAGE_DIR` moves the local directory.

**Platform limits this design works within.** A Netlify function accepts at most a 6 MB request body
and runs for at most 60 seconds, neither configurable.

- **Body cap** — uploads are chunked (§9), so file size is not bounded by the request limit.
- **Time cap** — measured at 25 MB / 36,720 events: ~10 s to parse and ~13 s to commit end to end,
  against the 60 s limit. The margin exists because an import writes about thirty documents rather
  than tens of thousands of rows; a per-event schema would not fit.
- **Free tier** — Netlify Blobs is included on the free plan. No database is provisioned, and there
  is no external service to configure.

Strong consistency is required on the Blobs store, not optional: an import writes a day document and
the dashboard reads it immediately afterwards, and eventual consistency would show the previous day's
figures straight after an upload.

---
## 13. Out of scope for v1

Authentication and multi-user access; live harness integration; editing transcript content;
alerting or scheduled reports; comparison against external baselines (the reference's "180 cycles
across seven weeks" band — v1 computes baselines only from uploaded data); LLM-generated narrative.

## 14. Open questions

1. **Cycle definition.** The reference counts 31 Workbench cycles against 24 dispatches. This spec
   defines a cycle as one dispatch/close-out pair, which reproduces 24 on the sample. If cycles are
   meant to include sub-tasks within a dispatch, the rule needs widening — confirm which is intended.
2. **Baselines.** Should the portfolio average serve as the baseline band on project dashboards, or
   should fixed baselines be configurable per project?
3. **Multiple products per project.** The reference compares two products in one account. Is that two
   projects here, or one project with a `product` dimension on each transcript?
4. **Retention.** Raw transcripts are kept so evidence views can rebuild event detail, and they are
   the bulk of the stored bytes (25 MB of transcript against ~3 MB of aggregates). Dropping them
   after a period would shrink storage and lose only the evidence views, since the figures are
   already computed — is that trade worth offering?
5. **Overlap default.** A clean superset defaults to *supersede*, and a subset (a later export that
   truncates earlier detail) defaults to *skip*, keeping the fuller record. Both are reversible from
   the transcript screen. Confirm this matches how your exports behave.
