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
marshall/
  .claude-plugin/plugin.json   manifest (name, version, keywords)
  .mcp.json                    connects the hosted Marshall MCP server (OAuth)
  commands/release-status.md   /release-status — who holds what + drift
  hooks/hooks.json             SessionStart: optional CLI readiness ping
  scripts/session-start.sh     the hook body (silent without the CLI)
  skills/                      the twelve release skills:
    release-init               bootstrap a project + release in the store
    release-plan               scope a release into components
    release-graph              declare the dependency graph (makes work startable)
    release-open               cut the release branch + draft PR
    release-next               what's startable, ranked by what it unblocks
    release-topic              claim a component (the cross-machine lock) + branch
    release-parallel           dispatch a wave across startable components
    release-unclaim            hand a claim back, or force-revoke a stuck one
    change-review              multi-lens review of a component's diff
    release-readiness          multi-lens review of the release
    release-wrap               review + CHANGELOG + hand off for deploy
    release-deploy             merge → watch → smoke → monitor
```

The skills drive twenty MCP tools, each prefixed with the plugin's connection
name — `mcp__plugin_marshall_marshall__release_next`, and so on. They span the
read path (`release_get`, `release_next`, `release_status`), the write path
(`project_create`, `release_create`, `component_create`, `release_update`,
`set_release_graph`, `set_component_state`), the claim lifecycle
(`claim_component`, `heartbeat_claim`, `release_claim`, `revoke_claim`), reviews
(`record_finding`, `resolve_finding`, `lenses_get`), dispatch (`dispatch_open`,
`dispatch_report`, `dispatch_get`), and deploy (`set_deploy_step`).

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

The full release lifecycle is wired over MCP end-to-end — plan, graph, open,
claim, review, wrap, deploy. The claim is a real cross-machine lock with a
lease and a fence, so two people (or agents) on different machines cannot pick
up the same component.

codex and cursor adapters will register the same MCP endpoint; they are not
published yet.
