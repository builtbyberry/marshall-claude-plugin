---
description: Show who holds what and what drifted in a release, from the shared Marshall store.
argument-hint: "[release-version]"
allowed-tools: Bash(marshall *)
---

# Release Status (Marshall)

Show the live coordination picture for a release from the shared Swarm Release
Manager store: what's startable, who currently holds which component (and on
which machine), and what has **drifted** — holds that went quiet and silently
reopened. This is the cross-machine signal that repo-local JSON can't give you.

Read-only. This never claims, releases, or mutates anything.

## Steps

1. Resolve the release version. If `$ARGUMENTS` is empty, ask the user which
   release (or use the one in context). Do not guess.
2. Call `mcp__plugin_marshall_marshall__release_status` with `{ release: "$ARGUMENTS" }`
   and render the result:
   - `held` — live holds (each with the actor + machine). Lead with these.
   - `drifting` — dropped holds that reopened. Call these out; they're the thing
     most likely to surprise a teammate.
   - `startable` — the count still ready to pick up.
   - If the MCP server isn't connected, fall back to `marshall status --release $ARGUMENTS`.
3. On a tool error, surface it verbatim (`release_not_found`, auth/connection).
   Don't paper over it. On `release_ambiguous` the version matched more than one
   release: its `candidates[]` name each one's `project` + `slug`, so retry with
   `project` set to a candidate's project and `release` set to its slug — that
   pair is unique. Retrying the same bare version just repeats the error.

For *what to start next* (ranked by what it unblocks), use `/release-next`.
