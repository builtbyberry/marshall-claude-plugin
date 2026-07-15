---
name: change-review
description: "Run a multi-lens change review over a release component's diff and record the findings in the shared Marshall store (not a local review-state file). Loads the configured change lenses, runs them against the component's diff, and writes findings (kind: change) via record_finding; supports defer/accept/fix/re-open via resolve_finding. Use when the user says /marshall:change-review, review this component, change review, or attaches a component diff/PR/branch for an Marshall-tracked release."
---

# Change Review (Marshall)

Run the change lenses over a **component's diff** and record what they find **in
the shared Marshall store** via the findings tools, instead of a repo-local
`review-state.json`. The store is the same across machines, people, and agents —
so a change review one person runs is visible to everyone working the release.

This is the Marshall-store port of `multi-expert-change-review`: same lens mechanics
and verdict rubric, but findings are durable store rows (kind `change`) rather
than a local file. It is the change-review counterpart to `/marshall:release-readiness`
(kind `readiness`) — readiness is release-wide; change review is **component-scoped**.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — read the release: its components (for `component_id`
  scoping), its **existing findings**, and its **lens selection**
  (`project.reviews.change.lenses`). This is the state — there is no local file
  to read.
- `mcp__plugin_marshall_marshall__lenses_get` — resolve the selected lens **definitions**
  (`{ slugs: [...] }` → each lens's frontmatter + body). The store is the
  catalog; there is **no `~/.claude/skills/_lenses` fallback**. Any slug it can't
  resolve comes back as `lens_not_found` — surface it and stop.
- `mcp__plugin_marshall_marshall__record_finding` — record a new change finding
  (`{ release, kind: "change", ref, severity, summary, rationale?, component_id }`).
- `mcp__plugin_marshall_marshall__resolve_finding` — transition a finding
  (`{ finding, status, rationale? }`): `deferred | accepted | fixed | open`.

(If the MCP server isn't connected, stop and say so — there is no local fallback
for store findings *or* lenses.)

## Config

**Lens selection and definitions both come from the Marshall store — not local files.**

- **Selection** — `release_get { release }` returns `project.reviews.change.lenses`,
  the array of lens slugs for this release. If it is empty, no change lenses are
  selected: **stop and say so** (set them with `set_release_lenses`), never review
  with an empty lens set.
- **Definitions** — `lenses_get { slugs }` returns each lens (frontmatter + body).
  The store is authoritative; there is no `~/.claude/skills/_lenses/<slug>.md`
  fallback. Any unresolved slug fails loud (`lens_not_found`) — surface it and
  stop, never silently skip.

`.claude/release-config.json` is still read for non-lens fields only —
`default_branch` (the diff base). Lifting the rest of release-config into the
store is roadmapped separately.

## The store is the state (no local file)

Unlike the non-Marshall change-review skill, this one keeps **no** `review-state.json`.
Open/deferred/accepted/fixed findings are read straight from the release document
(`release_get` → `findings`, filtered to `kind: "change"`). Never create or write
a local findings file here.

### Status lifecycle (store-defined)

The store enforces the lifecycle; this skill only ever asks for a legal move:

- `open → deferred | accepted | fixed`
- `deferred → accepted | fixed | open` (re-open)
- `accepted` and `fixed` are **terminal**

There is **no `fixed-verified` status** in the store — the non-Marshall skill has one;
this port drops it. `fixed` is terminal, so `verify` mode re-examines and
**reports**, but never transitions a finding. An illegal move (e.g. `fixed → open`)
returns `invalid_finding_transition` from the store — surface it verbatim; never
work around it.

## Scope: one component's diff

Change review is scoped to a single component, so every finding it records carries
that component's `component_id`. Resolve the component before reviewing.

### Resolving the component (fail-loud)

Resolve from three signals:

1. an explicit tracker ref the user named (`/marshall:change-review #10`),
2. the active Marshall claim on a component,
3. the current branch name `<type>/<release>-<ref>-<slug>`.

The priority order (ref → claim → branch) applies **only to fill absent signals**.
**Any disagreement between two present signals is ambiguity — STOP and ask.** For
example, a claim on `#10` while the branch encodes `#11` means the diff under
review and the finding's `component_id` would refer to different components; do not
let the higher-priority signal silently win. If the component cannot be pinned to
exactly one, **stop and ask** — never default to "the release" or guess. The store
validates that `component_id` is a *member* of the release but not that it is the
*correct* one, so a wrong-but-valid id mis-scopes silently; this step is what makes
mis-scope fail loud instead.

### Gathering the diff (fresh base)

```bash
git fetch origin <default-branch>                       # avoid a stale base
BASE=$(git merge-base origin/<default-branch> HEAD)
git diff "$BASE"..HEAD --name-only                      # changed files
git diff "$BASE"..HEAD                                  # the change under review
```

Fetch before computing the merge-base: a stale local ref resolves to an old commit
and pulls already-merged work into the diff, producing findings about code that is
not part of this component. Use `default_branch` from `.claude/release-config.json`.

## Review process

### Step 1 — Resolve the release + component, load the store state

Resolve the release version (ask if ambiguous — don't guess) and the component (see
**Resolving the component** above). Then `mcp__plugin_marshall_marshall__release_get { release }` to load:
- the components (ids, titles, refs) — to confirm the resolved `component_id`,
- the **existing findings**, filtered to `kind: "change"` — so this run reconciles
  against them (Step 6), and
- the **lens selection** at `project.reviews.change.lenses` — the slugs to run (Step 3).

### Step 2 — Gather the component diff

Compute the diff as in **Gathering the diff** above. Read `CHANGELOG.md` and any
files the lenses care about. Know what changed before forming a view.

### Step 3 — Resolve lenses from the store

1. From the Step-1 `release_get`, take `project.reviews.change.lenses`. If empty,
   **stop**: no change lenses are selected for this release (set them with
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
- the component **diff** and changed-file list (Step 2), and
- the instruction below.

Each subagent:
- evaluates the lens `## Purpose` against the diff; if its "skip when" condition
  fires, returns `skipped (not applicable to this diff)`.
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
before recording, reconcile each fresh finding against the existing `kind: "change"`
findings loaded in Step 1:

- **Semantic match to an existing `open` or `deferred` change finding** — match on
  `(component_id + normalized summary)`, **never on the `ref`** (refs renumber each
  run). When a match is ambiguous, **bias toward "already-tracked" and do not
  record**: a missed-as-new finding still prints below and is recoverable, but a
  duplicate durable row is the failure mode this step exists to prevent. Carry the
  existing status and id.
- **Match to an `accepted` or `fixed` finding** → suppress (already resolved),
  unless the issue has genuinely regressed — then record a new one and say so.
- **No match** → record it: `record_finding { release, kind: "change", ref,
  severity, summary, rationale?, component_id }`. Always pass the resolved
  `component_id`.

Always report `recorded N / already-tracked M` so any duplicate is immediately
visible. Recording twice in the same review run is the failure mode this step
exists to prevent.

> **Concurrent reviews:** reconcile is read-then-write with no findings lock, and
> the component claim does not lock the review *action* — two reviewers running on
> the same component simultaneously can each record a row. This is an accepted
> residual: the `recorded / already-tracked` count surfaces it and `resolve_finding`
> cleanup is cheap.

## Severity gate

- **high:** fix before release.
- **medium:** fix now unless explicitly deferred with an owner.
- **low:** may defer if documented.

## Verdict and release impact rubric

**Release impact**
- **blocker:** any unmitigated `high`, inability to roll back safely, or missing
  safety-relevant control — unless accepted risk and owner are explicitly recorded
  (as an `accepted` finding).
- **non-blocker:** no open `high`, or each `high` has a recorded mitigation path.

**Consolidated verdict**
- **changes-required:** one or more `high` without documented mitigation, or a
  fundamental design/API/changelog mismatch.
- **approve-with-followups:** `medium`/`low` remain (or deferred `medium` with a
  named owner), no blocker-level gap.
- **approve:** no material findings; open gaps minor or absent; tradeoffs recorded.

## Output format

### Verdict (always first)

## `<verdict>` · `<release impact>` · component `<ref>`
- `N high` · `N medium` · `N low` · `N open gaps`
- **Recorded:** N new change findings written to the store · M already tracked
  (or `none — all already tracked`).
- **Passes:** only areas at risk given this change that came back clean.
- **Carry-forward:** `id` deferred · `id` accepted — omit if the store has none.

---

### Findings (one H3 per finding, high → medium → low)

### F1 · `<severity>` · `<Primary lens>` *(+ Secondary lens via synthesis)*
- **Where:** [`path:line`](path) or `CHANGELOG.md` / migration / config
- **Issue:** one sentence on what is wrong or risky.
- **Fix:** one sentence concrete fix, test, doc change, or escalation.
- **Store:** `recorded <id>` (new) or `already tracked <id> (<status>)`.

Separate findings with `---`. Omit the synthesis parenthetical if single-lens. Use
`None — informational` for Fix only on `low` findings where no action is warranted.

### Open gaps (one H3 per gap)

### OG1 · `<Lens>`
One sentence on what cannot be verified and what would confirm or refute it.

### Tradeoffs (inline)

One line per tradeoff: **Chosen** — **Rejected** — **Rationale** — **Recorded in**.
If none: `Tradeoffs: none identified.`

If no fresh findings, write `No new findings.` after the verdict and still show any
open/deferred store findings.

## Compressed pass (trivial changes)

For a trivial diff, run the lenses **inline** (skip the per-lens fan-out — the
parallelism isn't worth it) and emit the verdict section followed by one sentence
per lens. Expand any lens that surfaces non-trivial risk to a full finding.

## Post-review actions

These map 1:1 onto `resolve_finding`. Resolve the `F#` the user names to its store
`id` via the most recent review output or `release_get`.

### Defer

`"defer F3"` or `"defer F3 — fix lands next sprint"`:
`resolve_finding { finding: <id>, status: "deferred", rationale }`.

### Accept

`"accept F2 — documented in maintenance.md instead"`:
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

`"show change findings"` / `"what's deferred"`: `release_get { release }`, filter
`findings` to `kind: "change"`, group by status (open / deferred / accepted /
fixed) with each finding's `id`, `ref`, `severity`, and `summary`.

## Guardrails

- Record only `kind: "change"` findings here. Readiness findings are
  `/marshall:release-readiness`'s job (`kind: "readiness"`); design findings are the
  design gate's (`kind: "design"`).
- Scope to one component: resolve it fail-loud, and pass its `component_id` on every
  recorded finding. A signal conflict is a stop-and-ask, not a guess.
- Reconcile before recording — never write a duplicate of a finding the store
  already holds open. Filter every `release_get` read to `kind: "change"`.
- The store enforces the lifecycle. Ask only for legal transitions; surface
  `invalid_finding_transition` verbatim rather than working around it. There is no
  `fixed-verified`.
- The store is the source of truth — do not create a local change-review state file.
