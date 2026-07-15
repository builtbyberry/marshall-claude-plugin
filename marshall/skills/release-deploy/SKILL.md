---
name: release-deploy
description: "Drive the deploy step of a release against the shared Marshall store: merge the release PR, watch the deploy, smoke-check production, monitor the window — recording every step on the store's Deploy record so it is resumable across sessions and machines. Use when the user says /release-deploy, deploy the release, ship <release>, or cut over to prod. Deploy-mode only."
---

# Release Deploy (Marshall)

The final cut-over — merge → watch → smoke → monitor — driven against the shared
Marshall store instead of a repo-local `deploy-state.json`. The store's **Deploy
record is the single source of truth** for where the deploy is: `release_get`
tells you the step, `set_deploy_step` advances it. That is what makes this
resumable across sessions, machines, and agents — and what stops a re-run from
re-shipping prod.

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — read the release + its **deploy** block (the
  authoritative `step`, `smoke_ok`, `monitor`, `verdict`). Read it on **every**
  invocation; never trust prior conversation memory for where the deploy is.
- `mcp__plugin_marshall_marshall__set_deploy_step` — start (`step: merging`) or advance the deploy one
  legal step (`deploying → smoke → monitor → done`), carrying evidence
  (`merged_by`, `merge_sha`, `deploy_url`, `smoke_ok`, `monitor`, `verdict`). The
  store enforces one deploy per release, legal forward transitions, the readiness
  gate, and an atomic audit row — you only supply the next step + evidence.

If the MCP server isn't connected, **stop and say so** — the store's Deploy
record is the only source of truth for where the deploy is; never drive a deploy
from conversation memory or a local file.

If `set_deploy_step` returns `deploy_blocked`, the readiness gate is refusing the
deploy because the release has unresolved high-severity findings — surface them
and stop; resolve them via `/marshall:release-wrap` (or `resolve_finding`) first. If it
returns `invalid_transition`, you tried to skip a step — re-read `deploy.step` and
continue from there.

## Config

Reads `.claude/release-config.json` (tracked) for `repo`, `default_branch`,
`wrap.mode` (must be `deploy` — refuse otherwise), and the `deploy` block:
- `deploy.provider` — `laravel-cloud` (watch the cloud deploy) or `none`/`manual`
  (auto-deploy is OFF; the operator performs the deploy by hand and you record the
  steps as they confirm). Default-safe to manual.
- `deploy.production_url`, `deploy.smoke_check_path`, `deploy.monitor_window_minutes`.

## Resume — read the store, never memory

On invocation, `release_get { release }` and read `deploy.step`:

- **no deploy record** → start at the Merge step.
- `merging` → the deploy is started but not merged; resume at Merge (check whether
  the PR is already merged before acting — see below).
- `deploying` → the merge happened and the deploy is in flight; **do NOT merge
  again and do NOT re-trigger the deploy** — resume by watching/polling status.
- `smoke` → resume at the smoke check (or, if `smoke_ok` is `false`, you are at a
  rollback decision — see **Smoke failure**).
- `monitor` → resume the monitor window from `deploy.monitor` (compute elapsed from
  the recorded window start; do not restart the clock).
- `done` → already shipped; report and stop.

> The deploy is the one step with an irreversible external side effect. Every
> action below is gated on `deploy.step` precisely so a resumed or re-dispatched
> run never re-merges or re-deploys what already happened.

## Preflight (refuse on failure)

1. `wrap.mode == deploy` and `deploy.production_url` is set.
2. HEAD is on the release branch; working tree clean.
3. The release PR exists, is not a draft, is `MERGEABLE`/`CLEAN`, and its checks
   are green (`gh pr view --json isDraft,mergeable,mergeStateStatus,statusCheckRollup`).
4. No topic PRs are still open into the release branch.
5. Readiness handed off: ideally invoked after `/marshall:release-wrap`. The store-side
   gate is the real backstop — `set_deploy_step` will refuse with `deploy_blocked`
   if any high finding is unresolved — but warn if wrap wasn't run.

## The flow

### Step 1 — Gate first, then merge (start the deploy)

1. Show the plan (merge PR #N into `<default_branch>`, watch the deploy, smoke
   `<production_url><smoke_check_path>`, monitor `<window>` min) and wait for an
   explicit `yes`.
2. **Trip the readiness gate BEFORE the irreversible merge.** `set_deploy_step {
   release, step: 'merging' }` — this creates the one deploy record and runs the
   gate. If it returns `deploy_blocked`, **stop and do not merge**: the release has
   unresolved high findings; surface them and route to `/marshall:release-wrap`. The
   merge auto-deploys on `laravel-cloud`, so the gate must clear *before* the
   merge, not after. (Idempotent on resume; if `deploy.step` is already
   `deploying`+, the merge already happened — skip to Step 2.)
3. **Merge (idempotent).** `gh pr view <N> --json state,mergeCommit`. If already
   `MERGED` (a prior run, or the user did it by hand), use the recorded
   `mergeCommit.oid`. Otherwise — only now that the gate has cleared — surface
   `gh pr merge <N> --merge --delete-branch` for the **user** to run (human-
   initiated; do not run it yourself) and wait for "merged".
4. Advance with the merge evidence: `set_deploy_step { release, step: 'deploying',
   merged_by, merge_sha: <oid> }`. The deploy is now in flight — Step 2.

### Step 2 — Watch the deploy (now at `deploying`)

Do not re-merge or re-trigger — `deploy.step` is `deploying`; the merge already
fired the deploy.
- **`provider: laravel-cloud`** — the cloud auto-deploys on push to the default
  branch. Watch via the Laravel Cloud dashboard/CLI and capture the deploy URL
  (recorded on the smoke write in Step 3). Do not declare done on the merge alone
  — the deploy is what reaches users.
- **`provider: none`/`manual`** — auto-deploy is OFF: tell the operator to perform
  the deploy and confirm when it is live.
- **On resume at `deploying`** — just continue watching/polling until the deploy
  reports complete, then proceed to smoke.

### Step 3 — Smoke check

1. `curl -sS -o /dev/null -w "%{http_code} %{time_total}" <production_url><smoke_check_path>`.
2. **Pass** (HTTP 200, latency < 5s): `set_deploy_step { release, step: 'smoke',
   smoke_ok: true, deploy_url }`.
3. **Fail** (non-200, error, or > 5s): advance to `smoke` carrying the failure, but
   **no further**: `set_deploy_step { release, step: 'smoke', smoke_ok: false,
   verdict: 'rollback-needed', deploy_url }`, then go to **Smoke failure**. The
   `verdict` makes the rollback decision durable in the store/audit; leaving the
   step at `smoke` (not `done`) keeps the derived phase honest — `deploying`, not
   `shipped`.

### Step 4 — Monitor window

The store has **no `monitor → monitor` transition**, so the window is written
exactly twice: once on entry (the resume anchor) and once on completion (the full
evidence). Do not attempt a per-check store write — it returns `invalid_transition`.

1. **Enter the window once:** `set_deploy_step { release, step: 'monitor', monitor:
   { started_at: <now>, window_minutes: <window> } }`. This is the resume anchor.
2. Poll the smoke endpoint every 60s, accumulating each check **in memory**. On
   resume mid-window, recompute the remaining time from the recorded
   `monitor.started_at` so the window length is honored across interruptions (the
   individual pre-interruption checks are not durable — only the window clock and
   the final set are).
3. Surface (don't auto-poll) the Pulse / error-tracker / logs URLs the operator
   should also watch.
4. **A failing check during the window** is a rollback decision; it cannot mutate
   the `monitor` row in place (no self-transition), so **report it and stop** — do
   not advance to `done` (the deploy didn't pass). Surface **Smoke failure**; the
   record stays at `monitor`, unshipped.
5. **On completion with all checks passing:** `set_deploy_step { release, step:
   'done', verdict: 'shipped', monitor: { started_at, window_minutes, checks:
   [<the full accumulated set>], completed_at: <now> } }` — the accumulated checks
   are persisted here, in the single legal `monitor → done` write, and the release
   derives `shipped`.

### Step 5 — Report

When `deploy.step == done`: summarize merge time, deploy duration, smoke result,
monitor checks, the production + dashboard URLs, and the operator follow-ups
(error rate, exceptions, visual regression).

## Smoke failure — the rollback decision

A smoke fail is a human decision; the skill stops being mechanical. The record
stays at `smoke`/`monitor` with `smoke_ok: false` and `verdict: rollback-needed` —
deliberately **not** advanced to `done`, because `done` derives `shipped` and this
deploy did not ship; the recorded verdict makes the rollback decision visible in
the store and audit without faking a shipped state. Surface:

```
SMOKE FAILED on <url>: HTTP <status>, <latency> (or error)
The deploy is live but the check failed. Options:
  1. Investigate (env var, migration, cache, asset build) — logs/Pulse/Sentry URLs.
  2. Roll back:
     - revert the merge: git revert -m 1 <merge_sha> && push (the cloud redeploys);
     - or roll back via the Laravel Cloud dashboard to the prior commit.
Tell me which path; I'll surface the exact commands.
```

If migrations ran in the deploy, **say so** and warn that a revert may not undo
them. Do not attempt to reverse migrations. There is no auto-rollback.

## After the deploy

When the deploy reaches `done`/`shipped`, the release is shipped. If this skill is
driving a release component's lifecycle, mark it merged and release its claim per
`/marshall:release-topic` step 5–6. The release's derived phase is now `shipped`
(from `deploy.step === 'done'`).

## Guardrails

- **Read `deploy.step` from the store every time; never act from memory.** The
  store is the source of truth across sessions, machines, and agents.
- **Never re-merge or re-trigger a deploy that already happened.** Gate every
  side-effecting action on `deploy.step`; `deploying`+ means it is in flight.
- **Do not auto-merge, auto-rollback, or auto-retry a smoke check.** Those are
  human decisions; the skill prepares, records, and surfaces.
- **A failed smoke stays at `smoke`/`monitor`, not `done`.** Don't fake a shipped
  verdict on a deploy that didn't ship.
- **Surface store errors verbatim** — `deploy_blocked` (resolve high findings
  first), `invalid_transition` (re-read the step), `lease_lost` — never work
  around them.
