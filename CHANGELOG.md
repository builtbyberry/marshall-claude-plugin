# Changelog

All notable changes to the Marshall Claude Code plugin.

This file is hand-authored and is **not** rendered by the publisher — the
publish manifest never touches it. The plugin's version is set at the source in
`builtbyberry/swarm-release-manager` and rendered into
`marshall/.claude-plugin/plugin.json`; the heading and git tag here must match
whatever that render declares.

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
