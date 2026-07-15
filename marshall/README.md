# Marshall (Claude)

The **Claude Code** host adapter for the hosted Marshall store. It
lifts release-planning state out of repo-local, gitignored JSON into a shared
store, so claims, drift, and startability are the same across machines, people,
and agents.

The agent talks to the store **natively over MCP** — this plugin connects the
hosted Marshall MCP server, and the skills drive its tools. The agent-agnostic `marshall`
CLI (`@builtbyberry/marshall-cli`) stays as a secondary path for humans, CI, and hooks.
codex / cursor adapters will register the same MCP endpoint.

## What's here

```
plugins/claude/
  .claude-plugin/plugin.json   manifest (name, version, keywords)
  .mcp.json                    connects the hosted Marshall MCP server (OAuth)
  commands/release-status.md   /release-status — who holds what + drift
  skills/release-next/         startable work, ranked (read-only)
  hooks/hooks.json             SessionStart: optional CLI readiness ping
  scripts/session-start.sh     the hook body (silent without the CLI)
```

The MCP tools appear as `mcp__plugin_marshall_marshall__release_next`,
`…__release_status`, `…__release_get`, `…__claim_component`,
`…__heartbeat_claim`, `…__release_claim`, `…__revoke_claim`.

## Connecting (no config to set)

The plugin connects the hosted Marshall MCP server at
`https://release-manager.swarmplatform.cloud/mcp` — the URL is built in, there's
nothing to fill in when you enable it.

Auth is **OAuth 2.1** (authorization-code + PKCE, Dynamic Client Registration):
the client self-registers, you approve the connection in your browser and pick
the workspace it may operate in — no token to paste or store. No per-repo opt-in
is needed; enabling the plugin connects it. (The secondary `marshall` CLI authenticates
with its own bearer token from the environment for human/CI use, and reads its
store URL from `MARSHALL_URL` — separate from this plugin.)

## Status

`release-next` + `release-status` (read path) are wired over MCP end-to-end, and
the claim lifecycle tools (`claim_component` → `heartbeat_claim` →
`release_claim`, plus `revoke_claim`) are available. Skills for the write path
and the rest of the lifecycle follow, along with a `release-worker` agent.
