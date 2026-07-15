---
name: release-open
description: "Open a release session against the shared Marshall store: confirm the release is seeded, cut the release branch, scaffold the CHANGELOG, open the draft release PR, and optionally (on a yes) link a GitHub milestone. Use when the user says /release-open, start release, cut release branch, or let's start <release>."
---

# Release Open (Marshall)

Open a release session the right way: **confirm the release exists in the shared
Marshall store first**, then do the git/PR mechanics — cut the release branch,
scaffold the CHANGELOG entry, push, and open the draft release PR. The store is
the state; there is no local `release-state.json`/`release-plan.json`. The
release's phase derives automatically from its components (once they exist and at
least one is unmerged it resolves to `open`; an all-closed milestone imports with
every component already `merged`, so it derives `wrapping`), so there's nothing to
write to "open" it — this skill's job is the git/PR mechanics plus confirming the
release is seeded.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — confirm the release is seeded (its components are what
  makes the phase resolve). If it's missing, seed it first — `/marshall:release-init`
  (native `release_create`) or a GitHub-milestone import — then retry.
- `mcp__plugin_marshall_marshall__release_update` — **OPTIONAL, opt-in only**: when the operator says
  yes (step 9), link the release to a GitHub milestone by passing
  `milestone_number`; `tracker_url` is derived from the project repo. Never
  called without an explicit yes.

If the MCP server isn't connected, **stop and say so** — the store is the only
source of truth for whether the release exists; don't proceed from memory.

The branch/CHANGELOG/PR mechanics are plain git + `gh` — they don't touch the
store. Config comes from `.claude/release-config.json` (tracked, read from the
current checkout): `repo`, `default_branch`,
`versioning.release_branch_pattern`, `wrap.mode`, `wrap.changelog_path`.

## Procedure

1. Resolve the release version-or-slug (ask if ambiguous — don't guess). Refuse
   if `.claude/release-config.json` is missing.
2. **Ensure the release is in the store.** `mcp__plugin_marshall_marshall__release_get { release }`.
   - **Found** → it's seeded; continue.
   - **Not found** → seed the release first, then retry. Native:
     `/marshall:release-init` (`release_create`). GitHub-tracked: import the milestone
     with `php artisan srm:import-release <repo> <milestone>` on the server. Stop
     — do **not** seed it from this skill; seeding is `/marshall:release-init` or import.
3. **Preflight (refuse on failure — do not auto-fix).** In order, stop on the
   first failure with a clear message:
   1. Working tree is clean: `git status --porcelain` is empty.
   2. Current branch is `<default_branch>`.
   3. `<default_branch>` is up to date with origin: `git fetch origin` then
      compare.
   4. Resolve the release branch from `versioning.release_branch_pattern` (e.g.
      `release/v0.7.0`) and verify it does **not** already exist locally or
      remotely (`git rev-parse --verify` fails, `git ls-remote --exit-code
      origin <branch>` fails).
4. **Theme.** Ask for a one-line theme for the release (it becomes the CHANGELOG
   intro and the PR subtitle). Accept `_TBD_` if the user can't articulate it
   yet, and remind them to fill it in at wrap time.
5. **Cut the branch.** `git switch -c <release-branch>`.
6. **Scaffold the CHANGELOG.** Insert immediately after the `# Changelog` header
   in `<wrap.changelog_path>`:
   ```markdown
   ## <release-label> - unreleased

   <theme paragraph>

   ### Added

   _To be filled in during release wrap-up._

   ### Changed

   _To be filled in during release wrap-up._
   ```
   The wrap phase adds any missing sections; only include `### Fixed` /
   `### Removed` now if the user expects them.
7. **Commit + push.**
   ```
   git add <wrap.changelog_path>
   git commit -m "chore(release): scaffold <release-label> changelog entry"
   git push -u origin <release-branch>
   ```
8. **Open the draft release PR.** Title `release: <release-label> — <theme>`,
   base `<default_branch>`, head `<release-branch>`, `--draft`. The body explains
   that topic branches target this branch (not `<default_branch>`) and carries
   the wrap-status checklist. With `wrap.mode = deploy` the final checklist item
   is the deploy step:
   ```
   - [ ] All topic PRs merged
   - [ ] Multi-expert review run
   - [ ] CHANGELOG filled
   - [ ] Readiness review run
   - [ ] Deploy executed and smoke + monitor passed
   ```
   (In `tag` mode the last item is "Ready for merge + tag" instead.)
9. **Optional — link a GitHub milestone (ASK; never automatic).** The release
   detail screen's "View milestone in tracker" link is sourced from the release's
   `tracker_url`; a natively-created release has none until one is linked. **Only
   if** the project has a GitHub `repo` **and** `release_get` shows no
   `tracker_url` yet, **ask** the operator: "Link this release to a GitHub
   milestone? (create a new one / use an existing number / skip)". Default to
   **skip** — never create or link a milestone without an explicit yes.
   - **Create new** → `gh api repos/<repo>/milestones -f title="<release-label>"`,
     capture its `number`, then `mcp__plugin_marshall_marshall__release_update { release,
     milestone_number: <number> }` (this derives `tracker_url` from the repo).
     Note: the milestone starts **empty** — native components are store-only, not
     GitHub issues — so it's a tracker home for the release, not an issue list.
   - **Existing number** → `mcp__plugin_marshall_marshall__release_update { release, milestone_number:
     <number> }` only; do not create a milestone.
   - **Skip** → leave it unlinked; the UI simply omits the link. It can be linked
     later with the same `release_update` call.
   If the release is **already linked** (`tracker_url` present), don't ask —
   report it as-is.
10. **Report.** Print the new branch name, the PR URL, whether a milestone was
    linked (or skipped), and the next-step hint: `Run /marshall:release-graph to verify
    the dependency graph, then /marshall:release-next`.

## Guardrails

- **Never seed the release from here.** If `release_get` comes back empty, seed it
  with `/marshall:release-init` (native `release_create`) or a GitHub-milestone import
  (`php artisan srm:import-release <repo> <milestone>`), then retry — this skill
  does only the git/PR mechanics.
- Preflight failures are hard stops, not warnings to work around. Don't
  auto-stash, don't reset, don't force-push.
- If the release branch already exists, stop — don't reuse or overwrite it.
- If `gh pr create` reports a PR already exists for this branch, surface that
  PR's URL and continue rather than opening a duplicate.
- Don't write any "open" state to the store — the `open` phase derives from the
  release having components (ReleasePhaseResolver). This skill only does git/PR.
- **Milestone linking is opt-in.** Never create a GitHub milestone or call
  `release_update { milestone_number }` without an explicit yes (step 9). Skip is
  the default, and an already-linked release is left untouched.
