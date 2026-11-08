import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import { ownCallVerdict } from '../hooks/register.ts'

type On = Parameters<TestBody>[1]

const ROOT = '/work/swarm-release-manager-guard'
const HOST = 'Mac-1'
const OPTED_IN = JSON.stringify({ state: { backend: 'marshall' } })

type Pr = { number: number; url: string; state: string; headRefName: string; baseRefName: string; mergeCommit: { oid: string } | null }

type Fixture = {
  highOpen?: number
  findingsOpen?: number
  branch?: string
  nowAt?: () => number
  config?: Record<string, string>
  componentState?: string
  pullRequest?: { number: number; url: string } | null
  pr?: Pr | undefined
  prs?: Record<string, Pr>
  failing?: Record<string, string>
  bashResult?: Record<string, unknown>
  bashIsError?: boolean
  bashDenied?: boolean
  beatPeriods?: number
  localWorktree?: string
  localMachine?: string | null
  extraClaims?: { id: string; component_id: string; worktree: string | null; machine: string | null }[]
  conflicts?: (args: Record<string, unknown>) => unknown[]
  thrown?: Record<string, string>
  hanging?: string[]
  switchedOff?: boolean
  realPaths?: Record<string, string>
}

const openPr: Pr = {
  number: 701,
  url: 'https://github.com/o/r/pull/701',
  state: 'OPEN',
  headRefName: 'feat/claude-mod-guard-mod',
  baseRefName: 'release/claude-mod',
  mergeCommit: null,
}

const mergedPr: Pr = { ...openPr, state: 'MERGED', mergeCommit: { oid: 'abcdef1234567890abcdef1234567890abcdef12' } }

/**
 * Stands in for the engine: the opt-in config, git and gh, the clock and the
 * Marshall store, with one claim taken here and one taken from another
 * worktree.
 */
const engine = (on: On, fixture: Fixture = {}) => {
  const {
    highOpen = 0,
    findingsOpen = 4,
    branch = 'feat/claude-mod-guard-mod',
    nowAt = () => 0,
    config = { [`${ROOT}/.claude/release-config.json`]: OPTED_IN },
    componentState = 'in_progress',
    pullRequest = null,
    pr = openPr,
    failing = {},
    bashResult = {},
    bashIsError = false,
    bashDenied = false,
    beatPeriods = 0,
    localWorktree = ROOT,
    localMachine = HOST,
    extraClaims = [],
    conflicts = () => [],
    thrown = {},
    hanging = [],
    switchedOff = false,
    realPaths = {},
  } = fixture
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const commands: string[] = []
  const views: string[][] = []
  const periods: number[] = []
  // gh pr view answers only for the PR it is asked about: '' is the current branch's.
  const prs: Record<string, Pr> = fixture.prs ?? (pr === undefined ? {} : { '': pr, [String(pr.number)]: pr, [pr.headRefName]: pr })
  const text = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('mcp.connect', () => ({ value: { isConnected: true as const, server: 'plugin:marshall:marshall' } }))
  on('session.cwd', () => ({ value: `${ROOT}/app` }))
  on('fs.read', (_, e: { path: string }) => (config[e.path] === undefined ? { deny: 'ENOENT' } : { value: config[e.path] as string }))
  on('process.run', (_, e: { argv: readonly string[] }) => {
    const argv = e.argv.join(' ')

    if (argv === 'scutil --get LocalHostName') {
      return ran(`${HOST}\n`)
    }

    if (argv.includes('--show-toplevel')) {
      return ran(`${ROOT}\n`)
    }

    if (argv.includes('--abbrev-ref')) {
      return ran(`${branch}\n`)
    }

    if (argv.startsWith('git diff --name-only origin/release/claude-mod...HEAD')) {
      return ran('resources/plugins/vendors/claude/marshall/hooks/register.ts\nCHANGELOG.md\n')
    }

    if (argv.startsWith('gh pr view')) {
      const asked = e.argv.slice(3, e.argv.indexOf('--json'))
      const selector = asked.filter((word, index) => word !== '-R' && asked[index - 1] !== '-R')[0] ?? ''
      const found = prs[selector]

      views.push([...asked])

      return found === undefined ? ran('', 1) : ran(JSON.stringify(found))
    }

    return ran('', 1)
  })
  on('clock.now', () => ({ value: nowAt() }))
  on('fs.stat', (_, e: { path: string }) =>
    realPaths[e.path] === undefined
      ? { deny: 'ENOENT' }
      : ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: realPaths[e.path] } } as never),
  )
  // Each period is a dispatch: answering it runs the beat, refusing it ends the
  // interval. By default the first is refused, so only the beat at start runs.
  on('clock.every', (_, e: { ms: number }) => {
    periods.push(e.ms)

    return periods.length <= beatPeriods ? ({ value: undefined } as never) : { deny: 'no more timers in tests' }
  })
  on('ui.status', (_, e: { text: string | undefined }) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e: { text: string }) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  // A store that never answers: its calls stay pending, and the mod's wait for
  // them is the one sleep that comes due.
  on('clock.sleep', () => (hanging.length > 0 ? ({ value: undefined } as never) : new Promise<never>(() => {})))
  on('mcp.call', (_, e: { tool: string; args: Record<string, unknown> }) => {
    calls.push({ tool: e.tool, args: e.args })

    if (hanging.includes(e.tool)) {
      return new Promise<never>(() => {})
    }

    if (thrown[e.tool] !== undefined) {
      return { deny: thrown[e.tool] as string }
    }

    if (failing[e.tool] !== undefined) {
      return { value: { content: [{ type: 'text' as const, text: failing[e.tool] as string }], isError: true } }
    }

    if (e.tool === 'release_list') {
      return text({
        releases: [
          {
            id: 'r1',
            project: 'swarm-release-manager',
            slug: 'claude-mod',
            components: { total: 3, merged: 1 },
            findings: { open: findingsOpen, high_open: highOpen },
            claims: [
              { id: 'mine-here', component_id: 'c-guard' },
              { id: 'mine-elsewhere', component_id: 'c-touches' },
              ...extraClaims.map(({ id, component_id }) => ({ id, component_id })),
            ],
          },
          {
            id: 'r2',
            project: 'swarm-cloud',
            slug: 'say-it-plainly',
            components: { total: 10, merged: 4 },
            findings: { open: 26, high_open: 1 },
            claims: [],
          },
        ],
      })
    }

    if (e.tool === 'my_claims') {
      return text({
        claims: [
          { id: 'mine-here', component_id: 'c-guard', worktree: localWorktree, machine: localMachine },
          { id: 'mine-elsewhere', component_id: 'c-touches', worktree: '/work/swarm-release-manager-touches', machine: HOST },
          ...extraClaims,
        ],
      })
    }

    if (e.tool === 'release_get') {
      return text({
        slug: 'claude-mod',
        config: { release_branch: 'release/claude-mod' },
        components: [
          {
            id: 'c-guard',
            slug: 'guard-mod',
            title: 'Ship marshall-guard',
            notes: 'Goal: keep the store true.\nAcceptance criteria:\n- [ ] the observers work',
            state: componentState,
            topic_branch: 'feat/claude-mod-guard-mod',
            pull_request: pullRequest,
          },
          {
            id: 'c-touches',
            slug: 'live-touches',
            title: 'Record touches',
            notes: '',
            state: 'in_progress',
            topic_branch: 'feat/claude-mod-live-touches',
            pull_request: null,
          },
        ],
      })
    }

    if (e.tool === 'touch_conflicts') {
      return text(switchedOff ? { paths: e.args.paths, conflicts: [], switched_off: true } : { paths: e.args.paths, conflicts: conflicts(e.args) })
    }

    return text({ ok: true })
  })
  on('turn.start', (_, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', (_, e: { sessionId: string }) => ({ sessionId: e.sessionId }) as never)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  on('tool.call', (_, e) => {
    commands.push(String('command' in e ? e.command : e.tool))

    if (bashDenied) {
      return { deny: 'refused by a rule' }
    }

    return bashIsError
      ? ({ result: 'gh: failed', isError: true, text: 'gh: failed' } as never)
      : ({ result: { stdout: '', stderr: '', interrupted: false, ...bashResult } } as never)
  })

  const writes = () => calls.filter(({ tool }) => tool === 'set_component_state' || tool === 'component_update' || tool === 'release_claim')

  const beats = () => calls.filter(({ tool }) => tool === 'heartbeat_claim').map(({ args }) => args.claim)

  const asked = () => calls.filter(({ tool }) => tool === 'touch_conflicts').map(({ args }) => args)

  const recorded = () => calls.filter(({ tool }) => tool === 'record_touches').map(({ args }) => args)

  return { calls, writes, beats, asked, recorded, statuses, toasts, commands, views, periods, failing, thrown }
}

const start = ($: Engine) => $.session.start({ cwd: `${ROOT}/app`, surface: 'terminal', isInteractive: true })

const bash = async ($: Engine, command: string) =>
  (await $.tool.call({ tool: 'Bash', command })) as { deny?: string; context?: readonly string[]; isError?: true }

// ── Opt-in ──────────────────────────────────────────────────────────────────

test('a repo that has not opted in hears nothing: no status, no store call, no refusal', async ($, on) => {
  const { calls, statuses } = engine(on, { highOpen: 2, config: {} })

  await start($)

  expect((await bash($, 'gh pr merge 701 --squash')).deny).toBeUndefined()
  expect(calls).toEqual([])
  expect(statuses).toEqual([])
})

test('a backend other than marshall or srm does not opt in', async ($, on) => {
  const { calls } = engine(on, { config: { [`${ROOT}/.claude/release-config.json`]: JSON.stringify({ state: { backend: 'local' } }) } })

  await start($)

  expect(calls).toEqual([])
})

test('an ancestor .agents/release-config.json with backend srm opts in, like session-start.sh', async ($, on) => {
  const { calls } = engine(on, { config: { [`${ROOT}/.agents/release-config.json`]: JSON.stringify({ state: { backend: 'srm' } }) } })

  await start($)

  expect(calls.some(({ tool }) => tool === 'release_list')).toBe(true)
})

test('an opt-in config over 16 KB is not read, like session-start.sh', async ($, on) => {
  const padded = JSON.stringify({ state: { backend: 'marshall' }, padding: 'x'.repeat(17_000) })
  const { calls } = engine(on, { config: { [`${ROOT}/.claude/release-config.json`]: padded } })

  await start($)

  expect(calls).toEqual([])
})

test('the nearest config wins: a nearer one that does not opt in shadows a farther one that does', async ($, on) => {
  const { calls } = engine(on, {
    config: {
      [`${ROOT}/app/.claude/release-config.json`]: JSON.stringify({ state: { backend: 'local' } }),
      [`${ROOT}/.claude/release-config.json`]: OPTED_IN,
    },
  })

  await start($)

  expect(calls).toEqual([])
})

// ── Heartbeat and status line ───────────────────────────────────────────────

test('the session beats only the claim taken from this checkout, and shows the release', async ($, on) => {
  const { calls, statuses, writes } = engine(on)

  await start($)

  expect(calls.filter(({ tool }) => tool === 'heartbeat_claim').map(({ args }) => args.claim)).toEqual(['mine-here'])
  expect(statuses.at(-1)).toBe('Marshall claude-mod · 1/3 merged · 1 claim held here · 4 findings open')
  expect(writes()).toEqual([])
})

test('a claim on this path taken from another machine is not beaten', async ($, on) => {
  const { calls } = engine(on, { localMachine: 'Other-Mac' })

  await start($)

  expect(calls.filter(({ tool }) => tool === 'heartbeat_claim')).toEqual([])
})

test('with no claim here the release comes from the release/<slug> branch', async ($, on) => {
  const { statuses } = engine(on, { localWorktree: '/elsewhere', branch: 'release/claude-mod', highOpen: 2 })

  await start($)

  expect(statuses.at(-1)).toBe('Marshall claude-mod · 1/3 merged · no claim here · 2 high open')
})

test('the status line counts in words: one finding, two claims', async ($, on) => {
  const { statuses } = engine(on, {
    findingsOpen: 1,
    extraClaims: [{ id: 'mine-too', component_id: 'c-touches', worktree: ROOT, machine: HOST }],
  })

  await start($)

  expect(statuses.at(-1)).toBe('Marshall claude-mod · 1/3 merged · 2 claims held here · 1 finding open')
})

test('an idle session stops beating and says so', async ($, on) => {
  let reads = 0
  const { calls, statuses } = engine(on, { nowAt: () => (reads++ === 0 ? 0 : 31 * 60_000) })

  await start($)

  expect(calls.filter(({ tool }) => tool === 'heartbeat_claim')).toEqual([])
  expect(statuses.at(-1)).toMatch(/idle, not beating$/)
})

test('the heartbeat repeats every 60 s, beating only the claim taken here', async ($, on) => {
  const { beats, periods } = engine(on, { beatPeriods: 1 })

  await start($)

  // The period's beat runs on after the dispatch; let it settle.
  const clock = ($ as unknown as { clock: { now: () => Promise<number> } }).clock

  for (let wait = 0; wait < 50 && beats().length < 2; wait++) {
    await clock.now()
  }

  expect(periods[0]).toBe(60_000)
  expect(beats()).toEqual(['mine-here', 'mine-here'])
})

test('a session idle for 29 minutes still beats', async ($, on) => {
  let reads = 0
  const { beats } = engine(on, { nowAt: () => (reads++ === 0 ? 0 : 29 * 60_000) })

  await start($)

  expect(beats()).toEqual(['mine-here'])
})

test('a beat the store refuses names the allow rule; a lost lease is named', async ($, on) => {
  const { statuses } = engine(on, { failing: { heartbeat_claim: 'permission denied by auto mode' } })

  await start($)

  expect(statuses.at(-1)).toMatch(/1 claim held here · 4 findings open · beat refused: allow its 8 store tools \(plugin README, "Auto mode"\)$/)
})

test('two refused beats make one note', async ($, on) => {
  const { statuses } = engine(on, {
    failing: { heartbeat_claim: 'permission denied by auto mode' },
    extraClaims: [{ id: 'mine-too', component_id: 'c-touches', worktree: ROOT, machine: HOST }],
  })

  await start($)

  expect(statuses.at(-1)?.split('beat refused')).toHaveLength(2)
})

test('a lost lease is named on the status line', async ($, on) => {
  const { statuses } = engine(on, { failing: { heartbeat_claim: 'lease_lost: the claim has expired' } })

  await start($)

  expect(statuses.at(-1)).toMatch(/1 claim held here · 4 findings open · lease lost$/)
})

test('a /clear keeps the session beating; a real end stops it', async ($, on) => {
  const { statuses } = engine(on)

  await start($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  expect(statuses.at(-1)).toMatch(/^Marshall claude-mod/)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's2', resume: { id: 's2' } })

  expect(statuses.at(-1)).toBeUndefined()
})

// ── The merge guard ─────────────────────────────────────────────────────────

test('a merge is refused while the release has an untriaged high finding', async ($, on) => {
  const { commands } = engine(on, { highOpen: 2 })

  await start($)

  expect((await bash($, 'gh pr merge 701 --squash')).deny).toMatch(/claude-mod has 2 untriaged high/)
  expect((await bash($, 'cd /x && gh pr merge 701')).deny).toMatch(/untriaged high/)
  expect((await bash($, 'GH_TOKEN=x gh -R o/r pr merge 701')).deny).toMatch(/untriaged high/)
  expect(commands).toEqual([])
})

test('a merge runs when the release has no untriaged high finding', async ($, on) => {
  const { commands } = engine(on, { highOpen: 0 })

  await start($)

  expect((await bash($, 'gh pr merge 701 --squash')).deny).toBeUndefined()
  expect(commands).toEqual(['gh pr merge 701 --squash'])
})

test('a quoted or heredoc mention of gh pr merge is not a merge', async ($, on) => {
  engine(on, { highOpen: 2 })

  await start($)

  expect((await bash($, 'echo "next: gh pr merge 701"')).deny).toBeUndefined()
  expect((await bash($, "git commit -m 'run gh pr merge 701 after review'")).deny).toBeUndefined()
  expect((await bash($, "git commit -F- <<'EOF'\nthen\ngh pr merge 701\nEOF")).deny).toBeUndefined()
  expect((await bash($, 'echo "first; gh pr merge 701"')).deny).toBeUndefined()
  expect((await bash($, 'echo gh pr merge 701 is next')).deny).toBeUndefined()
  expect((await bash($, 'git fetch; gh pr merge 701')).deny).toMatch(/untriaged high/)
})

test('a guard that cannot read the release lets the merge run and says so', async ($, on) => {
  const { commands, toasts } = engine(on, { highOpen: 2, failing: { release_list: 'store unreachable' } })

  await start($)
  const ran = await bash($, 'gh pr merge 701')

  expect(ran.deny).toBeUndefined()
  expect(commands).toEqual(['gh pr merge 701'])
  expect(toasts.join('\n')).toMatch(/did not check this merge/)
  expect((ran.context ?? []).join('\n')).toMatch(/ran unchecked/)
})

test('with no claim here, a merge is checked against the release its PR targets', async ($, on) => {
  const { commands } = engine(on, { highOpen: 2, localWorktree: '/elsewhere', branch: 'feat/claude-mod-guard-mod' })

  await start($)

  expect((await bash($, 'gh pr merge 701')).deny).toMatch(/claude-mod has 2 untriaged high/)
  expect(commands).toEqual([])
})

test('a merge no Marshall release matches runs, and says it was not checked', async ($, on) => {
  const { commands, toasts } = engine(on, { highOpen: 2, localWorktree: '/elsewhere', pr: { ...openPr, baseRefName: 'main' } })

  await start($)
  const ran = await bash($, 'gh pr merge 701')

  expect(ran.deny).toBeUndefined()
  expect(commands).toEqual(['gh pr merge 701'])
  expect(toasts.join('\n')).toMatch(/no Marshall release matches/)
})

test('an unchecked merge that did not finish still tells the agent it ran unchecked', async ($, on) => {
  engine(on, { highOpen: 2, failing: { release_list: 'store unreachable' }, bashResult: { interrupted: true } })

  await start($)
  const context = ((await bash($, 'gh pr merge 701')).context ?? []).join('\n')

  expect(context).toMatch(/ran unchecked/)
  expect(context).toMatch(/did not record this PR/)
})

// ── Observer: PR opened ─────────────────────────────────────────────────────

test('a gh pr create that succeeds moves the component held here to proposed, with the PR and its files', async ($, on) => {
  const { writes } = engine(on)

  await start($)
  const ran = await bash($, 'gh pr create --base release/claude-mod --title "guard-mod" --body-file /tmp/b.md')

  expect(writes()).toEqual([
    { tool: 'component_update', args: { component: 'c-guard', pull_request: { number: 701, url: 'https://github.com/o/r/pull/701' }, return: 'minimal' } },
    {
      tool: 'set_component_state',
      args: {
        component: 'c-guard',
        state: 'proposed',
        actual_touches: ['CHANGELOG.md', 'resources/plugins/vendors/claude/marshall/hooks/register.ts'],
        return: 'minimal',
      },
    },
  ])
  expect((ran.context ?? []).join('\n')).toMatch(/recorded guard-mod as proposed with pull request #701/)
})

test('a gh pr create that failed records nothing', async ($, on) => {
  const { writes } = engine(on, { bashIsError: true })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
})

test('a gh pr create on a branch that is not the held component\'s topic branch records nothing', async ($, on) => {
  const { writes } = engine(on, { pr: { ...openPr, headRefName: 'feat/something-else' } })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
})

test('a component already proposed is left alone', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed' })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
})

test('a PR opened for a claim taken from another worktree records nothing', async ($, on) => {
  const { writes } = engine(on, { localWorktree: '/elsewhere' })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
})

test('an interrupted gh pr create records nothing and says so', async ($, on) => {
  const { writes } = engine(on, { bashResult: { interrupted: true } })

  await start($)
  const ran = await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
  expect((ran.context ?? []).join('\n')).toMatch(/did not record this PR/)
})

test('a gh pr create that a rule refused records nothing, even with a PR on the branch', async ($, on) => {
  const { writes } = engine(on, { bashDenied: true })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
})

test('the PR is read back for the branch gh pr create named', async ($, on) => {
  const { writes, views } = engine(on, { prs: { 'feat/claude-mod-guard-mod': openPr } })

  await start($)
  await bash($, 'gh pr create -R o/r --head feat/claude-mod-guard-mod --title x')

  expect(views).toEqual([['feat/claude-mod-guard-mod', '-R', 'o/r']])
  expect(writes()[0]?.args.pull_request).toEqual({ number: 701, url: openPr.url })
})

test('gh pr create in the background records nothing and says so', async ($, on) => {
  const { writes } = engine(on, { bashResult: { backgroundTaskId: 'bg1' } })

  await start($)
  const background = await bash($, 'gh pr create --title x')

  expect(writes()).toEqual([])
  expect((background.context ?? []).join('\n')).toMatch(/did not record this PR/)
})

test('gh pr create --web opens a browser, not a PR: nothing is recorded', async ($, on) => {
  const { writes } = engine(on)

  await start($)
  const web = await bash($, 'gh pr create --web')

  expect(writes()).toEqual([])
  expect((web.context ?? []).join('\n')).toMatch(/did not record this PR/)
})

// ── Observer: PR merged ─────────────────────────────────────────────────────

test('a gh pr merge that succeeds for the held component\'s PR moves it to merged with the merge commit', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed', pullRequest: { number: 701, url: openPr.url }, pr: mergedPr })

  await start($)
  const ran = await bash($, 'gh pr merge 701 --merge --delete-branch')

  expect(writes()).toEqual([
    { tool: 'component_update', args: { component: 'c-guard', merge_sha: 'abcdef1234567890abcdef1234567890abcdef12', return: 'minimal' } },
    { tool: 'set_component_state', args: { component: 'c-guard', state: 'merged', return: 'minimal' } },
  ])
  expect((ran.context ?? []).join('\n')).toMatch(/recorded guard-mod as merged at abcdef123456/)
})

test('a merged PR no component here owns changes nothing', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed', pullRequest: { number: 650, url: 'https://github.com/o/r/pull/650' }, pr: mergedPr })

  await start($)
  await bash($, 'gh pr merge 701')

  expect(writes()).toEqual([])
})

test('a queued (--auto) merge that has not merged records nothing', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed', pullRequest: { number: 701, url: openPr.url }, pr: openPr })

  await start($)
  const ran = await bash($, 'gh pr merge 701 --auto')

  expect(writes()).toEqual([])
  expect((ran.context ?? []).join('\n')).toMatch(/not merged yet/)
})

test('a component whose PR was opened before the mod is matched by its topic branch and back-filled', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed', pullRequest: null, pr: mergedPr })

  await start($)
  await bash($, 'gh pr merge')

  expect(writes()[0]).toEqual({
    tool: 'component_update',
    args: { component: 'c-guard', merge_sha: 'abcdef1234567890abcdef1234567890abcdef12', pull_request: { number: 701, url: openPr.url }, return: 'minimal' },
  })
  expect(writes()[1]?.args.state).toBe('merged')
})

test('a gh pr merge of a PR this branch does not own is read back by its own number', async ($, on) => {
  const { writes, views } = engine(on, {
    componentState: 'proposed',
    pullRequest: { number: 701, url: openPr.url },
    prs: { '': mergedPr, '701': mergedPr, '650': { ...mergedPr, number: 650, url: 'https://github.com/o/r/pull/650', headRefName: 'feat/other' } },
  })

  await start($)
  await bash($, 'gh pr merge 650 --squash')

  expect(views.every(asked => asked[0] === '650')).toBe(true)
  expect(writes()).toEqual([])
})

test('a gh pr merge that a rule refused records nothing', async ($, on) => {
  const { writes } = engine(on, { componentState: 'proposed', pullRequest: { number: 701, url: openPr.url }, pr: mergedPr, bashDenied: true })

  await start($)
  await bash($, 'gh pr merge 701')

  expect(writes()).toEqual([])
})

test('the merged PR number the tool result reports is the one recorded', async ($, on) => {
  const { writes } = engine(on, {
    componentState: 'proposed',
    pullRequest: { number: 701, url: openPr.url },
    prs: { '701': mergedPr },
    bashResult: { gitOperation: { pr: { number: 701, action: 'merged' } } },
  })

  await start($)
  await bash($, 'gh pr merge --merge')

  expect(writes()[1]?.args.state).toBe('merged')
})

// ── Observer failures ───────────────────────────────────────────────────────

test('a store write that fails never blocks the command: it is named on the status line, toasted, and handed to the agent', async ($, on) => {
  const { statuses, toasts, commands } = engine(on, { failing: { set_component_state: 'invalid_transition: proposed → proposed' } })

  await start($)
  const ran = await bash($, 'gh pr create --title x')
  const context = (ran.context ?? []).join('\n')

  expect(commands).toEqual(['gh pr create --title x'])
  expect(ran.deny).toBeUndefined()
  expect(ran.isError).toBeUndefined()
  expect(toasts.join('\n')).toMatch(/could not record guard-mod proposed/)
  expect(statuses.at(-1)).toMatch(/not recorded: guard-mod proposed \(#701\)/)
  expect(context).toMatch(/Record it by hand: mcp__plugin_marshall_marshall__set_component_state/)
  expect(context).toMatch(/invalid_transition/)
})

test('a later write that succeeds clears the not-recorded note', async ($, on) => {
  const { statuses, failing } = engine(on, { failing: { set_component_state: 'store unreachable' } })

  await start($)
  await bash($, 'gh pr create --title x')

  expect(statuses.at(-1)).toMatch(/not recorded/)

  delete failing.set_component_state
  await bash($, 'gh pr create --title x')

  expect(statuses.at(-1)).toBe('Marshall claude-mod · 1/3 merged · 1 claim held here · 4 findings open')
})

// ── Compaction ──────────────────────────────────────────────────────────────

test('after a compaction the held claim, its component and its criteria are put back in front of the model', async ($, on) => {
  engine(on)

  await start($)
  const compacted = (await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'work so far', toolUses: [] }] })) as { messages?: readonly { text: string }[] }
  const restored = compacted.messages?.at(-1)?.text ?? ''

  expect(compacted.messages?.length).toBe(2)
  expect(restored).toMatch(/claim mine-here on component guard-mod \(c-guard\)/)
  expect(restored).toMatch(/Acceptance criteria:\n- \[ \] the observers work/)
  expect(restored).not.toMatch(/live-touches/)
})

test('a precompute leaves the compaction as it is', async ($, on) => {
  engine(on)

  await start($)
  const compacted = (await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'work so far', toolUses: [] }] })) as { messages?: readonly unknown[] }

  expect(compacted.messages?.length).toBe(1)
})

test('a subagent\'s compaction is left as it is', async ($, on) => {
  engine(on)

  await start($)
  const compacted = (await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: [{ role: 'user', text: 'work so far', toolUses: [] }] })) as {
    messages?: readonly unknown[]
  }

  expect(compacted.messages?.length).toBe(1)
})

// ── Collision check: before an edit lands ──────────────────────────────────

type Edited = { deny?: string; context?: readonly string[] }

const edit = async ($: Engine, path: string, tool: 'Edit' | 'Write' | 'NotebookEdit' = 'Edit', agentId?: string): Promise<Edited> => {
  const loop = agentId === undefined ? {} : { agentId }
  const input =
    tool === 'NotebookEdit'
      ? { tool, notebook_path: path, new_source: 'x', ...loop }
      : tool === 'Write'
        ? { tool, file_path: path, content: 'x', ...loop }
        : { tool, file_path: path, old_string: 'a', new_string: 'b', ...loop }

  return (await $.tool.call(input as never)) as Edited
}

const turnStart = ($: Engine, turnId = 't1', agentId?: string) => $.turn.start({ text: '', turnId, ...(agentId === undefined ? {} : { agentId }) })

const turnEnd = ($: Engine, turnId = 't1', agentId?: string) =>
  $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId, reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })

const other = (overlap: Partial<{ live: string[]; declared: string[]; reported: string[] }>, extra: Record<string, unknown> = {}) => ({
  claim: 'theirs',
  release: { id: 'r1', version: null, project: 'swarm-release-manager' },
  component: { id: 'c-other', slug: 'other-part', title: 'Other part' },
  holder: 'Pat',
  yours: false,
  agent: 'codex',
  machine: 'Mac-2',
  worktree: '/work/srm-other',
  overlap: { live: [], declared: [], reported: [], ...overlap },
  ...extra,
})

const context = (ran: Edited): string => (ran.context ?? []).join('\n')

test('a repo that has not opted in checks no edit', async ($, on) => {
  const { calls, commands } = engine(on, { config: {}, conflicts: () => [other({ live: ['app/x.php'] })] })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toBeUndefined()
  await turnEnd($)
  expect(calls).toEqual([])
  expect(commands).toEqual(['Edit'])
})

test('an edit asks the store about its file, repo-relative, naming the claim held where the file is', async ($, on) => {
  const { asked } = engine(on)

  await start($)
  await edit($, `${ROOT}/app/./models/../x.php`)

  expect(asked()).toEqual([{ paths: ['app/x.php'], claim: 'mine-here' }])
})

test('an edit no claim on this machine holds is not checked or recorded', async ($, on) => {
  const { asked, recorded, commands } = engine(on, { conflicts: () => [other({ live: ['x'] })] })

  await start($)
  await turnStart($)
  await edit($, '/tmp/scratch/x.php')
  await edit($, `${ROOT}-other/app/x.php`)
  await edit($, `${ROOT}/.git/config`)
  await turnEnd($)

  expect(asked()).toEqual([])
  expect(recorded()).toEqual([])
  expect(commands).toEqual(['Edit', 'Edit', 'Edit'])
})

test('a claim taken on another machine at this path does not hold the file', async ($, on) => {
  const { asked } = engine(on, { localMachine: 'Other-Mac' })

  await start($)
  await edit($, `${ROOT}/app/x.php`)

  expect(asked()).toEqual([])
})

test('an edit in a sibling worktree a claim of this session holds is checked against that claim', async ($, on) => {
  const { asked } = engine(on)

  await start($)
  await edit($, '/work/swarm-release-manager-touches/app/y.php', 'Write')

  expect(asked()).toEqual([{ paths: ['app/y.php'], claim: 'mine-elsewhere' }])
})

test('a symbolic link in the spelling is followed to the worktree', async ($, on) => {
  const { asked } = engine(on, { realPaths: { '/link/app': `${ROOT}/app` } })

  await start($)
  await edit($, '/link/app/x.php')

  expect(asked()).toEqual([{ paths: ['app/x.php'], claim: 'mine-here' }])
})

test('NotebookEdit is checked by its notebook path', async ($, on) => {
  const { asked } = engine(on)

  await start($)
  await edit($, `${ROOT}/notes/a.ipynb`, 'NotebookEdit')

  expect(asked()).toEqual([{ paths: ['notes/a.ipynb'], claim: 'mine-here' }])
})

test('an edit to a file another claim has edited is refused, naming who and how to proceed', async ($, on) => {
  const { commands, toasts } = engine(on, { conflicts: () => [other({ live: ['app/x.php'], declared: ['app/**'] })] })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(commands).toEqual([])
  expect(ran.deny).toMatch(/another claim is already working in app\/x\.php/)
  expect(ran.deny).toMatch(/release claude-mod, component other-part "Other part", agent codex, machine Mac-2, worktree \/work\/srm-other: it has edited this file/)
  expect(ran.deny).toMatch(/Coordinate with that session/)
  expect(ran.deny).toMatch(/revoke_claim it, or release_claim it .*runbook §28.3/)
  expect(ran.deny).toMatch(/wait for that claim to land/)
  expect(toasts.join('\n')).toMatch(/refused an edit to app\/x\.php/)
})

test('an edit to a file another claim changed in its pull request is refused', async ($, on) => {
  const { commands } = engine(on, { conflicts: () => [other({ reported: ['app/x.php'] })] })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toMatch(/changed this file in its pull request/)
  expect(commands).toEqual([])
})

test('a release named by version is named so in the refusal', async ($, on) => {
  engine(on, { conflicts: () => [other({ live: ['app/x.php'] }, { release: { id: 'r9', version: 'v2.0.0', project: 'swarm-release-manager' } })] })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toMatch(/release v2\.0\.0, component other-part/)
})

test('a declared-only overlap lets the edit run and warns once per file, in context and on the status line', async ($, on) => {
  const { commands, statuses } = engine(on, { conflicts: () => [other({ declared: ['app/**'] })] })

  await start($)
  await turnStart($, 't1')
  const first = await edit($, `${ROOT}/app/x.php`)

  expect(first.deny).toBeUndefined()
  expect(context(first)).toMatch(/app\/x\.php is in the declared touches of release claude-mod, component other-part .* has not edited it yet, so the edit ran/)
  expect(statuses.at(-1)).toMatch(/declared elsewhere: app\/x\.php$/)

  expect(context(await edit($, `${ROOT}/app/x.php`))).toBe('')
  await turnStart($, 't2')
  expect(context(await edit($, `${ROOT}/app/x.php`))).toBe('')
  expect(statuses.at(-1)).not.toMatch(/declared elsewhere/)
  expect(context(await edit($, `${ROOT}/app/y.php`))).toMatch(/app\/y\.php is in the declared touches/)
  expect(commands).toEqual(['Edit', 'Edit', 'Edit', 'Edit'])
})

test('a conflict from another project is not a collision', async ($, on) => {
  const { commands } = engine(on, { conflicts: () => [other({ live: ['app/x.php'] }, { release: { id: 'r2', version: null, project: 'swarm-cloud' } })] })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toBe('')
  expect(commands).toEqual(['Edit'])
})

test('another claim taken in this same checkout is this session\'s own, not a collision', async ($, on) => {
  const { commands, asked } = engine(on, {
    extraClaims: [{ id: 'mine-second', component_id: 'c-touches', worktree: ROOT, machine: HOST }],
    conflicts: () => [other({ live: ['app/x.php'] }, { claim: 'mine-second', yours: true, worktree: ROOT, machine: HOST })],
  })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toBeUndefined()
  expect(commands).toEqual(['Edit'])
  // Two claims in one worktree: edits count against the first my_claims lists.
  expect(asked()[0]?.claim).toBe('mine-here')
})

test('a claim at this same path taken on another machine is a collision', async ($, on) => {
  const { commands } = engine(on, {
    extraClaims: [{ id: 'mine-other-mac', component_id: 'c-touches', worktree: ROOT, machine: 'Other-Mac' }],
    conflicts: () => [other({ live: ['app/x.php'] }, { claim: 'mine-other-mac', yours: true, worktree: ROOT, machine: 'Other-Mac' })],
  })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toMatch(/machine Other-Mac, worktree \/work\/swarm-release-manager-guard \(another session of yours\)/)
  expect(commands).toEqual([])
})

test('a worktree nested inside another claim\'s holds its own files', async ($, on) => {
  const { asked, recorded } = engine(on, { extraClaims: [{ id: 'mine-nested', component_id: 'c-touches', worktree: `${ROOT}/.claude/worktrees/sub`, machine: HOST }] })

  await start($)
  await edit($, `${ROOT}/.claude/worktrees/sub/app/x.php`)
  await turnEnd($)

  expect(asked()).toEqual([{ paths: ['app/x.php'], claim: 'mine-nested' }])
  expect(recorded()).toEqual([{ claim: 'mine-nested', paths: ['app/x.php'] }])
})

test('a parallel session of yours in another worktree is a collision', async ($, on) => {
  engine(on, {
    conflicts: () => [other({ live: ['app/x.php'] }, { claim: 'mine-elsewhere', yours: true, worktree: '/work/swarm-release-manager-touches', machine: HOST })],
  })

  await start($)

  expect((await edit($, `${ROOT}/app/x.php`)).deny).toMatch(/worktree \/work\/swarm-release-manager-touches \(another session of yours\)/)
})

test('repeated edits to one file in a turn make one call; a new turn asks again', async ($, on) => {
  const { asked } = engine(on)

  await start($)
  await turnStart($, 't1')
  await edit($, `${ROOT}/app/x.php`)
  await edit($, `${ROOT}/app/x.php`)
  await edit($, `${ROOT}/app/y.php`)

  expect(asked()).toHaveLength(2)

  await turnStart($, 't2')
  await edit($, `${ROOT}/app/x.php`)

  expect(asked()).toHaveLength(3)
})

test('a subagent\'s edits are cached in its own turn', async ($, on) => {
  const { asked } = engine(on)

  await start($)
  await turnStart($, 't1')
  await edit($, `${ROOT}/app/x.php`)
  await turnStart($, 's1', 'a1')
  await edit($, `${ROOT}/app/x.php`, 'Edit', 'a1')
  await edit($, `${ROOT}/app/x.php`, 'Edit', 'a1')
  await edit($, `${ROOT}/app/x.php`)

  expect(asked()).toHaveLength(2)
})

test('a throttled check lets the edit run, says so, and pauses the checks for a minute', async ($, on) => {
  let now = 0
  const { asked, commands, toasts } = engine(on, { nowAt: () => now, failing: { touch_conflicts: '{"error":"too_many_requests","status":429}' } })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toMatch(/did not check this edit against other agents' claims .*429.*; it ran unchecked/)
  expect(toasts.join('\n')).toMatch(/could not check this edit/)

  now = 59_000
  expect(context(await edit($, `${ROOT}/app/y.php`))).toMatch(/checks resume within a minute/)
  expect(asked()).toHaveLength(1)

  now = 61_000
  await edit($, `${ROOT}/app/z.php`)
  expect(asked()).toHaveLength(2)
  expect(commands).toEqual(['Edit', 'Edit', 'Edit'])
})

test('a check whose call fails outright lets the edit run unchecked', async ($, on) => {
  const { commands } = engine(on, { thrown: { touch_conflicts: 'socket hang up' } })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toMatch(/socket hang up\); it ran unchecked/)
  expect(commands).toEqual(['Edit'])
})

test('a check the store cannot be read for lets the edit run, says it was unchecked, and pauses the reads for a minute', async ($, on) => {
  let now = 0
  const { calls, commands } = engine(on, { nowAt: () => now, failing: { release_list: 'store unreachable' } })
  const reads = () => calls.filter(({ tool }) => tool === 'release_list').length

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toMatch(/\(store unreachable\); it ran unchecked/)
  expect(reads()).toBe(2)

  now = 59_000
  expect(context(await edit($, `${ROOT}/app/y.php`))).toMatch(/checks resume within a minute/)
  expect(reads()).toBe(2)

  now = 61_000
  await edit($, `${ROOT}/app/z.php`)
  expect(reads()).toBe(3)
  expect(commands).toEqual(['Edit', 'Edit', 'Edit'])
})

test('unchecked edits are toasted once a turn', async ($, on) => {
  let now = 0
  const { toasts } = engine(on, { nowAt: () => now, failing: { touch_conflicts: 'store unreachable' } })
  const told = () => toasts.filter(toast => /could not check this edit/.test(toast)).length

  await start($)
  await turnStart($, 't1')
  await edit($, `${ROOT}/a.php`)
  await edit($, `${ROOT}/b.php`)

  expect(told()).toBe(1)

  now = 61_000
  await turnStart($, 't2')
  await edit($, `${ROOT}/a.php`)

  expect(told()).toBe(2)
})

test('a refused read names the allow rule in full to the agent, and in short in the toast', async ($, on) => {
  const { toasts } = engine(on, { failing: { touch_conflicts: 'permission denied by auto mode' } })

  await start($)

  expect(context(await edit($, `${ROOT}/app/x.php`))).toMatch(/refused the check; allow .*touch_conflicts, mcp__plugin_marshall_marshall__record_touches\)/)
  expect(toasts.at(-1)).toBe('Marshall could not check this edit against other agents: the store refused the check; allow its 8 store tools (plugin README, "Auto mode")')
})

test('a check the store has switched off lets the edit run and says it ran unchecked', async ($, on) => {
  const { toasts } = engine(on, { switchedOff: true, conflicts: () => [other({ live: ['app/x.php'] })] })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toMatch(/the collision check is switched off in Marshall\); it ran unchecked/)
  expect(toasts.at(-1)).toMatch(/switched off in Marshall/)
})

test('a store that does not answer a check in time lets the edit run unchecked and pauses the checks', async ($, on) => {
  const { asked } = engine(on, { hanging: ['touch_conflicts'] })

  await start($)
  const ran = await edit($, `${ROOT}/app/x.php`)

  expect(ran.deny).toBeUndefined()
  expect(context(ran)).toMatch(/did not answer touch_conflicts within 3 s/)

  await edit($, `${ROOT}/app/y.php`)

  expect(asked()).toHaveLength(1)
})

test('the view a beat read is reused by edits, and read again once the model claims or releases', async ($, on) => {
  const { calls } = engine(on)
  const reads = () => calls.filter(({ tool }) => tool === 'my_claims').length

  await start($)
  await edit($, `${ROOT}/app/x.php`)
  await edit($, `${ROOT}/app/y.php`)

  expect(reads()).toBe(1)

  await $.tool.call({ tool: 'mcp__plugin_marshall_marshall__release_claim', component: 'c-guard' } as never)
  await edit($, `${ROOT}/app/z.php`)

  expect(reads()).toBe(2)
})

test('the files edited in a turn are reported once, when it ends, per claim, sorted', async ($, on) => {
  const { recorded } = engine(on)

  await start($)
  await turnStart($)
  await edit($, `${ROOT}/b.php`)
  await edit($, `${ROOT}/a.php`)
  await edit($, `${ROOT}/b.php`)
  await edit($, '/work/swarm-release-manager-touches/c.php')

  expect(recorded()).toEqual([])

  await turnEnd($)

  expect(recorded()).toEqual([
    { claim: 'mine-here', paths: ['a.php', 'b.php'] },
    { claim: 'mine-elsewhere', paths: ['c.php'] },
  ])

  await turnEnd($, 't2')

  expect(recorded()).toHaveLength(2)
})

test('an edit that was refused or failed is not reported', async ($, on) => {
  const { recorded } = engine(on, { bashIsError: true, conflicts: args => ((args.paths as string[])[0] === 'r.php' ? [other({ live: ['r.php'] })] : []) })

  await start($)
  await edit($, `${ROOT}/r.php`)
  await edit($, `${ROOT}/f.php`)
  await turnEnd($)

  expect(recorded()).toEqual([])
})

test('an edit a rule beneath refused is not reported', async ($, on) => {
  const { recorded, asked } = engine(on, { bashDenied: true })

  await start($)
  await edit($, `${ROOT}/a.php`)
  await turnEnd($)

  expect(asked()).toHaveLength(1)
  expect(recorded()).toEqual([])
})

test('an edit that ran unchecked is still reported', async ($, on) => {
  const { recorded } = engine(on, { failing: { touch_conflicts: 'store unreachable' } })

  await start($)
  await edit($, `${ROOT}/a.php`)
  await turnEnd($)

  expect(recorded()).toEqual([{ claim: 'mine-here', paths: ['a.php'] }])
})

test('a report that fails in passing is sent again at the next turn end', async ($, on) => {
  const { recorded, failing, toasts } = engine(on, { failing: { record_touches: 'store unreachable' } })

  await start($)
  await edit($, `${ROOT}/a.php`)
  await turnEnd($)
  delete failing.record_touches
  await turnEnd($, 't2')

  expect(recorded()).toEqual([
    { claim: 'mine-here', paths: ['a.php'] },
    { claim: 'mine-here', paths: ['a.php'] },
  ])
  expect(toasts).toEqual([])
})

test('a report for a claim that has ended is dropped quietly; a refused one is dropped and said', async ($, on) => {
  const { recorded, failing, toasts } = engine(on, { failing: { record_touches: 'lease_lost: the claim has ended' } })

  await start($)
  await edit($, `${ROOT}/a.php`)
  await turnEnd($)
  delete failing.record_touches
  await turnEnd($, 't2')

  expect(recorded()).toHaveLength(1)
  expect(toasts).toEqual([])

  failing.record_touches = '{"error":"touches_limit_exceeded","scope":"per_claim","limit":500}'
  await edit($, `${ROOT}/b.php`)
  await turnEnd($, 't3')
  delete failing.record_touches
  await turnEnd($, 't4')

  expect(recorded()).toHaveLength(2)
  expect(toasts.join('\n')).toMatch(/could not record the files this claim edited: .*touches_limit_exceeded/)
})

test('more than 100 files are reported in batches of 100', async ($, on) => {
  const { recorded } = engine(on)

  await start($)

  for (let index = 0; index < 101; index++) {
    await edit($, `${ROOT}/f${String(index).padStart(3, '0')}.php`)
  }

  await turnEnd($)

  expect(recorded().map(({ paths }) => (paths as string[]).length)).toEqual([100, 1])
})

test('a file name the store cannot take is neither checked nor reported, and is said to be unchecked', async ($, on) => {
  const { asked, recorded } = engine(on)

  await start($)
  const ran = await edit($, `${ROOT}/what?.md`)
  await turnEnd($)

  expect(context(ran)).toMatch(/it ran unchecked/)
  expect(asked()).toEqual([])
  expect(recorded()).toEqual([])
})

// ── Auto mode: the mod's own calls ──────────────────────────────────────────

test('a Marshall tool call the mod did not make keeps the verdict beneath', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' as const }))

  await start($)

  expect((await $.tool.check({ tool: 'mcp__plugin_marshall_marshall__set_component_state', input: {} })).decision).toBe('ask')
})

test('the mod allows only its own calls, and never over a deny', () => {
  expect(ownCallVerdict('marshall', 'marshall', { decision: 'ask' as const }).decision).toBe('allow')
  expect(ownCallVerdict('engine', 'marshall', { decision: 'ask' as const }).decision).toBe('ask')
  expect(ownCallVerdict('marshall', 'marshall', { decision: 'deny' as const }).decision).toBe('deny')
})
