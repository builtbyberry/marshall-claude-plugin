---
name: release-wrap
description: "Wrap a release against the Marshall store: run change-review + readiness (findings land in the store), fill the CHANGELOG, gate on unresolved high findings, and hand off ready-for-deploy. Use when the user says /release-wrap, finish the release, we're ready to close out <release>, or all components are merged, what now. Deploy-mode only."
---

# Release Wrap (Marshall)

Drive the wrap of a release **against the shared Marshall store**, in order: confirm
every component is merged → change-review each component → fill the CHANGELOG →
readiness review → honor the high-finding gate → hand off **ready-for-deploy**.
The store is the same across machines, people, and agents, so the wrap one person
runs is visible to everyone working the release.

This is the Marshall-store port of the file-based `release-wrap`: same wrap ordering,
but **the store is the state**. Review progress is read from the release's
findings (`mcp__plugin_marshall_marshall__record_finding` / `mcp__plugin_marshall_marshall__resolve_finding`), not a local
`review-state.json` / `release-state.json`. This skill *composes* the review
skills — it does not duplicate their lens logic.

This port is **deploy-mode only** (`wrap.mode == "deploy"`). The final state is
**ready-for-deploy**, handed to `/marshall:release-deploy` — there is no tag step and
no UPGRADING.md (those belong to the tag-mode file-based wrap).

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — read the release: every component with its
  server-derived work-state (`open | in_progress | proposed | merged`), the
  **existing findings** (`kind: change` and `kind: readiness`), and the deploy
  progression. This is the state — there is no local wrap file to read. When all
  components are `merged`, the release sits in the **`wrapping`** derived phase;
  that is the precondition for this skill.
- `mcp__plugin_marshall_marshall__release_status` — the live coordination picture: which components are
  still held, and which have **drifted** (a hold that went quiet and silently
  reopened). Use it to catch a component that looks done but isn't truly merged.
- `mcp__plugin_marshall_marshall__release_changelog` — emit the release's CHANGELOG section
  **from store data**, grouped Added / Changed / Fixed under the release theme.
  Read-only. This is what Step 2 writes.
- `mcp__plugin_marshall_marshall__record_findings` / `mcp__plugin_marshall_marshall__resolve_findings`
  (and their singular siblings) — driven by the composed review skills, not called
  directly here. The wrap **reads** the findings they produce to drive the gate.
- `mcp__plugin_marshall_marshall__set_component_state` — only the composed `/marshall:release-topic` flow
  moves components to `merged`. This skill does not advance work-state; it reads it.

(If the MCP server isn't connected, stop and say so — there is no local fallback
for the wrap state, the findings, *or* the lenses.)

## Config

`.claude/release-config.json` is still read for non-lens fields only:

- `wrap.mode` — **must be `deploy`**. If it is `tag` (or absent), this Marshall wrap
  refuses and points at the file-based tag-mode `release-wrap`. Lens *selection*
  lives in the store (`project.reviews.*.lenses`), not here.
- `wrap.changelog_path` — the CHANGELOG to fill.
- `default_branch` — the diff base the composed reviews use.

Note `wrap.include_upgrading_md` and `tag.*` are **not** consulted: deploy mode
writes no UPGRADING block and cuts no tag.

## The store is the state (no local file)

Unlike the file-based wrap, this one keeps **no** `review-state.json`,
`release-state.json`, or `deploy-state.json`. Which phase the wrap is in is
derived every time from the store:

- **components** — `release_get`, all `merged`? (else: components still in flight).
- **change findings** — any `kind: change` finding still `open`? (phase 2 incomplete).
- **CHANGELOG** — does `<wrap.changelog_path>` still hold the placeholder for this
  release? (phase 3 not done).
- **readiness findings** — any `kind: readiness` finding still `open`? (phase 4 incomplete).
- **high gate** — any `high`-severity finding (either kind) `open` *or* `deferred`?
  (not ready-for-deploy).

The skill is fully resumable: invoked mid-wrap (a new chat, a later day), re-read
the store and continue from the first unsatisfied precondition. Never trust prior
conversation memory of "where we were" — re-read the store.

## Procedure

Announce which step the skill is entering and why; the user can interrupt at any
step boundary.

### Step 0 — Confirm the release is wrappable

1. Resolve the release version (ask if ambiguous — don't guess).
2. `mcp__plugin_marshall_marshall__release_get { release }`. Confirm **every component's state is
   `merged`**. If any is `open | in_progress | proposed`, **stop**: list the
   unfinished components and tell the user to land them first (via
   `/marshall:release-topic` → merge → `set_component_state merged`).
3. `mcp__plugin_marshall_marshall__release_status { release }` to catch **drift** — a hold that went
   quiet and reopened a component that looks done. A drifted component is not
   truly merged; resolve it before wrapping.
4. Confirm `wrap.mode == "deploy"`. If not, refuse and point at the tag-mode wrap.

### Step 1 — Change review, per component

For each component in the release, compose **`/marshall:change-review`** against that
component's diff. It records `kind: change` findings (scoped with `component_id`)
in the store via `record_finding`, reconciling against what's already there.

- Run them one component at a time (or dispatch in parallel if the user wants),
  and let each review record its own findings — this skill does not record.
- After the pass, `release_get` and walk the user through every `open`
  `kind: change` finding. For each, drive a resolution **through the review
  skill's modes** (which call `resolve_finding`): **fix** (make the change, then
  mark fixed), **defer** (with rationale), or **accept** (no fix planned).
- A `high` change finding left `open` or `deferred` will block Step 4's gate —
  surface that now so the user resolves it deliberately, not at the gate.

### Step 2 — CHANGELOG wrap

Mechanics mirror the file-based wrap, minus tag-mode extras:

1. **Ask the store for the section — don't hand-assemble it.**
   `mcp__plugin_marshall_marshall__release_changelog { release }` returns the whole
   section already grouped into `### Added` / `### Changed` / `### Fixed` by each
   component's `branch_type`, under the release theme, in the house format.
   Generate-at-wrap is the point: the wrap writes the CHANGELOG in **one commit**,
   which is why component PRs no longer edit it and no longer conflict on it.
   Do not walk the components yourself to rebuild what the store already emits.
2. Open `<wrap.changelog_path>`, replace `## <release> - unreleased` (or the
   `_To be filled in during release wrap-up._` placeholder) with the generated
   section, and stamp the heading `## <release> - <today's date YYYY-MM-DD>`.
   Then **edit the generated prose** — the store knows every component's title and
   type, not the story of each change. Sharpen bullets from the merged PRs: named
   feature in **bold**, behavior + rationale in plain prose. Add a `### Removed`
   group by hand if the release needs one; the generator emits only
   Added/Changed/Fixed. Never *drop* a generated bullet — a component that shipped
   belongs in the log even if its bullet needs rewriting.
3. **No UPGRADING.md and no tag** — `wrap.mode == "deploy"`. Deploy notes live in
   the release PR body / in-app changelog, not an UPGRADING block.
4. Commit `docs(changelog): fill in <release> release wrap-up`.

### Step 3 — Readiness review

Compose **`/marshall:release-readiness`**. It runs the readiness lenses against the
release and records `kind: readiness` findings via `record_finding`, reconciling
against the store.

- After it returns, `release_get` and walk every `open` `kind: readiness` finding
  with the user, driving each to **fix / defer / accept** through the readiness
  skill's modes (which call `resolve_finding`).
- If readiness surfaces anything larger than a small fix, **stop** and tell the
  user — it likely needs to go back through change-review on a component, not a
  patch at wrap time.

### Step 4 — Honor the deploy-readiness gate

Re-read the store (`release_get`). The release is **not ready-for-deploy** while
**any `high`-severity finding — `kind: change` or `kind: readiness` — is `open`
or `deferred`.** This mirrors the server-side gate that blocks the actual deploy:
a deferred high is still an unmitigated high.

- If any high is `open`/`deferred`: list them (id, ref, kind, summary, status) and
  **refuse to proceed**. Each must be resolved to a terminal status — `fixed`
  (addressed) or `accepted` (explicit, owned risk acceptance) — via the composing
  skill's mode (`resolve_finding`). Re-check after each resolution.
- `medium`/`low` findings do **not** block; surface any still open/deferred so the
  user ships with eyes open.

### Step 5 — Mark ready-for-deploy

There is **no explicit store "ready" flag.** Ready-for-deploy is a *derived
precondition*, the conjunction of:

1. every component `merged` (Step 0),
2. CHANGELOG entry filled for this release (Step 2),
3. no `high` finding `open` or `deferred` (Step 4 gate clear).

When all three hold, declare the release **ready-for-deploy** and hand off to
**`/marshall:release-deploy`** — surface the command and a one-line summary (merge the
release PR into `<default_branch>`, watch deploy, smoke-check, monitor). State
explicitly that the deploy skill **re-checks these same preconditions** against
the store before it merges, so nothing is taken on trust across the handoff.

Do not merge or deploy automatically. The user invokes `/marshall:release-deploy` when
ready.

## Guardrails

- **Deploy mode only.** If `wrap.mode != "deploy"`, refuse and point at the
  file-based tag-mode `release-wrap`. Never tag and never write UPGRADING.md here.
- **The store is the source of truth** — derive every phase from `release_get`,
  not from conversation memory. Do not create a local wrap/review/readiness/deploy
  state file.
- **The CHANGELOG section is generated, then edited — never hand-assembled from
  scratch.** `release_changelog` emits the grouped section from store data; the
  wrap's job is to sharpen the prose and stamp the date, in one commit. Rebuilding
  it by walking components by hand is how the log drifts from what actually shipped.
- **Compose, don't duplicate.** This skill records no findings itself; change
  findings are `/marshall:change-review`'s job (`kind: change`), readiness findings are
  `/marshall:release-readiness`'s (`kind: readiness`). It only *reads* findings to drive
  the gate and resolutions.
- **The high gate is hard.** An `open` *or* `deferred` high blocks ready-for-deploy
  — a deferred high is still unmitigated. Only `fixed` / `accepted` clear it.
  Refuse to declare ready-for-deploy while any high is unresolved; never work
  around the gate.
- **All components merged is a precondition, not a goal to force.** If a component
  isn't `merged` (or has drifted per `release_status`), stop and send the user back
  to land it — don't wrap a half-merged release.
- **Ready-for-deploy is derived, not stored.** Never invent a store flag for it;
  state it as the precondition `/marshall:release-deploy` re-checks.
- The store enforces the finding lifecycle. Resolutions go through the composing
  skills' modes; surface `invalid_finding_transition` verbatim rather than working
  around it.
