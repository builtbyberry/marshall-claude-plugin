# Marshall — Claude Code plugin

Release coordination for AI coding agents, backed by the hosted **Marshall**
store: claims, drift, and startability live in one shared store — the same
across machines, people, and agents — instead of repo-local JSON.

## Install

```
/plugin marketplace add builtbyberry/marshall-claude-plugin
/plugin install marshall@marshall
```

Enabling the plugin connects the hosted Marshall MCP server over OAuth. The
client self-registers, you approve the connection in your browser and pick the
workspace it may operate in — there is no token to paste or store.

The `marshall` CLI (`@builtbyberry/marshall-cli`) is a separate, agent-agnostic
path for humans, CI, and hooks. It is not required to use this plugin.

## What's in here

| Path | What |
| --- | --- |
| `marshall/skills/` | The release skills — plan, open, topic, review, wrap, deploy |
| `marshall/commands/` | `/release-status` |
| `marshall/hooks/` | Session-start readiness ping (silent unless the repo opts in) |
| `marshall/.mcp.json` | The hosted Marshall MCP endpoint |

## This repository is generated

**Do not edit these files by hand.** This repo is a published artifact: every
tracked path except `CHANGELOG.md`, `.github/`, and this notice's own tooling is
rendered from canon in the private `builtbyberry/swarm-release-manager` repo and
synced by `php artisan srm:publish-plugin claude <path>`. A hand edit will be
pruned or overwritten by the next publish, and CI's `--check` gate will fail the
moment the tree drifts from canon.

To change a skill, change it at the source and publish.

## License

MIT — see [LICENSE](LICENSE).
