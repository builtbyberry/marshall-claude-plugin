# Marshall (Claude)

The **Claude Code** host adapter for the hosted Marshall store. It
lifts release-planning state out of repo-local, gitignored JSON into a shared
store, so claims, drift, and startability are the same across machines, people,
and agents.

The agent talks to the store **natively over MCP** — this plugin connects the
hosted Marshall MCP server, and the skills drive its tools. The agent-agnostic `marshall`
CLI (`@builtbyberry/marshall-cli`) stays as a secondary path for humans and CI.
codex / cursor adapters will register the same MCP endpoint.

## What's here

```
marshall/
  .claude-plugin/plugin.json   manifest (name, version, keywords)
  .mcp.json                    connects the hosted Marshall MCP server (OAuth)
  commands/release-status.md   /release-status — who holds what + drift
  hooks/hooks.json             SessionStart: repo opt-in note (no CLI needed),
                               and the mod's hooks module (`modules`)
  hooks/register.ts            the mod: heartbeat, status line, merge guard,
                               collision check, PR observers, compaction
                               (see "The mod" below)
  tests/guard.test.ts          the mod's tests (`claude plugin test`)
  scripts/session-start.sh     the hook body (silent unless the repo opts in)
  skills/                      the fourteen release skills:
    release-init               bootstrap a project + release in the store
    release-plan               scope a release into components
    release-graph              declare the dependency graph (makes work startable)
    release-open               cut the release branch + draft PR
    release-next               what's startable, ranked by what it unblocks
    release-topic              claim a component (the cross-machine lock) + branch
    release-parallel           dispatch a wave across startable components
    release-unclaim            hand a claim back, or force-revoke a stuck one
    change-review              multi-lens review of a component's diff
    release-build              carry one component from claim to merged (the loop)
    release-readiness          multi-lens review of the release
    release-wrap               review + CHANGELOG + hand off for deploy
    release-deploy             merge → watch → smoke → monitor
    release-admin              archive / restore / delete a record (corrective)
```

The skills drive fifty-five of the store's MCP tools, each prefixed with the plugin's
connection name — `mcp__plugin_marshall_marshall__release_next`, and so on. They
span the read path (`release_get`, `release_next`, `release_status`,
`project_list`, `release_changelog`), the write path (`project_create`,
`release_create`, `component_create`, the matching `*_update` tools,
`set_release_graph`, `set_component_state`/`set_component_states`), the claim
lifecycle (`claim_component`, `heartbeat_claim`, `release_claim`, `revoke_claim`,
`my_claims`), reviews (`record_finding`/`record_findings`,
`resolve_finding`/`resolve_findings`, `lenses_get`, `lenses_applicable`,
`set_release_lenses`), dispatch (`dispatch_open`, `dispatch_report`/
`dispatch_reports`, `dispatch_get`, `dispatch_close`), deploy and ship
(`set_deploy_step`, `set_ship_step`), autonomy and the kill switch
(`autonomy_get`, `worker_list`, `worker_pause`/`worker_stop`/`worker_resume`), stops
and the inbox (`stop_raise`, `stop_clear`, `needs_you_list`), and
the corrective lifecycle (`archive_*` / `unarchive_*` / `hard_delete_*`).

Every other registered tool is either referenced by a skill or named, with its
reason, as one no skill calls (`release_list`, the two the mod calls, and the
owner's `workspace_autonomy_update`), and CI enforces it —
a tool the server exposes but no skill mentions is a capability no operator can
discover, which is how the first two audits found twenty-one of them sitting
unused.

## Connecting (no config to set)

The plugin connects the hosted Marshall MCP server at
`https://releasemarshall.com/mcp` — the URL is built in, there's
nothing to fill in when you enable it.

Auth is **OAuth 2.1** (authorization-code + PKCE, Dynamic Client Registration):
the client self-registers, you approve the connection in your browser and pick
the workspace it may operate in — no token to paste or store. No per-repo opt-in
is needed; enabling the plugin connects it. (The secondary `marshall` CLI authenticates
with its own bearer token from the environment for human/CI use, and reads its
store URL from `MARSHALL_URL` — separate from this plugin.)

The `SessionStart` hook speaks only in a repo whose `.claude/release-config.json`
or `.agents/release-config.json` sets `state.backend` to `"marshall"` (or the older
`"srm"`). There it tells the agent the repo uses Marshall and that the hook does
**not** verify the MCP connection — run `/marshall:release-next` for that. It needs
no CLI and makes no network call; everywhere else it prints nothing.

## The mod

`hooks/register.ts` is a Claude Code hooks module (a mod). It does nothing in a
repo that has not opted in: the same check the `SessionStart` hook makes, the
nearest `.claude/release-config.json` or `.agents/release-config.json` setting
`state.backend` to `"marshall"` (or `"srm"`). In a repo that has, it:

- **Keeps your claims alive.** Every 60 s it beats the claims whose worktree is
  this checkout (and, when the claim names one, whose machine is this Mac) —
  never a claim taken from another worktree. After 30 minutes with no turn and
  no tool call it stops beating and says `idle, not beating`, so an abandoned
  session lets its leases lapse. It never releases a claim.
- **Shows the release on the status line:** `Marshall <release> · m/n merged ·
  k claims held here · N findings open` — `no claim here` when it holds none, and
  `N high open` while the release has untriaged highs. The release is the one a
  claim taken here belongs to, else the one the `release/<slug>` branch names.
  Notes follow it: `idle, not beating`, `lease lost`, `beat refused: allow its 8 store tools (…)`,
  `not recorded: …`, `declared elsewhere: <file>`.
- **Refuses a merge the store says should wait.** `gh pr merge` is refused while
  the release has untriaged high findings (open highs; a deferred finding is a
  triage decision and does not block). It is release-wide, since findings carry
  no PR. Only a real command position counts — a quoted mention, a heredoc body
  or `echo gh pr merge` does not. If the check itself fails (the store is
  unreachable, no release matches), the merge runs and the agent and a toast say
  it ran unchecked.
- **Holds an autonomous claim to its part's autonomy level** (see "Autonomy and the
  kill switch" below).
- **Stops a paused worker** until a person resumes it.
- **Stops an edit landing in a file another agent is working in** (see "The
  collision check" below).
- **Keeps the store true from what the agent does** (see below).
- **Survives compaction.** After a compaction of the main conversation it adds a
  message naming each held claim's id, its component, its release and its plan of
  record (goal and acceptance criteria), so the compacted session keeps working
  the same component.

### What it records on your behalf

Only after the command's **result** says it succeeded (not when it is merely
run), and only for a component held from this checkout:

| You run | It records |
| --- | --- |
| `gh pr create` on the held component's topic branch | `component_update` `pull_request {number, url}`, then `set_component_state proposed` with `actual_touches` = `git diff --name-only <release branch>...HEAD` |
| `gh pr merge` of that component's PR | `component_update` `merge_sha`, then `set_component_state merged` — which unblocks its dependents |

The PR is read back with `gh pr view` (open and on the topic branch for a
create; `MERGED` with a merge commit for a merge) — its URL and merge commit are
never parsed from the command's output; a merged PR's number may come from the
tool result. A
component already `proposed` or `merged` is left alone. A merge of a PR no
component here owns changes nothing; a component whose PR was opened before the
mod existed is matched by its topic branch, and its `pull_request` is filled in.
A queued merge (`--auto`) is not recorded until it merges — record it then. A
merge run from another checkout (an orchestrator in the release worktree) holds
no claim here, so it records nothing: record it there by hand. Two sessions in
one checkout beat the same claims; the store cannot tell them apart. The mod
does not report dispatch progress (`dispatch_report`).

When it has recorded something, the agent is told, so a skill does not make the
same call again (`proposed` → `proposed` is an `invalid_transition`). When a
store write fails the command is never blocked: the failure is named on the
status line (`not recorded: …`) and in a toast, and the agent is given the exact
calls to make by hand, with the store's answer.

### Autonomy and the kill switch

A claim's `mode` is the store's: `autonomous` when its part was a member of an open
dispatch run when it was taken, otherwise `supervised`. While the release's
`autonomy.enabled` is `true`, for an **autonomous** claim this Mac holds (in any
worktree, so a release-parallel subagent's claim counts too), the mod refuses:

| You run | Refused when |
| --- | --- |
| `gh pr create` on the part's topic branch (the current branch, or `--head`) | the part's level is `suggest`: it reports back instead |
| `gh pr merge` of the part's PR | the level is `suggest`, or `pr_and_wait` and no person has approved the part (Approve merge for the part on the release page) |
| `gh pr merge` of the release PR (its head is `release/<slug>`) | an autonomous run is open on the release, its merge to main is `person`, and no person has approved the release |

A **supervised** claim is never held to the level: the person's word in chat is
enough. A store that reports no `mode` or no `autonomy` gates nothing. If the policy
cannot be read (`release_get` fails), the command runs and the agent and a toast say
it ran unchecked, as for the merge guard.

**A paused claim stops its worker**, supervised or autonomous. The mod learns the
pause from `my_claims` (`paused_at`, `paused_by`), from its own heartbeat refused
`worker_paused`, and from the model's own `heartbeat_claim` refused the same way. While
a claim is paused, every tool call of the loop working it — the main loop for a claim
taken in this checkout, a subagent for the claim it beat itself — and every edit into
that claim's worktree is refused, naming who paused it and when. Still allowed: Marshall's
reads (`release_get`, `release_next`, `release_status`, `release_list`,
`release_changelog`, `project_list`, `my_claims`, `dispatch_get`, `lenses_get`,
`lenses_applicable`, `worker_list`, `autonomy_get`), `heartbeat_claim`, `release_claim`
(handing the claim back), `worker_resume` (the store decides who may resume) and
`ToolSearch`. The status line shows `paused by <name>`. A beat that succeeds, a
`my_claims` that shows it unpaused, or the claim ending (a stop revokes it) lifts it:
after a resume on the Workers screen the session waits at most one heartbeat (60 s).
A heartbeat that cannot read the store lifts the pauses it knew of and says so on the
status line (`Marshall unreachable: … · pause unchecked`): like every check here it
fails open, and the store still refuses a paused worker's writes.

### The collision check

Before an `Edit`, `Write` or `NotebookEdit` runs, the mod asks the store
`touch_conflicts` about the file, naming its own hold as `claim`, so only that hold
is left out. Its own hold is the claim on this Mac whose worktree holds the file —
the deepest one, so a release-parallel subagent editing a sibling worktree is
checked against that worktree's claim. A file no claim on this Mac holds (your
scratchpad, `/tmp`, another repo), a file inside `.git`, a claim with no worktree
(the auto-hold `in_progress` takes) and a repo that has not opted in are not
checked at all. Only the path inside the worktree is ever sent, never the absolute
path.

| The store says another claim of this project… | The edit |
| --- | --- |
| has edited the file (`overlap.live`) or changed it in its pull request (`overlap.reported`) | is **refused**, naming that claim's release, component, agent, machine and worktree (and "another session of yours" for your own parallel session), and telling the agent to coordinate or wait for that claim to land. A toast says so too. |
| only declares it in its touches (`overlap.declared`) | **runs**, and the agent is told who declared it — once per file per session — and the status line shows `declared elsewhere: <file>` until the next turn. |
| nothing | runs. |

**An edit refused that should not have been.** A claim's recorded files count
until that claim ends. If the claim the refusal names is dead (its session gone, no
heartbeat in `release_status`), `revoke_claim` it; if it is your own finished
session, `release_claim` it; if it is live, coordinate or wait for it to land. If
refusals misfire across the board, an operator turns `collision_guard` off in
Marshall (operator runbook §28.3).

A claim from another project in the workspace is ignored (the same relative path
in an unrelated repo is not this file), and so is another claim taken in this same
checkout (it is this session's own). With two claims in one worktree, edits count
against the first `my_claims` lists. Each answer is kept for the rest of the turn
(a subagent's turn is its own), so editing one file again makes no second call.

The check is synchronous: a slow store delays the edit, by at most three seconds
for each read, after which the read counts as failed. It **fails open**: if the
store cannot be read, or the check fails, is throttled or does not answer in time,
the edit runs and the agent is told it ran unchecked (with the allow rule when auto
mode refused the call), and the mod makes no further check for a minute. While
Marshall's `collision_guard` kill switch is off, every edit runs and the agent is
told the check is switched off. The check shares the store's limit of 120 calls a
minute per sign-in with everything else your sessions ask it, so a wide parallel
wave can reach it and run unchecked for a minute. The view of your claims is
the one the last heartbeat read (at most two minutes old), read again after the
model claims, releases, revokes or moves a component, so a claim taken a moment
ago may miss the first edit.

When a turn ends (a subagent's run ending is a turn end too), the files edited in it
are reported with `record_touches`, per claim, in batches of 100 — only files a
claim on this Mac holds, only edits that ran. A report for a claim that has since
ended is dropped quietly; one the store refuses (`not_holder`,
`touches_limit_exceeded`, `invalid_touch_path`) is dropped with a toast; anything
else is sent again at the next turn end. A file whose name carries `*`, `?` or a
control character is neither checked nor reported. Bash-driven writes (`sed`,
heredocs) are not seen.

### Auto mode

The mod calls eight store tools itself: `release_list`, `my_claims`,
`heartbeat_claim`, `release_get`, `set_component_state`, `component_update`,
`touch_conflicts` and `record_touches`.
On Claude Code 2.1.319 its calls skip the auto-mode classifier ("called by
plugin marshall"), on a timer tick too, with or without an allow rule — proven
headlessly against a tool that had no allow rule. Its `tool.check` hook answers
allow for those eight tools only, only for calls this plugin makes, and never over
a deny beneath it; the model's own Marshall calls are left to your rules.

On a build where a call is still refused, the status line and toast point here,
and the agent's note names the rule in full. Allow the eight tools in your settings:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_marshall_marshall__release_list",
      "mcp__plugin_marshall_marshall__my_claims",
      "mcp__plugin_marshall_marshall__heartbeat_claim",
      "mcp__plugin_marshall_marshall__release_get",
      "mcp__plugin_marshall_marshall__set_component_state",
      "mcp__plugin_marshall_marshall__component_update",
      "mcp__plugin_marshall_marshall__touch_conflicts",
      "mcp__plugin_marshall_marshall__record_touches"
    ]
  }
}
```

### Working on the mod

An interactive session that hot-reloads a `--plugin-dir` folder lays the
engine's types into its `.claude-plugin/types/`, and the publisher ships every
file under this folder. Load a copy, never
`resources/plugins/vendors/claude/marshall` itself; `claude plugin validate`
and `claude plugin test` are safest run against a copy too; CI runs the tests on
every push and pull request (the linter's quality job), on a pinned Claude Code. Type-check
by hand with a `tsconfig.json` kept outside the folder: the engine writes its
types only when a session loads the mod, so CI has none to check against.

## Status

The full release lifecycle is wired over MCP end-to-end — plan, graph, open,
claim, review, wrap, deploy. The claim is a real cross-machine lock with a
lease and a fence, so two people (or agents) on different machines cannot pick
up the same component.

codex and cursor adapters will register the same MCP endpoint; they are not
published yet.
