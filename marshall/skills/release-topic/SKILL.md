---
name: release-topic
description: "Start work on a release component: claim it in the Marshall store (the cross-machine lock), then create its topic branch. Use when the user says /release-topic, start <component>, begin work on, or pick up an issue."
---

# Release Topic (Marshall)

Start work on a component the right way: **claim it first** in the shared Marshall
store — the exclusive, cross-machine lock — then cut the topic branch. The claim
is what stops two people (or agents) from doing the same work on different
machines.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_next` — confirm the component is startable.
- `mcp__plugin_marshall_marshall__claim_component` — take the lock (returns the claim id + fence).
- `mcp__plugin_marshall_marshall__heartbeat_claim` — keep the lock alive during long work.
- `mcp__plugin_marshall_marshall__release_claim` — hand it back when the work is parked or done
  (or use `/marshall:release-unclaim`).

## Procedure

1. Identify the component (by tracker ref or title). If unclear, run
   `/marshall:release-next` first and let the user pick.
2. Claim it: `mcp__plugin_marshall_marshall__claim_component { component: <id> }`.
   - **Success** → you hold it; note the returned claim `id` and `fence`.
   - **`claim_conflict`** → someone else holds it (the error names the holder).
     Stop — do not start; surface who has it.
   - **`not_startable`** → blockers unmet or the graph is `unverified`. Stop and
     explain; if unverified, run `/marshall:release-graph` first.
3. Only after a successful claim, mark the work started:
   `mcp__plugin_marshall_marshall__set_component_state { component, state: "in_progress" }`, then
   create the topic branch (`<type>/<release>-<ref>-<slug>`) and begin work.
4. During long-running work, call `mcp__plugin_marshall_marshall__heartbeat_claim { claim }`
   periodically so the lease doesn't lapse. If a heartbeat returns `lease_lost`,
   **stop** — the claim was lost or revoked; re-claim before continuing.
5. When the PR **lands**, advance the work-state so dependents unblock:
   `mcp__plugin_marshall_marshall__set_component_state { component, state: "merged" }`. This is
   separate from the lock — releasing the claim alone does NOT mark it merged,
   so a merged blocker won't open its dependents until you set this.
6. Then release the lock (`/marshall:release-unclaim` or `mcp__plugin_marshall_marshall__release_claim`).

## Guardrails

- Never start work without a successful claim. A `claim_conflict` or
  `not_startable` is a hard stop, not a warning to work around.
- The claim is the source of truth, not the branch. If you lose the lease, the
  branch doesn't protect you — re-claim.
- One component per claim. To work several, claim each with `/marshall:release-topic`.
  (One-shot concurrent dispatch — `/marshall:release-parallel` — is planned but not
  yet available.)
