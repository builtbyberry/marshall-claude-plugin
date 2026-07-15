---
name: release-readiness
description: "Run a release readiness review and record its findings in the shared Marshall store (not a local review-state file). Loads the configured readiness lenses, runs them against the release, and writes findings via record_finding; supports defer/accept/fix/re-open via resolve_finding. Use when the user says /marshall:release-readiness, is this release ready, readiness review, pre-release checklist, or asks about migration safety, tenant safety, or deploy readiness for an Marshall-tracked release."
---

# Release Readiness (Marshall)

Run the readiness lenses for a release and record what they find **in the shared
Marshall store** via the findings tools, instead of a repo-local `review-state.json` /
`release-state.json`. The store is the same across machines, people, and agents —
so a readiness review one person runs is visible to everyone working the release.

This is the Marshall-store port of `swarm-release-readiness` / `release-readiness`:
same lens mechanics and verdict rubric, but findings are durable store rows
(kind `readiness`) rather than a local file.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — read the release: its components, its **existing
  findings**, and its **lens selection** (`project.reviews.readiness.lenses`).
  This is the state — there is no local file to read.
- `mcp__plugin_marshall_marshall__lenses_get` — resolve the selected lens **definitions**
  (`{ slugs: [...] }` → each lens's frontmatter + body). The store is the
  catalog; there is **no `~/.claude/skills/_lenses` fallback**. Any slug it can't
  resolve comes back as `lens_not_found` — surface it and stop.
- `mcp__plugin_marshall_marshall__record_finding` — record a new readiness finding
  (`{ release, kind: "readiness", ref, severity, summary, rationale?, component_id? }`).
- `mcp__plugin_marshall_marshall__resolve_finding` — transition a finding
  (`{ finding, status, rationale? }`): `deferred | accepted | fixed | open`.

(If the MCP server isn't connected, stop and say so — there is no local fallback
for store findings *or* lenses.)

## Config

**Lens selection and definitions both come from the Marshall store — not local files.**

- **Selection** — `release_get { release }` returns `project.reviews.readiness.lenses`,
  the array of lens slugs for this release. If it is empty, no readiness lenses are
  selected: **stop and say so** (set them with `set_release_lenses`), never review
  with an empty lens set.
- **Definitions** — `lenses_get { slugs }` returns each lens (frontmatter + body).
  The store is authoritative; there is no `~/.claude/skills/_lenses/<slug>.md`
  fallback. Any unresolved slug fails loud (`lens_not_found`) — surface it and
  stop, never silently skip.

`.claude/release-config.json` is still read for non-lens fields only — `wrap.mode`
(informational; verdict language matches deploy vs tag). Lifting the rest of
release-config into the store is roadmapped separately.

## The store is the state (no local file)

Unlike the non-Marshall readiness skills, this one keeps **no** `release-state.json`.
Open/deferred/accepted/fixed findings are read straight from the release document
(`release_get` → `findings`, filtered to `kind: "readiness"`). Never create or
write a local findings file here.

### Status lifecycle (store-defined)

The store enforces the lifecycle; this skill only ever asks for a legal move:

- `open → deferred | accepted | fixed`
- `deferred → accepted | fixed | open` (re-open)
- `accepted` and `fixed` are **terminal**

There is no `fixed-verified` status in the store — `fixed` is terminal. `verify`
mode therefore re-examines and **reports**, but does not transition a finding.
An illegal move (e.g. `fixed → open`) returns `invalid_finding_transition` from
the store — surface it verbatim; never work around it.

## Review process

### Step 1 — Resolve the release + load the store state

Resolve the release version (ask if ambiguous — don't guess). Then
`mcp__plugin_marshall_marshall__release_get { release }` to load:
- the components (ids, titles, refs) — for `component_id` scoping,
- the **existing findings** — so this run reconciles against them (Step 6), and
- the **lens selection** at `project.reviews.readiness.lenses` — the slugs to run (Step 3).

### Step 2 — Gather release context

```bash
git log <release-base>..HEAD --oneline      # commits on the release branch
git diff <release-base>..HEAD --name-only   # changed files
```

Read `CHANGELOG.md` (the "Unreleased"/active section) and any migration/config
files the lenses care about. Know what changed before forming a view.

### Step 3 — Resolve lenses from the store

1. From the Step-1 `release_get`, take `project.reviews.readiness.lenses`. If empty,
   **stop**: no readiness lenses are selected for this release (set them with
   `set_release_lenses`). Never review with an empty lens set.
2. `mcp__plugin_marshall_marshall__lenses_get { slugs: <those slugs> }` to fetch the definitions. Any
   `lens_not_found` → surface it verbatim and stop. There is no `~/.claude`
   fallback and no silent skip.

### Step 4 — Run lenses: one subagent per lens, in parallel

Fan out **one subagent per resolved lens, concurrently** — dispatch them in a
single message (one Task/Agent call per lens) so they run in parallel, then
aggregate. Give each subagent:
- the lens **`name`, `body`, and `related`** (from `lenses_get`) — `name` for
  attributing its findings, `body` to run the lens, `related` for synthesis,
- the release **context** (Step 2: commit log, changed files, CHANGELOG, relevant
  migration/config files), and
- the instruction below.

Each subagent:
- evaluates the lens `## Purpose` against the release context; if its "skip when"
  condition fires, returns `skipped (not applicable)`.
- otherwise walks `## Questions to ask`, scans `## Anti-patterns to flag`, anchors
  against `## Examples` and `## Severity calibration`, and uses `## How findings
  from this lens sound` to shape voice.
- **returns** its candidate findings as structured data (severity, where, issue,
  fix), attributed to the lens by its frontmatter `name`. It does **not** call
  `record_finding` — recording is centralized in the parent (Step 6) so
  reconciliation stays idempotent.

Aggregate every subagent's findings before continuing.

### Step 5 — Cross-lens synthesis

Do one integration pass using each lens's `related:` array. When a finding was
surfaced or sharpened by another lens, note it: `*(+ <lens-name> via synthesis)*`.

### Step 6 — Reconcile against the store, then record (idempotent re-run)

`record_finding` is **not idempotent** — calling it again writes another row. So
before recording, reconcile each fresh finding against the existing store
findings loaded in Step 1:

- **Semantic match to an existing `open` or `deferred` readiness finding**
  (same underlying issue — match on summary/component, not the `ref`, which
  renumbers each run) → **do not record again**. Surface it as already-tracked,
  carrying its existing status and id.
- **Match to an `accepted` or `fixed` finding** → suppress (already resolved),
  unless the issue has genuinely regressed — then record a new one and say so.
- **No match** → record it: `record_finding { release, kind: "readiness", ref,
  severity, summary, rationale?, component_id? }`. Use `component_id` only when
  the finding is about a specific component of this release.

Report which findings were newly recorded vs. already tracked. Recording twice in
the same review run is the failure mode this step exists to prevent.

## Severity gate

- **high:** fix before shipping.
- **medium:** fix now unless explicitly deferred with an owner.
- **low:** may defer if documented.

## Verdict and release impact rubric

**Release impact**
- **blocker:** any unmitigated `high`, inability to roll back safely, broken CI,
  or an inverted conservative security/deploy default — unless accepted risk and
  owner are explicitly recorded (as an `accepted` finding).
- **non-blocker:** no open `high`, or each `high` has a recorded mitigation path.

**Consolidated verdict**
- **hold:** one or more `high` without documented mitigation, CI failing, or a
  fundamental migration/deploy mismatch.
- **ship-with-followups:** `medium`/`low` remain (or deferred `medium` with a
  named owner), no blocker-level gap.
- **ship:** no material findings; open gaps minor or absent; tradeoffs recorded.

## Output format

### Verdict (always first)

## `<verdict>` · `<release impact>`
- `N high` · `N medium` · `N low` · `N open gaps`
- **Recorded:** N new readiness findings written to the store (or `none — all already tracked`).
- **Passes:** only areas at risk given the changes that came back clean.
- **Carry-forward:** `id` deferred · `id` accepted — omit if the store has none.

---

### Findings (one H3 per finding, high → medium → low)

### F1 · `<severity>` · `<Primary lens>` *(+ Secondary lens via synthesis)*
- **Where:** [`path:line`](path) or `CHANGELOG.md` / migration / config
- **Issue:** one sentence on what is wrong or risky.
- **Fix:** one sentence concrete fix.
- **Store:** `recorded <id>` (new) or `already tracked <id> (<status>)`.

Separate findings with `---`. Omit the synthesis parenthetical if single-lens.

### Open gaps (one H3 per gap)

### OG1 · `<Lens>`
One sentence on what cannot be verified and what would confirm or refute it.

### Tradeoffs (inline)

One line per tradeoff: **Chosen** — **Rejected** — **Rationale** — **Recorded in**.
If none: `Tradeoffs: none identified.`

If no fresh findings, write `No new findings.` after the verdict and still show
any open/deferred store findings.

## Post-review actions

These map 1:1 onto `resolve_finding`. Resolve the `F#` the user names to its store
`id` via the most recent review output or `release_get`.

### Defer

`"defer F3"` or `"defer F3 — migration ships in the next release"`:
`resolve_finding { finding: <id>, status: "deferred", rationale }`.

### Accept

`"accept F2 — documented in runbook instead"`:
`resolve_finding { finding: <id>, status: "accepted", rationale }`.
Acceptance means no fix is planned; use defer when a fix is intended but not now.

### Mark fixed

`"mark F1 as fixed"` (optionally with a rationale):
`resolve_finding { finding: <id>, status: "fixed", rationale? }`. Terminal.

### Re-open

`"re-open F3"` (only from `deferred`):
`resolve_finding { finding: <id>, status: "open" }`. From a terminal status the
store returns `invalid_finding_transition` — surface it; don't force it.

### Verify

`"verify F1 F2"`: re-examine the referenced findings against the current code and
report `✓ resolved` / `✗ unresolved`. The store has no verified state — if a
`fixed` finding is confirmed resolved, leave it `fixed` and say so; if a still-open
finding is confirmed resolved, offer to `mark fixed`.

### List

`"show readiness findings"` / `"what's deferred"`: `release_get { release }`,
filter `findings` to `kind: "readiness"`, group by status (open / deferred /
accepted / fixed) with each finding's `id`, `ref`, `severity`, and `summary`.

## Guardrails

- Record only `kind: "readiness"` findings here. Change-review findings are
  `/marshall:change-review`'s job (`kind: "change"`).
- Reconcile before recording — never write a duplicate of a finding the store
  already holds open.
- The store enforces the lifecycle. Ask only for legal transitions; surface
  `invalid_finding_transition` verbatim rather than working around it.
- The store is the source of truth — do not create a local readiness state file.
