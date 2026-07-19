---
name: release-init
description: "Bootstrap a project and release directly in the shared Marshall store — born-in-the-store, no GitHub round-trip. Resolve-or-create the workspace project, create the release (theme, version-or-slug, out_of_scope), and offer an optional external-tracker link. Use when the user says /release-init, bootstrap a release in the store, create a project and release in Marshall, start a release from scratch, or init a release without a GitHub milestone."
---

# Release Init (Marshall)

Bootstrap a release the Marshall-native way: **create the project and release
directly in the shared store** through its write-path tools, with zero GitHub
round-trip. The operator names a theme and a version-or-slug and walks away with
a live release in Marshall.

This is the Marshall-native counterpart to the GitHub-seeded `/release-init`. That
one scaffolds a repo's `.claude/release-config.json` and expects the release to
enter Marshall later via a GitHub milestone + `php artisan srm:import-release`. This
one is **born-in-the-store**: it calls `project_create` / `release_create`
directly, so the release exists in Marshall the moment you finish — no milestone, no
import. Marshall *augments* external trackers, it doesn't replace them, so an external
link (GitHub/Jira/Linear) is **offered but optional** — the store is the source
of truth.

It is **create-only and additive**: it never edits or deletes, and re-running
against a release that already exists **resumes** rather than duplicating.

## How it talks to the store

- `mcp__plugin_marshall_marshall__project_list` — **every** project in the
  workspace: the "what already exists here?" read, so a new bootstrap does not
  duplicate a project that is already there under a slightly different name. Takes
  **no arguments**. This is deliberately broader than `release_next`, which only
  surfaces projects with unshipped startable work — `project_list` also shows a
  project whose releases have **all shipped**, and an **empty** project with no
  releases at all. Those two are exactly the ones a fresh init would otherwise
  re-create. Archived projects are included and flagged (`archived: true`), and
  each entry carries `slug`, `name`, `repo`, `tracker_kind`, a `release_summary`
  (release counts by lifecycle phase) and `archived_releases`.
- `mcp__plugin_marshall_marshall__project_create` — resolve-or-create the workspace project. The
  external-tracker link — `repo` (owner/name) plus `tracker_kind` (github /
  jira / linear) — lives **here** and is **optional**; a project does not
  require a GitHub repo. If a project already matches in the current workspace
  it is reused, not duplicated.
- `mcp__plugin_marshall_marshall__release_get` — probe whether the release already exists under the
  project, so a re-run **resumes** instead of creating a second one.
- `mcp__plugin_marshall_marshall__release_create` — create the release under the project from
  `theme`, `version` (a version-or-slug like `v0.5.0`), and `out_of_scope`.
  `slug` is derived from `version` when omitted. `source` is recorded as
  `native` (vs `imported` for the GitHub-import path).

Both creates are workspace-scoped and fail-closed — no cross-workspace create,
no existence leak — matching the rest of the write path.

**If the write-path tools aren't available** (an older store, pre plan-write-path),
`project_create` / `release_create` won't be exposed by the connected MCP server.
**Stop and point at the import seam** rather than improvising: create a GitHub
milestone + issues and run `php artisan srm:import-release <repo> <milestone>` on
the server (or use the GitHub-seeded `/release-init` + import flow). Do not try to
fabricate the project/release any other way — the store is the only place they can
be born.

## Procedure

1. **Gather the release inputs** (ask; don't guess):
   - **Project** — the workspace project name (and optionally the external
     tracker link `repo` + `tracker_kind`, which stays optional).
   - **Theme** — a one-line theme for the release (becomes the CHANGELOG intro
     and PR subtitle downstream). Accept `_TBD_` and remind the operator to fill
     it in at wrap.
   - **Version-or-slug** — e.g. `v0.5.0` or `payments-revamp`.
   - **Out of scope** — what this release explicitly will *not* cover (optional).
2. **Preflight: confirm the write path exists.** If the connected Marshall MCP server
   does not expose `project_create` / `release_create`, stop and surface the
   import fallback above (`php artisan srm:import-release`). This is a graceful
   refusal, not an error to work around.
3. **Survey the workspace before creating anything.**
   `mcp__plugin_marshall_marshall__project_list {}` (no arguments) and read the
   result back to the operator.
   - **A project already matches** — same repo, or a name that is plainly the same
     thing ("Marshall" vs "marshall-release-manager") → **reuse it**. Confirm the
     slug with the operator and carry it forward; do not create a near-duplicate.
     `project_create` de-duplicates on its own terms, but it cannot tell that two
     *differently named* projects are the same project — only the operator can, and
     only if you show them the list.
   - **A match exists but is `archived: true`** → say so explicitly. The operator
     almost certainly wants it **restored**, not shadowed by a fresh copy:
     `/marshall:release-admin` (`unarchive_project`). A second live project pointing
     at the same repo is the worst outcome here, because both then look correct.
   - **No match** → continue; this is a genuinely new project.
4. **Resolve-or-create the project — and offer the optional external-tracker
   link here.**
   `mcp__plugin_marshall_marshall__project_create { name: "<project>", repo?: "<owner/repo>",
   tracker_kind?: "github | jira | linear" }`.
   - The external-tracker link lives on the **project**: `repo` (owner/name)
     plus `tracker_kind` (github / jira / linear). Ask whether to link one;
     make clear it is **skippable** and that the store is the source of truth —
     it's a stored link only, no GitHub/Jira/Linear API call, no bidirectional
     sync. If the operator skips, omit `repo` / `tracker_kind`.
   - It returns the project whether it already existed in the workspace or was
     just created. Report which happened ("reused existing project" vs "created
     project") so the operator knows nothing was duplicated.
5. **Probe for an existing release (idempotency / resume).**
   `mcp__plugin_marshall_marshall__release_get { project: <project>, release: "<version-or-slug>" }`.
   - **Found** → the release already exists. **Do not create a second one.**
     Report it as already live and hand off (its components/graph are the next
     step). This skill stays create-only, so it won't change the project's
     external link on a resume — surface its current value as-is; to change it
     later, use the store's `project_update` tool.
   - **Not found** → continue to create it.
6. **Create the release.**
   `mcp__plugin_marshall_marshall__release_create { project: <project>, version:
   "<version-or-slug>", slug?: "<slug>", theme: "<theme>", out_of_scope:
   "<out_of_scope>" }`.
   `slug` is derived from `version` when omitted; `source` defaults to
   `native`. On success, report the created release.
7. **Report.** Print the project (reused or created), the release version-or-slug
   and theme, whether an external link was attached, and the next step:
   `Run /marshall:release-plan to add components, then /marshall:release-graph to verify the
   dependency graph, and /marshall:release-open to cut the branch.`

## Guardrails

- **Create-only (this skill).** This skill births a project + release; it does
  not modify or remove them — a re-run resumes an existing release, never
  overwriting or duplicating it. Editing a created record later is a separate
  path: `mcp__plugin_marshall_marshall__project_update` (name, `repo`,
  `tracker_kind`, `slug`, and the release-config defaults) or
  `mcp__plugin_marshall_marshall__release_update`. Removing one is a separate path
  again — `/marshall:release-admin`, which archives (reversible) or hard-deletes a
  mis-created empty record.

  One sharp edge worth knowing before you patch a project: changing `repo` to a
  **different** value **clears every existing release milestone link** under it
  (`milestone_number` and `tracker_url` are nulled), because `tracker_url` is
  derived from the repo and would otherwise silently re-point at an unrelated
  milestone. The response carries a `warning` naming the unlinked releases —
  surface it and re-link each one explicitly with
  `release_update { milestone_number }`. Setting `repo` to the same value, or
  leaving it out, touches no links.
- **Probe before you create.** Always `release_get` first. If the release exists,
  resuming is the correct outcome; creating a duplicate is a bug.
- **The store is the source of truth; the external link is optional.** Never
  require a GitHub repo or tracker ref to create a project or release, and never
  treat the external link as a fetch/sync — it's a stored reference only.
- **Fail closed on missing tools.** If `project_create` / `release_create` aren't
  exposed, do not improvise a project/release some other way — point at
  `php artisan srm:import-release` and stop.
- **This skill does not plan or branch.** Adding components is `/marshall:release-plan`;
  verifying the graph is `/marshall:release-graph`; cutting the release branch is
  `/marshall:release-open`. Init only bootstraps the project + release.
- Surface any store error verbatim (a workspace/auth problem, a validation
  failure). Don't paper over it.
