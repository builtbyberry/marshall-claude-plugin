---
name: release-build
description: "Carry one release component from unclaimed to merged in a single guided loop against the shared Marshall store: claim → plan → pressure-test the plan → build → prove the tests can fail → change-review → fix → independently verify the fixes → land. Composes /marshall:release-topic (the claim lifecycle) and /marshall:change-review (the lens mechanics); owns only the sequencing, the two reviews that have no home today, and the landing. Use when the user says /marshall:release-build, build <component>, run the component loop, take this component to merged, or hands you a claimed component to carry through."
---

# Release Build (Marshall)

Carry **one component** from unclaimed to merged in a single guided loop, against
the shared Marshall store. The sequence — claim, plan, pressure-test the plan
before any code, build, prove the tests can fail, change-review, fix, verify the
fixes independently, land — has been retyped by hand every component. This is that
sequence, once.

The plugin has one composer today, `/marshall:release-wrap`, and it works at
**release** level: all-merged → review each component → CHANGELOG → readiness →
gate → hand off. There has been no **component**-level equivalent. This is that
missing sibling: it sits *below* wrap and *produces* the merged components wrap
later consumes.

## What it owns, and what it composes

This skill owns only three things: the **sequencing**, the **two review steps that
have no home anywhere else** (Steps 3 and 8), and the **landing**. Everything else
it composes — it does not restate:

- The **claim lifecycle** — claim, heartbeat, the "lost claim id is a lookup, not a
  re-claim" recovery — is `/marshall:release-topic`'s. Step 1 delegates to it wholesale.
- The **lens mechanics and findings** — lens config, the applicable-lens pre-filter,
  the per-lens fan-out, the verdict rubric, `record_findings` / `resolve_findings` —
  are `/marshall:change-review`'s. Step 7 delegates to it wholesale.

Changing what either of those skills does is **out of scope** (see Guardrails).

## How it talks to the store

- `mcp__plugin_marshall_marshall__release_get` — resolve the component, read its
  `notes` (the plan of record: GOAL, acceptance criteria, out-of-scope, `touches`),
  its work-state, and the existing `kind: change` findings. **The store, plus git,
  is where the resume point comes from — never conversation memory.**
- `mcp__plugin_marshall_marshall__heartbeat_claim` — keep the lease alive across the
  long middle (build, review). A `lease_lost` is a stop — recover through
  `/marshall:release-topic` and re-claim before continuing.
- `mcp__plugin_marshall_marshall__set_component_state` — move the work-state:
  `in_progress` (Step 1) → `proposed` (PR open, Step 9) → `merged` (landed, Step 9).
  Marking it `merged` is what unblocks dependents; releasing the claim alone does not.
- `mcp__plugin_marshall_marshall__record_findings` — **only** to record an out-of-scope
  problem against the release: pass it with **`component_id` omitted** (that omission
  is what keeps it release-scoped rather than folded into this component) and the
  `kind` that fits — `change` for a code concern, `readiness` / `design` otherwise.
  The component's own `kind: change` findings are change-review's to write, never this
  skill's.

The claim lifecycle tools (`claim_component`, `release_claim`, `my_claims`) are
driven **through** `/marshall:release-topic`, not called here directly.

## Autonomy — and the three hard stops

This loop is built to run **start-to-merge unattended**: dispatched against a
claimed component, it plans, builds, reviews, fixes, verifies, and lands without a
human at each boundary. That is the point — it matches the standing "auto-merge
when clean" instruction, where *clean* is the exit condition, not a hope.

Within the build loop it **hard-stops on exactly three things**:

1. **A high finding that cannot be fixed inside the acceptance criteria.** Fixing it
   would require inventing scope. Stop; the fix is a scoping decision, not a build one.
2. **CI red after one fix attempt.** One honest attempt to make it green; a second
   red is a signal the change is wrong, not that the test is flaky. Stop.
3. **Genuine scope ambiguity.** The plan of record doesn't answer a question the
   build forces. Stop and ask — never guess and never widen the component to cover it.

These three are the *build-loop* stops. The precondition and lease failures —
`claim_conflict` / `not_startable` at Step 1, `lease_lost` mid-run — and Step 0's
"two signals disagree" stop belong to the **claim lifecycle**, not the loop; they are
`/marshall:release-topic`'s stops, and they are not counted among these three.

**A hard stop leaves the claim held.** Resuming costs nothing: the lease is yours,
the branch is yours, and Step 0 re-derives exactly where you were. A hard stop is a
pause, not an abandonment.

### The merge dial

Landing (Step 9) is the one step with a mode, because whether a clean run *merges*
or *parks* is the operator's call, not the skill's:

- **autonomous** — auto-merge when clean (the three hard stops are the only brakes).
  This is how a dispatched/unattended run lands, and what `/marshall:release-parallel`
  expects.
- **supervised** — land the PR to `proposed` and stop; a human merges. This is the
  default when a human is driving interactively.

The **gates are identical and mandatory in both** — the dial governs only the final
merge, never whether the plan was pressure-tested or the tests were proven. Resolve
the mode at Step 0 (dispatched → autonomous; interactive → supervised) and say which
one you are driving.

## The two steps that must not be optimised away

Both were invented under fire and both caught defects every other layer missed.
They are **non-skippable** — a run that skips either is not a release-build run:

- **Step 3 — pressure-test the PLAN before any code.** A plan reviewed *after*
  implementation gets reviewed as code, and a whole class of defect is invisible at
  that altitude. A real plan here was wrong in nine places, three of which would
  have shipped a fix that looked correct and did not work.
- **Step 8 — verify the FIXES independently**, by a reviewer that **did not produce
  the findings**. An independent pass once found a change that walked operators into
  the exact data loss the release existed to prevent — *after* both review lenses had
  already cleared it. The finder is the wrong judge of the fix.

## Procedure

Announce each step on entry; a human driving can interrupt at any boundary. The
whole loop is **resumable from the store + git** (see Step 0) — never from memory.

### Step 0 — Resolve, and derive the resume point
- Resolve the component (an explicit ref → the active Marshall claim → the current
  branch name). On resume, **two present signals that disagree is a STOP** — the diff
  under review and the finding scope would refer to different components.
- `release_get` and read the component's `notes` — the **plan of record**. Its GOAL,
  acceptance criteria, and out-of-scope are the contract this run delivers against;
  its `touches` names the files.
- Derive the resume point from observable state, and **re-run the covering gate on
  ambiguity** — the plan and the two gates leave no store footprint, so re-running
  them is how resume stays honest, and each is safe to repeat:
  - **no topic branch** → start at Step 1.
  - **branch exists, no commits** → the plan lived only in memory and is gone;
    re-run **Steps 2–3** (rebuild the plan, then pressure-test it) before Step 4.
  - **commits exist, no `kind: change` findings** → built but unreviewed; re-run
    **Step 5** (prove-can-fail) before Step 7.
  - **findings exist** → reconcile against them in Steps 7–8.
- Resolve the **merge dial** (dispatched → autonomous; interactive → supervised).

### Step 1 — Claim + branch  *(composes `/marshall:release-topic`)*
Confirm startable, `claim_component`, handle `claim_conflict` / `not_startable` as
hard stops, `set_component_state in_progress`, cut the topic branch. Delegated
wholesale — no claim logic is restated here. Heartbeat through the long steps below.

### Step 2 — Plan the component
Write an implementation plan **before any edit to source**: the files to touch
(cross-checked against the plan-of-record `touches`), the approach, the blast
radius, and the **test strategy** — which guard proves which behavior, and where a
change crosses a protocol boundary so its **wire shape** needs a guard, not just its
code path. No source edits in this step.

### Step 3 — Pressure-test the plan  *(gate — no code until it survives)*
Adversarially critique the Step-2 plan: what it misses, what breaks downstream, the
migration / tenant / flag risk, whether a simpler shape exists. **Hybrid, mirroring
change-review's compressed pass:** an independent subagent for a non-trivial plan
(the author must not grade their own work); an inline adversarial pass for a trivial
one. Every subagent **this skill spawns** (here and Step 8) carries the **scope
constraint verbatim** (see below) — change-review's own per-lens subagents are its to
prompt, not this skill's. Revise until the plan survives. Writing code before it
survives is the failure this step exists to prevent.

### Step 4 — Build
Implement to the surviving plan and the acceptance criteria — **no more.** Do not
invent acceptance criteria; an out-of-scope problem you notice is recorded against
the release (Step 6), not folded in. `heartbeat_claim` periodically; `lease_lost` is
a stop → recover via `/marshall:release-topic` and re-claim.

### Step 5 — Prove the tests can fail  *(gate — a guard you haven't watched fail is not proven)*
For each new or changed guard: **mutate the source it protects, watch the test go
red, then restore.** A test that passes both before and after its guard is removed
does not count. **Where the change crosses a protocol boundary, mutate the WIRE
shape, not only the code path** — a guard that only sees the internal call proves
nothing about the bytes on the wire. This is the single most-skipped step in the
hand loop; it is non-skippable here.

### Step 6 — Run the repo's real gates
Run every gate `.claude/release-config.json` names (tests, lint, static analysis,
and the frontend gates where the change touches frontend) and confirm each **passes
and actually runs** — a config that names a gate it doesn't run is lying, and the
loop is only as honest as the config. **One honest fix attempt on a red gate; a
second red is hard-stop #2, and the claim stays held.** Record any genuinely
out-of-scope problem against the **release** — `record_findings` with `component_id`
**omitted**, never against this component.

### Step 7 — Change-review  *(composes `/marshall:change-review`)*
Run `/marshall:change-review` against the component diff. It records `kind: change`
findings scoped with `component_id`, reconciling against existing ones. The diff base
is change-review's (`merge-base origin/<default_branch> HEAD`); this skill only
guarantees the topic branch descends from a clean base. Do not re-specify a base.

### Step 8 — Fix, then verify the fixes independently  *(gate)*
Walk every `open` `kind: change` finding; drive each to fix / defer / accept through
change-review's modes. After a **fix**, re-run the affected gates (**one fix attempt;
a second red gate is hard-stop #2**) and **re-prove (Step 5)** any guard the fix added
or changed.

Then **verify the fixes independently — spawn a subagent that did not produce the
findings and did not write the fixes.** Hand it the diff, the fixes, the acceptance
criteria, and each finding; it confirms that each fix actually resolves its finding
and introduced no new gap. It is a subagent this skill spawns, so it **carries the
scope constraint verbatim** (see below). The finder is the wrong judge of its own fix.

A **high** `kind: change` finding left `open` or `deferred` is hard-stop #1 unless it
can be fixed inside the acceptance criteria.

### Step 9 — Land
- Open/update the component PR → **`set_component_state proposed`**.
- **Merge dial:**
  - autonomous → when clean (no unfixable high, gates green, no ambiguity), merge,
    then **`set_component_state merged`**.
  - supervised → stop at `proposed`; report the landing state and let the human merge,
    who (or a follow-up) sets `merged`.
- `merged` is what unblocks dependents — set it on merge, not just at unclaim.
- Release the claim (`/marshall:release-unclaim`), and hand back:
  `/marshall:release-next` if components remain, else `/marshall:release-wrap`.

## The scope constraint (verbatim, in every subagent this skill spawns)

> Deliver exactly the component's acceptance criteria — do not invent new ones. A
> problem outside this component's scope is **recorded against the release**, not
> folded into this component. If the criteria do not answer a question the work
> forces, that is scope ambiguity: stop and surface it, never guess.

## Guardrails

- **Compose, don't duplicate.** The claim lifecycle is `/marshall:release-topic`'s;
  the lenses and findings are `/marshall:change-review`'s. This skill restates neither,
  and **changing what either does is out of scope.**
- **The two gates are non-skippable.** No code before Step 3 survives; no landing
  before Step 8's independent verification. The merge dial governs only the merge.
- **A guard you have not watched fail is not proven** — including the wire shape at a
  protocol boundary, not only the code path.
- **Deliver the acceptance criteria, nothing more.** Out-of-scope problems are release
  findings (`component_id` omitted), not silent scope creep. Genuine ambiguity is a
  hard stop, not a guess.
- **Exactly three build-loop hard stops** — an unfixable high, CI red after one fix
  attempt, scope ambiguity — and **a hard stop leaves the claim held** so resuming is
  free. Precondition / lease failures are release-topic's stops, not these.
- **Resume from the store + git, never conversation memory.** Re-derive the step and
  re-run the covering gate on ambiguity.
- **The claim is the source of truth, not the branch.** Heartbeat through the long
  middle; recover a lost claim id through `/marshall:release-topic` (a lookup, never a
  re-claim).
- **Landing is `merged`, not just unclaiming** — releasing the lock alone leaves
  dependents blocked.
- **Build stops at one merged component.** It never wraps, deploys, or tags — and it
  does not enforce the loop server-side; a skill is a prompt, not a gate.
