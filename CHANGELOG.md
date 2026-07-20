# Changelog

All notable changes to the Marshall Claude Code plugin.

This file is hand-authored and is **not** rendered by the publisher — the
publish manifest never touches it. The plugin's version is set at the source in
`builtbyberry/swarm-release-manager` and rendered into
`marshall/.claude-plugin/plugin.json`; the heading and git tag here must match
whatever that render declares.

## 1.2.0 — 2026-07-20

Less of the same thing, said once.

1.1.0 taught the skills to call everything the store offers. This release is
about what they say while doing it. Two review skills carried ~285 lines of the
same protocol in two copies that had already begun to drift, and thirteen skills
carried paraphrases of tool descriptions the model already has in context — a
strictly worse copy of the source of truth, in a place nothing checks. The net
is **402 fewer lines** with no capability removed.

It also picks up the store's new read-side opt-in, so a session can now go cheap
on reads the way 1.1.0 made it go cheap on writes.

### Added

- **`skills/_shared/references/review-protocol.md`** — the plugin's first bundled
  reference file, and the pattern for any that follow. `change-review` and
  `release-readiness` are the same protocol with different nouns; the shared
  steps now live here once instead of twice.

  The two skills differ **deliberately** in six ways, and the most important is
  their **verdict vocabulary**: a change review returns
  `changes-required` / `approve-with-followups` / `approve`, a readiness review
  returns `hold` / `ship-with-followups` / `ship`. The reference never picks one.
  It is written against tokens each skill binds in its own *Protocol bindings*
  table, with a guard callout in each — *"Never report a change review as
  `ship` / `hold`"*, and the mirror image. Collapsing those into one vocabulary
  would have been a regression wearing a cleanup's clothes. Verified by a
  scripted survival check of 40 distinctive behavioural instructions across the
  new corpus.

  It also carries a **"What deliberately does NOT move into this file"** section,
  because the constraint that makes it necessary is invisible: two CI gates in
  the source repo read *only* files named `SKILL.md`. Three tools
  (`lenses_get`, `lenses_applicable`, `set_release_lenses`) are named by no other
  skill, and each skill's `record_findings` block is asserted verbatim. Moving
  those into a reference turns CI red with nothing pointing at why.

### Changed

- **`release-topic` now sets both response defaults for the session** —
  `set_default_return { "minimal" }` *and* the store's new
  `set_default_view { "summary" }`. Until now the write side could opt into small
  payloads while every read still paid for a full document. A fresh actor that
  never calls them is byte-unchanged, and an explicit per-call `view` or `return`
  still wins.
- **The store-tool prose across nine skills is trimmed from 301 lines to 255.**
  The intent was to cut it to about 60. That was not reachable and the diff was
  not padded to pretend otherwise: after the extraction above, these sections are
  roughly 40% callable tool names that CI depends on, 40% load-bearing prose that
  only looks like duplication — ordering rules, error codes such as
  `cannot_archive` and `deploy_blocked`, and the "stop and say so" clauses — and
  only about a fifth genuine paraphrase. Only that fifth was cut. Four skills
  were left alone entirely because they were already bare lists.

  What survives is deliberate: every `mcp__…` callable name, every ordering rule
  (`lenses_applicable` before `lenses_get`; the deploy and ship step sequences),
  every failure mode, and the batch-by-default policy.

Requires the Marshall store at **v0.18.0** or later, live at
[releasemarshall.com](https://releasemarshall.com) — `set_default_view` does not
exist before it. Nothing in your repository changes: `state.backend` is still the
literal `"srm"`, and `php artisan srm:import-release` keeps its name.

## 1.1.0 — 2026-07-19

The skills catch up to the store.

An audit of the Marshall MCP surface found **23 of 43 registered tools that no
skill ever called** — including nearly every affordance the store shipped in its
previous release: atomic batch writes, minimal-by-default responses, resumable
claims, the store-generated changelog, the readiness fan-out pre-filter, and the
tag-mode ship path. The capabilities were live and reachable; the client simply
never reached for them, so the work they save was never actually saved. Nothing
failed, because a tool nobody calls and a tool that works look identical from the
outside.

This release closes that gap and adds a CI gate on the source side so it cannot
reopen quietly.

### Added

- **`/marshall:release-admin`** — the nine lifecycle verbs that had no home:
  archive, unarchive and hard-delete across project, release and component. These
  are what you reach for when something went wrong, not steps in a workflow, so
  they get their own skill rather than being buried inside one. It also documents
  an ordering rule the individual tools do not state: archiving resolves
  bottom-up, unarchiving top-down, and unarchive does not cascade.
  `hard_delete_*` is fenced server-side to owner-only and empty-only, so the only
  thing it can remove is a mis-created empty record — the skill documents those
  refusals rather than re-implementing the guard.

### Changed

- **Every review and lifecycle skill now uses the store's batch writes.**
  `change-review` and `release-readiness` record and resolve a whole pass in one
  atomic call instead of one call per finding; `release-parallel` reports wave
  progress in one call; state transitions batch. Each batch site documents
  `batch_item_failed` as stop-and-resend, because decomposing a rejected batch
  into singular retries half-writes the pass the batch would have rolled back
  cleanly.
- **`release-topic` can recover a hold it lost.** A session whose context was
  compacted no longer strands its claim — `my_claims` finds every hold you still
  own, including the opaque claim id you no longer have.
- **`release-topic` sets a session-wide minimal response default once**, so the
  store's smaller payloads are actually realized instead of being available and
  unused.
- **`release-wrap` pulls the changelog from the store** rather than assembling it
  by hand.
- **`release-readiness` pre-filters its lens set against the changed files**
  before fanning out, so a docs-only or frontend-only diff no longer spawns a
  subagent per lens. Honest boundary: this narrows frontend, migration, test and
  docs diffs well, and still narrows nothing on a backend diff.
- **`release-deploy` drives tag mode**, for the repos that ship a package rather
  than a deployment: merge → date → tag → GitHub Release → Packagist. The
  irreversible steps stay operator-run — the skill surfaces the command and
  records the evidence, it never executes them for you.
- **`release-plan` can amend a component after it exists** (`component_update`),
  `release-parallel` can close a stuck wave, and `release-init` can list existing
  projects so a fresh init does not duplicate one.

### Fixed

- **`release-parallel` contradicted itself about failed members.** Its resume
  section called `failed` terminal and told you to leave such a member alone,
  while its subagent brief called the same note "the resume signal for a retry".
  Both cannot be true. `failed` is not terminal — it records that one *attempt*
  ended, and a recovered member can now be reported forward to where the work
  actually is, without the board forgetting the attempt failed.
- **Skills that named a tool in prose but never called it.** `set_release_lenses`
  and `project_update` read as covered to a human and were invisible to an agent,
  which can only act on the callable form. Both are now genuinely invoked.

Requires the Marshall store at v0.17.0 or later, which is live at
[releasemarshall.com](https://releasemarshall.com). Nothing in your repository
changes: `state.backend` is still the literal `"srm"`, and
`php artisan srm:import-release` keeps its name.

## 1.0.1 — 2026-07-15

### Fixed

- **A retired "Swarm Release Manager" wordmark in `/release-status`.** It sat one line under a heading that already read "Release Status (Marshall)", contradicting its own description. It survived the rename because it was **line-wrapped** — the rename rule matched a literal space, and the wrap put a newline there. The verification sweep missed it for a second reason: it scanned for `srm`, and a wrapped wordmark contains no `srm`. A catch-all only certifies the pattern class it actually scans. The check is now wrap-aware and covers every retired name, not just one family.
- **`/release-status` no longer says "an Marshall-tracked release".** Two skill descriptions carried the article from "an SRM-tracked" — the strings Claude Code matches on for activation. A token-level rename cannot see grammar that depends on the token.
- **The README described a plugin that does not exist.** It promised a `release-worker` agent (there is none), said the write path was still to come (it ships), and listed one skill (twelve ship) under the wrong root. It is now an accurate account of what you get.

Nothing about how the plugin behaves changed — no skill logic, no tool, no endpoint. `state.backend` in your `release-config.json` is still the literal `"srm"`, and `php artisan srm:import-release` still has its name.

## 1.0.0 — 2026-07-15

The first Marshall release. Supersedes the `srm` plugin from
`builtbyberry/swarm-release-kit`, which is now deprecated.

This is a clean-slate replacement rather than a rename: the plugin, its skills,
and its MCP connection are born with Marshall naming, so the hosted store's tool
names never had to break for connected clients.

### Added

- The twelve release skills, now invoked as `/marshall:*` — plan, init, open,
  graph, topic, next, parallel, unclaim, change-review, readiness, wrap, deploy.
- `/release-status` command and a session-start readiness ping that stays silent
  in repos that have not opted in.
- MCP connection named `marshall`, connecting the hosted Marshall store over
  OAuth. No token to paste or store.

### Fixed

Two bugs carried by the shipped `srm` plugin at v0.9.0, both fixed here:

- `/release-status` declared `allowed-tools: Bash(srm *)` while its own fallback
  invoked `marshall status` — the CLI binary was renamed in cli-v0.3.0 and the
  allowlist never followed, so the documented fallback was blocked by its own
  permission line.
- The skills named MCP tools as `mcp__srm__*`, a shape the host no longer
  exposes. All 77 references now use `mcp__plugin_marshall_marshall__*`, and the
  publisher verifies every tool a skill names against the tools the hosted server
  actually registers.

### Unchanged on purpose

- `state.backend` in `.claude/release-config.json` is still the literal `"srm"`.
  That value lives in *your* tracked config, so renaming it would silently stop
  recognising every repo already opted in. Nothing to change on upgrade.
- `php artisan srm:import-release` keeps its name — it is a command in the
  hosted app, not this plugin's to rename.
