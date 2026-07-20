---
name: release-plan
description: "Plan a release straight into the shared Marshall store: run the structured planning conversation (theme → component sweep → deploy-safety → out-of-scope) and write each confirmed component via component_create — no GitHub issues, no release-plan.json. Use when the user says /marshall:release-plan, plan v<X.Y.Z>, plan the next release, scope <release>, or add a component to <release>."
---

# Release Plan (Marshall)

Turn a release theme into a fully-scoped set of components **in the shared Marshall
store**. This is the marquee planning skill: it runs the structured planning
conversation and writes each confirmed component **straight to the store** via
`component_create`. It is **pure-store** — it files **no** GitHub issues and
writes **no** `release-plan.json`. The store is the single source of truth, so
the moment a component is confirmed it is live on the release-detail screen and
graphable by `/marshall:release-graph`.

This is the Marshall-native counterpart to the GitHub-seeded `/release-plan` (which
files milestone issues and writes a local state file). That one stays for repos
that want GitHub-tracked issues; this one is for releases that live in Marshall
end-to-end. The conversation and the strict component shape are identical — the
**only** difference is the write target: `component_create` instead of
`gh issue create` + a JSON file.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — confirm the release is seeded and read its
  `project_type` (drives the sweep categories) + existing components (so we
  don't duplicate in `add` mode).
- `mcp__plugin_marshall_marshall__component_create` — file one confirmed component (the
  **Confirmation loop** carries the call block). `source` defaults to `native` for store-born components —
  don't override it. Add `project` only to disambiguate the same version across projects.
- `mcp__plugin_marshall_marshall__component_update` — amend a component that is
  **already filed**, by its `component` id (ULID); `source` is identity and cannot
  change. This is the fix for a typo'd title or a revised deploy-safety answer — **not**
  a second `component_create` (see **Amending a filed component** below).

If the MCP server isn't connected, **stop and say so** — the store is the only
place the plan can land; do not fall back to filing GitHub issues or writing a
local file. That would defeat the pure-store path.

There is **no** store-side "create release" tool by design. If the release isn't
seeded yet, the fix is `/marshall:release-init` (or `srm:import-release` for a
GitHub-tracked milestone) — not a write from here.

## Invocation

- `/marshall:release-plan 0.5.0`
- `/marshall:release-plan 0.5.0 "plan-in-marshall: native write path + planning skills"`
- `/marshall:release-plan capture "field feedback intake"`  (slug-style release)
- "let's plan v0.5.0" / "scope the next release"

`add` mode (append a single component without re-walking the sweep):

- `/marshall:release-plan 0.5.0 add`
- "add a component to v0.5.0"

If no version-or-slug is supplied, ask — do not guess. If no theme is supplied,
accept that and prompt for it during the conversation.

## Preflight

1. Resolve the release version-or-slug. Refuse to guess if ambiguous.
2. **Confirm the release is seeded.** `mcp__plugin_marshall_marshall__release_get { release }`.
   - **Found** → continue; note its `project_type` and existing components.
   - **Not found** → stop. The release must exist first: point the user at
     `/marshall:release-init` (native) or `srm:import-release` (GitHub-tracked). Do
     **not** try to create the release from here.
3. If `release_get` already returns components for this release and the user did
   **not** ask for `add` mode, say so and ask whether they want to **add** more
   components or are re-running by mistake. Don't silently re-walk a sweep that
   would duplicate existing components.

## The planning conversation

Walk the user through the release as a structured conversation, **one cluster at
a time** — do not dump all the questions at once. This is the whole point of
running it in Claude: an adaptive sweep, not a form.

1. **Theme (one sentence)** — what is this release *about*? If they gave one at
   invocation, restate it and ask for confirmation. (The theme lives on the
   release record, set at `/marshall:release-init` time; this skill does not rewrite
   it — use it here only to frame the sweep.)

2. **Component sweep** — categories depend on the release's `project_type` (read
   from `release_get`). Ask "anything in this release?" **per category**, one at
   a time, and capture a one-line description per component the user names.

   For `laravel-package`:
   - Public API / contract changes
   - New Artisan commands or operator surface
   - Persistence / migration changes
   - Streaming / replay changes
   - Pulse / observability changes
   - Docs (operator runbooks, regulated examples, public-surface docs)
   - Test-coverage gaps to close
   - Chores (composer constraints, internal markings, scaffolding)

   For `laravel-app`:
   - User-facing flows (new screens, changed screens)
   - Backend behavior (agents, jobs, integrations)
   - Persistence / migration changes
   - Operator surface (admin tooling, observability, recovery)
   - Billing-touching changes
   - Cost-impacting changes (new LLM dispatches, context size changes)
   - Docs (operator runbooks, user-facing copy)
   - Test-coverage gaps to close
   - Chores (dependency bumps, scaffolding, internal cleanup)

   If `project_type` is missing or unrecognized, ask the user which set fits
   rather than guessing.

3. **Deploy-safety + breaking (per component)** — for each component captured in
   the sweep, ask the safety questions. The store keeps **both** fields, so ask
   both regardless of wrap mode:
   - **Deploy safety** — the three sub-questions:
     - `Migration: none / safe-additive / requires-backfill / destructive`
     - `Feature flag: none / new-flag-default-off / new-flag-default-on / existing-flag`
     - `Rollback: revert-safe / revert-unsafe-due-to-X`
   - **Breaking change?** — `yes / no`; if yes, one line on the upgrade impact.

4. **Out-of-scope sweep** — ask "anything you considered for this release and
   explicitly cut?" Capture them as a list and read it back. These do not become
   components; they belong on the release record's `out_of_scope`. If the user
   names cuts, offer to record them straight onto the release via
   `release_update { release, out_of_scope: [...] }` (pass the full replacement
   list — it overwrites, so include any cuts already on the record; confirm
   before writing). If they decline, leave the record as-is — the cuts can still
   be set later.

Do not invent components the user didn't mention. If a sweep category returns
nothing, that's a valid answer — move on.

## The component shape (strict)

Every component lands with the **same strict shape** as the GitHub issue
template, minus the GitHub round-trip. Draft each one for confirmation like
this, then map it onto `component_create`:

```
Title:        <imperative, scannable — e.g. "swarm:trace forensic CLI">
Branch type:  <one of the release's branch_types — topic branch will be
              <type>/<release>-<slug>>
Slug:         <kebab-case-slug>
Deploy safety:
  Migration:    <none / safe-additive / requires-backfill / destructive>
  Feature flag: <none / new-flag-default-off / new-flag-default-on / existing-flag>
  Rollback:     <revert-safe / revert-unsafe-due-to-X>
Breaking:     <yes / no — if yes, one line on upgrade impact>
Notes:        <Goal + Acceptance Criteria + Out-of-scope, in prose/bullets —
              what changes from the user's or operator's perspective, the
              verifiable bullets, and what's deliberately not in this component>
External ref: <optional — see below>
```

`notes` carries the body that the GitHub template spread across `## Goal`,
`## Acceptance Criteria`, and `## Out of Scope`. Keep it structured (a short
Goal paragraph, then `- [ ]` acceptance bullets, then an out-of-scope line) so
the component reads the same on the release-detail screen as a GitHub issue
would. Always include a `CHANGELOG entry under <release>` and a `Docs updated:`
bullet in the acceptance criteria, matching house convention.

### Optional external-tracker link

After drafting, offer an **optional** external-tracker link and make it clearly
skippable: "Link this to a tracker issue? (GitHub / Jira / Linear, or skip)".
If they want one, capture `external_ref`:

- `provider` — `github` | `jira` | `linear` (or any tracker name)
- `id` — the issue key/number (e.g. `52`, `PROJ-123`)
- `url` — the full link

This is a stored link only — Marshall augments the tracker, it does not sync with it.
Skip it by default; most store-native components won't have one. Omit
`external_ref` entirely when skipped.

## Confirmation loop

For each component, **one at a time** — no batch-create:

1. Show the rendered draft (the shape above).
2. Ask: **"File it?"** Accept `yes`, `edit`, `skip`.
   - `edit` → take the user's changes inline and re-show the draft.
   - `skip` → drop it, move to the next.
3. On `yes`, file it:
   ```
   mcp__plugin_marshall_marshall__component_create {
     release:      "<version-or-slug>",
     title:        "<title>",
     branch_type:  "<type>",
     slug:         "<kebab-case-slug>",
     deploy_safety: { migration: "...", feature_flag: "...", rollback: "..." },
     breaking:     <true|false>,
     notes:        "<structured body>",
     external_ref: { provider: "...", id: "...", url: "..." }   // omit if skipped
   }
   ```
4. On success, confirm with the returned component id/ref and that it's now live
   on the release-detail screen. On error, **surface it verbatim** and stop —
   e.g. a validation failure (bad `branch_type`/`deploy_safety` value), a
   workspace-scope/`release_not_found` error, or a duplicate slug. Do not paper
   over it or retry blindly. `release_ambiguous` is the one error with a
   mechanical fix: the version matched several releases, so retry with `project`
   set to a candidate's project and `release` set to its slug (`candidates[]`
   lists both). Retrying the same bare version just repeats it.

File each confirmed component with its own `component_create` call as you go —
**never** collect them and batch-create at the end. Each one gets its own `yes`.

## Add mode

`/marshall:release-plan <release> add` appends **a single** component to an existing
release:

1. Preflight as above (the release must already be seeded).
2. **Skip the full sweep.** Go straight to drafting one component: ask for its
   one-line description, then the deploy-safety + breaking questions, then the
   optional external ref.
3. Run the same confirmation loop for that one component and `component_create`
   it.
4. Report the new component and stop — do not re-walk categories or touch the
   others.

Use `add` whenever a new piece of work surfaces after the initial plan, instead
of re-running the whole conversation.

## Amending a filed component

A component that is already in the store is **editable** — planning is a
conversation, and the answers move. When the operator revises something about a
component that already exists ("the migration is actually destructive", "rename
that one", "link it to PROJ-123"), **patch it; do not file a second one.**

```
mcp__plugin_marshall_marshall__component_update {
  component: "<component ULID>",
  title?:         "<new title>",
  slug?:          "<new-slug>",
  branch_type?:   "<type>",
  deploy_safety?: { migration: "...", feature_flag: "...", rollback: "..." },
  breaking?:      <true|false>,
  notes?:         "<revised body>",
  touches?:       ["app/Models/*.php"],
  external_ref?:  { provider: "...", id: "...", url: "..." }   // or null to unlink
}
```

The patch is **partial**: only the fields you pass change, so amending a title
cannot silently blank the notes. Read the current component from `release_get`
first, show the operator the before/after for the fields you are about to change,
and take the same `yes` you would for a create.

Two things this is **not**:

- **Not a work-state move.** `component_update` edits *fields*. A component's
  lifecycle (`open` → `in_progress` → `proposed` → `merged`, or `cancelled`) moves
  only via `mcp__plugin_marshall_marshall__set_component_state`. Never try to
  express "this is done" as an update.
- **Not a delete.** To remove a component from view, use `/marshall:release-admin`
  (archive, or hard-delete a mis-created one). Blanking a component's fields to
  make it "go away" leaves a live, unblocked, empty row in the graph.

`deploy_safety` and `external_ref` replace wholesale rather than merging, so pass
the **complete** object for those two — including the sub-answers that are not
changing.

## After

When the loop finishes, print:

- The count of components filed (and any skipped).
- That they are **already live** on the release-detail screen — no import step.
- Next step: `Run /marshall:release-graph to map dependencies, then /marshall:release-next
  when you're ready to start work.`

## Guardrails

- **Pure-store, always.** Never file a GitHub issue and never write
  `release-plan.json` (or any local state) from this skill. The store is
  authoritative. The GitHub-seeded `/release-plan` is the separate path for
  repos that want issues — don't blend the two.
- **Never create the release here.** If `release_get` is empty, the fix is
  `/marshall:release-init` / `srm:import-release`, not a write from this skill.
- **One component per `component_create`, each behind its own `yes`.** No
  batch-create, no auto-filing the whole sweep.
- **Per-cluster conversation.** Don't dump every question at once — theme, then
  the sweep one category at a time, then per-component safety, then out-of-scope.
- **Don't invent scope.** Only file components the user named. An empty sweep
  category is a valid answer.
- **External ref is optional and skippable.** Default to skipping; omit the
  field entirely when there's no tracker link.
- **Surface store errors verbatim.** A validation/workspace/duplicate error is a
  hard stop, not something to work around.
