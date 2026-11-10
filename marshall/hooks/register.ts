import type { EngineInterface, McpToolResult, Register } from 'claude-code'

/**
 * The Marshall mod: keeps this checkout's claims alive, shows the release on
 * the status line, refuses a PR merge the store says should wait, holds an
 * autonomous claim to its part's autonomy level, stops a paused worker, keeps
 * the store true from what the agent actually does, and stops an edit landing
 * in a file another live claim is already editing. Silent in every repo that
 * has not opted into Marshall.
 */

const MARSHALL = 'plugin:marshall:marshall'
const MANIFEST_SERVER = 'marshall'
const TOOL_PREFIX = 'mcp__plugin_marshall_marshall__'
const BEAT_EVERY_MS = 60_000
const IDLE_CUTOFF_MS = 30 * 60_000
const MAX_CONFIG_BYTES = 16_384
const MAX_NOTES_CHARS = 8_000
const VIEW_FRESH_MS = 120_000
const CHECK_BACKOFF_MS = 60_000
/**
 * How long a read or a heartbeat may wait for the store before it counts as
 * failed. The engine's MCP calls carry no timeout and the hook budget stops
 * while one is in flight, so without this a hung store holds an edit until
 * the transport gives up. Writes that record state are not cut short: one that
 * lands late must not be reported as not recorded.
 */
const STORE_WAIT_MS = 3_000
const WAITED_FOR = ['release_list', 'my_claims', 'release_get', 'touch_conflicts', 'heartbeat_claim'] as const
/**
 * The store's own bounds on record_touches: 100 paths a call and 500 a claim
 * (RecordTouchesTool, LiveTouchesService). Files past 500 are not reported;
 * the store would refuse them.
 */
const PATHS_PER_CALL = 100
const PATHS_PER_CLAIM = 500
/** The key the main loop's turn goes by; a subagent's is its agent id. */
const MAIN_LOOP = ''
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const CLAIM_TOOLS = (['claim_component', 'release_claim', 'revoke_claim', 'set_component_state', 'set_component_states'] as const).map(tool => `${TOOL_PREFIX}${tool}` as const)

/**
 * What still runs while a claim is paused: Marshall's reads, the heartbeat
 * (how a resume is learned), handing the claim back (the store allows it),
 * a resume a person asks for (the store decides who may), and loading those
 * deferred tools. Everything else waits for the person.
 */
const PAUSE_EXEMPT = new Set<string>([
  ...[
    'release_get',
    'release_next',
    'release_status',
    'release_list',
    'release_changelog',
    'project_list',
    'my_claims',
    'dispatch_get',
    'lenses_get',
    'lenses_applicable',
    'worker_list',
    'autonomy_get',
    'heartbeat_claim',
    'release_claim',
    'worker_resume',
  ].map(tool => `${TOOL_PREFIX}${tool}`),
  'ToolSearch',
])

/**
 * The store tools this module calls itself, and so the only ones its
 * tool.check hook ever speaks for.
 */
const OWN_TOOLS = [
  'release_list',
  'my_claims',
  'heartbeat_claim',
  'release_get',
  'set_component_state',
  'component_update',
  'touch_conflicts',
  'record_touches',
] as const

const ALLOW_RULE = `allow ${OWN_TOOLS.map(tool => TOOL_PREFIX + tool).join(', ')}`

/**
 * The rule's short form, for the status line and toasts, which cut off long
 * text; the agent's context note carries ALLOW_RULE in full.
 */
const ALLOW_HINT = `allow its ${OWN_TOOLS.length} store tools (plugin README, "Auto mode")`

type ReleaseSummary = {
  id: string
  project: string
  slug: string
  components: { total: number; merged: number }
  findings: { open: number; high_open: number }
  claims: { id: string; component_id: string }[]
}

type Claim = {
  id: string
  component_id: string
  worktree: string | null
  machine?: string | null
  mode?: string
  paused_at?: string | null
  paused_by?: { display_name?: string } | null
}

type Setting = { value?: string | null; source?: string | null }

type Policy = { level?: Setting; merge_to_main?: Setting }

type Autonomy = { enabled?: boolean; policy?: Policy; approval?: { head_sha?: string | null } | null } | null

type Component = {
  id: string
  slug: string
  title: string
  notes: string | null
  state: string
  topic_branch: string | null
  pull_request: { number: number | null; url: string | null } | null
  autonomy?: Autonomy
}

type ReleaseDocument = {
  slug: string
  config: { release_branch?: string }
  components: Component[]
  autonomy?: Autonomy
  dispatch_runs?: { closed_at?: string | null }[]
}

type Checkout = { root: string; branch: string }

type Seen = { place: Checkout; releases: ReleaseSummary[]; claims: Claim[]; localClaims: Claim[]; release: ReleaseSummary | undefined }

type Held = { claim: Claim; release: ReleaseSummary; component: Component; releaseBranch: string | undefined; document: ReleaseDocument }

/** Who paused a claim and when, as the store said it. */
type Pause = { by: string | undefined; at: string | undefined; part: string | undefined }

/** A guard's refusal: what the agent reads, and a short line for the toast. */
type Denial = { deny: string; toast: string }

/** A refusal's JSON body: `{error, message, ...detail}`. */
type Refusal = { error?: unknown; paused_by?: { display_name?: string } | null; paused_at?: string | null; component?: { slug?: string | null } | null }

type PullRequest = { number: number; url: string; state: string; headRefName: string; baseRefName: string; mergeCommit: { oid: string } | null }

type GhCall = { verb: 'merge' | 'create'; selector: string | undefined; repo: string | undefined; head: string | undefined; isWeb: boolean }

type Write = { tool: (typeof OWN_TOOLS)[number]; args: Record<string, unknown> }

type View = { releases: ReleaseSummary[]; claims: Claim[] }

type Conflict = {
  claim: string
  release: { id: string; version: string | null; project: string }
  component: { id: string; slug: string; title: string }
  yours: boolean
  agent: string | null
  machine: string | null
  worktree: string | null
  overlap: { live: string[]; declared: string[]; reported: string[] }
}

/**
 * Where an edit lands: the claim on this machine whose worktree holds the
 * file, that claim's release, and the file's path inside the worktree.
 */
type Target = { claim: Claim; worktree: string; release: ReleaseSummary; path: string; file: string }

type Verdict = { refuse: string } | { declared: string } | { clear: true }

/**
 * Module variables start over on a reload, which also runs session.start
 * again (it re-reads the opt-in and re-arms the heartbeat); the status-line
 * notes and the activity clock start empty.
 */
let optedIn = false
let server = MARSHALL
let host: string | undefined
let lastActivityAt = 0
let callsInFlight = 0
let notRecorded: string | undefined
let lastLine: string | undefined
let timer: { cancel: () => void } | undefined
let lastView: { view: View; at: number } | undefined
let declaredNote: string | undefined
let checkPausedUntil = 0
let uncheckedToasted = false
let lastRoot: string | undefined
const checked = new Map<string, Map<string, Verdict>>()
const warned = new Set<string>()
const pending = new Map<string, Set<string>>()
/** The claims a person has paused, by claim id; kept to the claims still live. */
const pauses = new Map<string, Pause>()
/** The claims each loop beat or took itself, so a pause stops only that loop. */
const loopClaims = new Map<string, Set<string>>()
const pauseToasted = new Set<string>()

/**
 * Reads a Marshall tool's JSON answer out of its first text block.
 */
const parse = <T>(result: McpToolResult): T => {
  const block = result.content.find(content => content.type === 'text')
  const text = block?.type === 'text' ? block.text : undefined

  if (result.isError || text === undefined) {
    throw new Error(text ?? 'Marshall returned no text')
  }

  return JSON.parse(text) as T
}

const call = async <T>($: EngineInterface, tool: (typeof OWN_TOOLS)[number], args?: Record<string, unknown>): Promise<T> => {
  const answer = $.mcp.call(server, tool, args)

  if (!(WAITED_FOR as readonly string[]).includes(tool)) {
    return parse<T>(await answer)
  }

  const stop = new AbortController()
  const late = $.clock.sleep(STORE_WAIT_MS, { signal: stop.signal }).then(
    () => Promise.reject(new Error(`the store did not answer ${tool} within ${STORE_WAIT_MS / 1000} s`)),
    () => new Promise<never>(() => {}),
  )

  try {
    return parse<T>(await Promise.race([answer, late]))
  } finally {
    stop.abort()
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const errorText = (error: unknown): string => messageOf(error).slice(0, 200)

/**
 * The JSON object a store answer carries, from its whole text (an answer or
 * an error body): a worker_paused body runs past what errorText keeps.
 */
const jsonBodyOf = (text: string | undefined): Record<string, unknown> | undefined => {
  const at = text?.indexOf('{') ?? -1

  if (text === undefined || at < 0) {
    return undefined
  }

  try {
    const body = JSON.parse(text.slice(at)) as unknown

    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const refusalOf = (text: string | undefined): Refusal | undefined => jsonBodyOf(text) as Refusal | undefined

/**
 * The one writer of the pause state: a pause is marked from a worker_paused
 * refusal or a my_claims row (keeping what an earlier read knew that this one
 * does not), and cleared by a beat that ran, a row read unpaused, the claim
 * ending, or a read that failed (fail open).
 */
const markPaused = (id: string, seen: { by?: string | null; at?: string | null; part?: string | null }): void => {
  const known = pauses.get(id)

  pauses.set(id, { by: seen.by ?? known?.by, at: seen.at ?? known?.at, part: seen.part ?? known?.part })
}

const clearPause = (id: string): void => {
  pauses.delete(id)
  pauseToasted.delete(id)
}

const clearPauses = (): void => {
  for (const id of [...pauses.keys()]) {
    clearPause(id)
  }
}

const markRefused = (id: string, refusal: Refusal): void =>
  markPaused(id, { by: refusal.paused_by?.display_name, at: refusal.paused_at, part: refusal.component?.slug })

/**
 * Keeps the pauses to the claims my_claims still lists: a stopped, revoked,
 * released or lapsed claim is gone, and so is its pause.
 */
const syncPauses = (claims: Claim[]): void => {
  const live = new Set(claims.map(claim => claim.id))

  for (const id of [...pauses.keys()]) {
    if (!live.has(id)) {
      clearPause(id)
    }
  }

  for (const ids of loopClaims.values()) {
    for (const id of [...ids]) {
      if (!live.has(id)) {
        ids.delete(id)
      }
    }
  }

  for (const claim of claims) {
    if (typeof claim.paused_at === 'string') {
      markPaused(claim.id, { by: claim.paused_by?.display_name, at: claim.paused_at })
    } else if (claim.paused_at === null) {
      clearPause(claim.id)
    }
  }
}

const pausedText = (pause: Pause): string =>
  [
    `Marshall: your claim${pause.part === undefined ? '' : ` on ${pause.part}`} is paused${pause.by === undefined ? '' : ` by ${pause.by}`}${pause.at === undefined ? '' : ` at ${pause.at}`}.`,
    'Stop work now: do not retry in a loop or route around this. Reads of Marshall and the heartbeat still run.',
    'Wait for the person to resume it (the Workers screen in Marshall; for a supervised claim of your own, worker_resume on their word), or hand the claim back with release_claim.',
  ].join(' ')

const looksRefused = (message: string): boolean => /permission|not allowed|denied|refused|classifier|auto mode/i.test(message)

const run = async ($: EngineInterface, argv: string[]): Promise<string | undefined> => {
  const ran = await $.process.run(argv)

  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

/**
 * The same opt-in session-start.sh makes: the nearest ancestor's
 * .claude/release-config.json, else .agents/release-config.json, setting
 * state.backend to "marshall" (or the older "srm").
 */
const readOptIn = async ($: EngineInterface): Promise<boolean> => {
  let directory = await $.session.cwd()

  for (;;) {
    for (const candidate of ['.claude/release-config.json', '.agents/release-config.json']) {
      const text = await $.fs.read(`${directory === '/' ? '' : directory}/${candidate}`).catch(() => undefined)

      if (text !== undefined) {
        if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
          return false
        }

        try {
          const backend = (JSON.parse(text) as { state?: { backend?: unknown } } | null)?.state?.backend

          return backend === 'marshall' || backend === 'srm'
        } catch {
          return false
        }
      }
    }

    if (directory === '/' || directory === '') {
      return false
    }

    directory = directory.slice(0, directory.lastIndexOf('/')) || '/'
  }
}

const readHost = async ($: EngineInterface): Promise<string | undefined> =>
  (await run($, ['scutil', '--get', 'LocalHostName']).catch(() => undefined)) || (await run($, ['hostname', '-s']).catch(() => undefined)) || undefined

const checkout = async ($: EngineInterface): Promise<Checkout | undefined> => {
  const root = await run($, ['git', 'rev-parse', '--show-toplevel'])
  const branch = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])

  return root === undefined || branch === undefined ? undefined : { root, branch }
}

/**
 * A claim taken here: its worktree is this checkout and, when it names one,
 * its machine is this one.
 */
const onThisMachine = (claim: Claim): boolean => host === undefined || claim.machine === undefined || claim.machine === null || claim.machine === host

const isLocal = (claim: Claim, root: string): boolean => claim.worktree === root && onThisMachine(claim)

const releaseByBranch = (releases: ReleaseSummary[], branch: string | undefined, root: string): ReleaseSummary | undefined => {
  const slug = branch?.startsWith('release/') ? branch.slice('release/'.length) : undefined
  const named = releases.filter(release => release.slug === slug)
  const project = root.split('/').pop()

  return named.find(release => release.project === project) ?? (named.length === 1 ? named[0] : undefined)
}

/**
 * The release this checkout works on: the one holding a claim taken from
 * this worktree, else the one its `release/<slug>` branch names.
 */
const currentRelease = (releases: ReleaseSummary[], localClaims: Claim[], { root, branch }: Checkout): ReleaseSummary | undefined => {
  const ids = new Set(localClaims.map(claim => claim.id))

  return releases.find(release => release.claims.some(claim => ids.has(claim.id))) ?? releaseByBranch(releases, branch, root)
}

/**
 * The releases in flight and every claim this actor holds, kept for the edit
 * check so an edit does not read them again.
 */
const readView = async ($: EngineInterface): Promise<View> => {
  const { releases } = await call<{ releases: ReleaseSummary[] }>($, 'release_list')
  const { claims } = await call<{ claims: Claim[] }>($, 'my_claims')

  syncPauses(claims)
  lastView = { view: { releases, claims }, at: await $.clock.now() }

  return { releases, claims }
}

/**
 * Reads the store once for the status line, the guard and the observers.
 */
const look = async ($: EngineInterface): Promise<Seen | undefined> => {
  const place = await checkout($)

  if (place === undefined) {
    return undefined
  }

  const { releases, claims } = await readView($)
  const localClaims = claims.filter(claim => isLocal(claim, place.root))

  lastRoot = place.root

  return { place, releases, claims, localClaims, release: currentRelease(releases, localClaims, place) }
}

/**
 * The components held from this checkout (or the given claims), each with
 * its release.
 */
const held = async ($: EngineInterface, seen: Seen, claims: Claim[] = seen.localClaims): Promise<Held[]> => {
  const found: Held[] = []
  const documents = new Map<string, ReleaseDocument>()

  for (const claim of claims) {
    const release = seen.releases.find(candidate => candidate.claims.some(owned => owned.id === claim.id))

    if (release === undefined) {
      continue
    }

    const document =
      documents.get(release.id) ?? (await call<ReleaseDocument>($, 'release_get', { project: release.project, release: release.slug, view: 'full' }))
    documents.set(release.id, document)
    const component = document.components.find(candidate => candidate.id === claim.component_id)

    if (component !== undefined) {
      found.push({ claim, release, component, releaseBranch: document.config.release_branch, document })
    }
  }

  return found
}

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const describe = (release: ReleaseSummary, holding: number): string =>
  [
    `Marshall ${release.slug}`,
    `${release.components.merged}/${release.components.total} merged`,
    holding > 0 ? `${counted(holding, 'claim')} held here` : 'no claim here',
    release.findings.high_open > 0 ? `${release.findings.high_open} high open` : `${counted(release.findings.open, 'finding')} open`,
  ].join(' · ')

const withNotes = (line: string | undefined, notes: string[]): string | undefined => {
  const all = [...notes, ...(notRecorded === undefined ? [] : [`not recorded: ${notRecorded}`]), ...(declaredNote === undefined ? [] : [declaredNote])]

  return line === undefined && all.length === 0 ? undefined : [line ?? 'Marshall', ...all].join(' · ')
}

/**
 * Beats only the claims taken from this checkout, and only while someone is
 * working here: an abandoned session lets its leases lapse. Never releases.
 */
const beat = async ($: EngineInterface): Promise<void> => {
  const seen = await look($)

  if (seen === undefined) {
    $.ui.status(withNotes(undefined, []))

    return
  }

  const isIdle = callsInFlight === 0 && (await $.clock.now()) - lastActivityAt > IDLE_CUTOFF_MS
  const notes: string[] = []

  if (!isIdle) {
    for (const claim of seen.localClaims) {
      try {
        await call($, 'heartbeat_claim', { claim: claim.id })
        clearPause(claim.id)
      } catch (error) {
        const refusal = refusalOf(messageOf(error))
        const message = errorText(error)

        if (refusal?.error === 'worker_paused') {
          markRefused(claim.id, refusal)

          continue
        }

        notes.push(looksRefused(message) ? `beat refused: ${ALLOW_HINT}` : /lease_lost/.test(message) ? 'lease lost' : `beat failed: ${message.slice(0, 60)}`)
      }
    }
  } else if (seen.localClaims.length > 0) {
    notes.push('idle, not beating')
  }

  for (const claim of seen.localClaims) {
    const pause = pauses.get(claim.id)

    if (pause !== undefined) {
      notes.push(pause.by === undefined ? 'paused' : `paused by ${pause.by}`)
    }
  }

  lastLine = seen.release === undefined ? undefined : describe(seen.release, seen.localClaims.length)
  $.ui.status(withNotes(lastLine, [...new Set(notes)]))
}

/**
 * A beat that could not read the store says so on the status line. A pause
 * it can no longer confirm is lifted (fail open, like every check here): the
 * store still refuses a paused worker's writes, and a resume made while the
 * store was out of reach would otherwise never be seen.
 */
const beatQuietly = ($: EngineInterface): Promise<void> =>
  beat($).catch(error => {
    const message = errorText(error)
    const unchecked = pauses.size > 0 ? ' · pause unchecked' : ''

    clearPauses()
    $.ui.status(looksRefused(message) ? `Marshall refused: ${ALLOW_HINT}${unchecked}` : `Marshall unreachable: ${message.slice(0, 80)}${unchecked}`)
  })

const arm = ($: EngineInterface): void => {
  timer?.cancel()
  timer = $.clock.every(BEAT_EVERY_MS, () => {
    void beatQuietly($)
  })
}

/**
 * Removes heredoc bodies and quoted text, so only what the shell runs as a
 * command is left to match.
 */
const unquoted = (command: string): string =>
  command
    .replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')

const WRAPPERS = new Set(['command', 'env', 'exec', 'time', 'nohup'])

/**
 * Finds `gh pr merge` / `gh pr create` at a command position: the start of a
 * segment between shell separators, past env assignments and wrappers, with
 * gh's own `-R`/`--repo` allowed before `pr`.
 */
const ghPr = (command: string): GhCall | undefined => {
  for (const segment of unquoted(command).split(/;|&&|\|\||\||&|\n|\$\(|`|\(|\)/)) {
    const words = segment.trim().split(/\s+/).filter(word => word !== '')
    let at = 0

    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || WRAPPERS.has(words[at] ?? ''))) {
      at++
    }

    if ((words[at] ?? '').split('/').pop() !== 'gh') {
      continue
    }

    at++
    let repo: string | undefined

    while (words[at] === '-R' || words[at] === '--repo' || words[at]?.startsWith('--repo=')) {
      repo = words[at]?.startsWith('--repo=') ? words[at]?.slice('--repo='.length) : words[at + 1]
      at += words[at]?.startsWith('--repo=') ? 1 : 2
    }

    const verb = words[at + 1]

    if (words[at] !== 'pr' || (verb !== 'merge' && verb !== 'create')) {
      continue
    }

    const rest = words.slice(at + 2)
    let head: string | undefined

    for (const [index, word] of rest.entries()) {
      if (word === '-R' || word === '--repo') {
        repo = rest[index + 1]
      } else if (word.startsWith('--repo=')) {
        repo = word.slice('--repo='.length)
      } else if (word === '-H' || word === '--head') {
        head = rest[index + 1]
      } else if (word.startsWith('--head=')) {
        head = word.slice('--head='.length)
      }
    }

    return {
      verb,
      selector: verb === 'merge' ? rest.find(word => /^\d+$/.test(word) || /\/pull\/\d+/.test(word)) : undefined,
      repo,
      head,
      isWeb: rest.includes('--web') || rest.includes('-w'),
    }
  }

  return undefined
}

const viewPr = async ($: EngineInterface, gh: GhCall, selector: string | undefined): Promise<PullRequest | undefined> => {
  const argv = ['gh', 'pr', 'view', ...(selector === undefined ? [] : [selector]), ...(gh.repo === undefined ? [] : ['-R', gh.repo])]
  const out = await run($, [...argv, '--json', 'number,url,state,headRefName,baseRefName,mergeCommit']).catch(() => undefined)

  try {
    return out === undefined ? undefined : (JSON.parse(out) as PullRequest)
  } catch {
    return undefined
  }
}

const byHand = (writes: Write[]): string => writes.map(({ tool, args }) => `${TOOL_PREFIX}${tool} ${JSON.stringify(args)}`).join(', then ')

/**
 * Makes the writes in order. A failure stops the rest: it is named on the
 * status line and in a toast, and the agent is told what to record by hand.
 * Never throws: an observer must not block the command it watched.
 */
const record = async ($: EngineInterface, what: string, writes: Write[], done: string): Promise<string> => {
  for (const [index, write] of writes.entries()) {
    try {
      await call($, write.tool, write.args)
    } catch (error) {
      const message = errorText(error)

      notRecorded = what
      $.ui.toast(`Marshall could not record ${what}: ${message.slice(0, 100)}`)
      $.ui.status(withNotes(lastLine, []))

      return `Marshall could not record ${what}; the store said: ${message}${looksRefused(message) ? ` (auto mode: ${ALLOW_RULE})` : ''}. Record it by hand: ${byHand(writes.slice(index))}.`
    }
  }

  notRecorded = undefined
  $.ui.status(withNotes(lastLine, []))

  return done
}

const changedFiles = async ($: EngineInterface, releaseBranch: string | undefined): Promise<string[] | undefined> => {
  if (releaseBranch === undefined) {
    return undefined
  }

  for (const base of [`origin/${releaseBranch}`, releaseBranch]) {
    const out = await run($, ['git', 'diff', '--name-only', `${base}...HEAD`]).catch(() => undefined)

    if (out !== undefined) {
      return [...new Set(out.split('\n').filter(path => path !== ''))].sort()
    }
  }

  return undefined
}

/**
 * After a `gh pr create` that succeeded: the component held here whose topic
 * branch the new PR is on moves to `proposed`, carrying the PR and the files
 * the branch changed against the release branch.
 */
const observeCreate = async ($: EngineInterface, gh: GhCall): Promise<string | undefined> => {
  const seen = await look($)

  if (seen === undefined || seen.localClaims.length === 0) {
    return undefined
  }

  const pr = await viewPr($, gh, gh.head)

  if (pr === undefined || pr.state !== 'OPEN') {
    return undefined
  }

  const mine = (await held($, seen)).find(({ component }) => component.topic_branch === pr.headRefName)

  if (mine === undefined || ['proposed', 'merged', 'cancelled'].includes(mine.component.state)) {
    return undefined
  }

  const touches = await changedFiles($, mine.releaseBranch)
  const id = mine.component.id

  return record(
    $,
    `${mine.component.slug} proposed (#${pr.number})`,
    [
      { tool: 'component_update', args: { component: id, pull_request: { number: pr.number, url: pr.url }, return: 'minimal' } },
      { tool: 'set_component_state', args: { component: id, state: 'proposed', ...(touches === undefined ? {} : { actual_touches: touches }), return: 'minimal' } },
    ],
    `Marshall recorded ${mine.component.slug} as proposed with pull request #${pr.number} (${pr.url})${touches === undefined ? '' : ` and ${touches.length} changed file(s)`}. It is already written: do not call set_component_state proposed or component_update pull_request for it again.`,
  )
}

/**
 * After a `gh pr merge` that succeeded for a PR a component held here owns:
 * the component moves to `merged` with its merge commit, which is what
 * unblocks its dependents. A queued (`--auto`) merge is not a merge yet.
 */
const observeMerge = async ($: EngineInterface, gh: GhCall, before: PullRequest | undefined, reported: number | undefined): Promise<string | undefined> => {
  const number = reported ?? before?.number

  if (number === undefined) {
    return undefined
  }

  const pr = await viewPr($, gh, String(number))

  if (pr === undefined || pr.state !== 'MERGED' || pr.mergeCommit === null) {
    return pr?.state === 'OPEN' ? `Marshall did not record a merge: #${number} is not merged yet (queued?). Mark its component merged once GitHub merges it.` : undefined
  }

  const seen = await look($)

  if (seen === undefined || seen.localClaims.length === 0) {
    return undefined
  }

  const mine = (await held($, seen)).find(({ component }) =>
    component.pull_request?.number != null ? component.pull_request.number === pr.number : component.topic_branch === pr.headRefName,
  )

  if (mine === undefined || ['merged', 'cancelled'].includes(mine.component.state)) {
    return undefined
  }

  const id = mine.component.id
  const sha = pr.mergeCommit.oid

  return record(
    $,
    `${mine.component.slug} merged (#${pr.number})`,
    [
      {
        tool: 'component_update',
        args: { component: id, merge_sha: sha, ...(mine.component.pull_request?.number != null ? {} : { pull_request: { number: pr.number, url: pr.url } }), return: 'minimal' },
      },
      { tool: 'set_component_state', args: { component: id, state: 'merged', return: 'minimal' } },
    ],
    `Marshall recorded ${mine.component.slug} as merged at ${sha.slice(0, 12)} (pull request #${pr.number}). It is already written: do not call set_component_state merged or component_update merge_sha for it again.`,
  )
}

/**
 * Whether the store's autonomy rules bind this held part: the claim is
 * autonomous and the workspace has autonomy on. A store that reports neither
 * (older than autonomy) binds nothing, and nor does a supervised claim.
 */
const isGated = (work: Held): boolean => work.claim.mode === 'autonomous' && work.document.autonomy?.enabled === true

const levelOf = (work: Held): Setting | undefined => work.component.autonomy?.policy?.level

const fromLayer = (setting: Setting | undefined): string => (setting?.source ? ` (set on the ${setting.source})` : '')

/**
 * The part a held claim on this Mac owns that the PR or branch belongs to:
 * any worktree on this machine, so a subagent working a sibling worktree is
 * held to its own part's level.
 */
const onMachine = (seen: Seen): Claim[] => seen.claims.filter(onThisMachine)

/**
 * Before `gh pr create`: an autonomous claim at level suggest reports back
 * instead of opening a pull request.
 */
const guardCreate = async ($: EngineInterface, gh: GhCall): Promise<Denial | { unchecked: string } | undefined> => {
  const seen = await look($)

  if (seen === undefined) {
    return undefined
  }

  const branch = (gh.head ?? seen.place.branch).split(':').pop()
  const work = (await held($, seen, onMachine(seen))).find(({ component }) => component.topic_branch === branch)

  if (work === undefined || !isGated(work) || levelOf(work)?.value !== 'suggest') {
    return undefined
  }

  return {
    deny: `Marshall: ${work.component.slug} is at autonomy level suggest${fromLayer(levelOf(work))} and this claim is autonomous, so it reports back instead of opening a pull request. Write up what you found and stop; a person decides what lands.`,
    toast: `Marshall held a pull request: ${work.component.slug} is at level suggest`,
  }
}

/**
 * Marshall's own guard: a merge waits while the release has untriaged high
 * findings (release-wide, as findings carry no PR). For an autonomous claim it
 * also waits for a person: a part's PR at level suggest or at pr_and_wait
 * with no approval, and the release PR while its merge to main needs a person
 * and nobody has approved it.
 */
const guardMerge = async ($: EngineInterface, before: PullRequest | undefined): Promise<Denial | { unchecked: string } | undefined> => {
  const seen = await look($)

  if (seen === undefined) {
    return { unchecked: 'not a git checkout' }
  }

  const release = seen.release ?? releaseByBranch(seen.releases, before?.baseRefName, seen.place.root)

  if (release === undefined) {
    return { unchecked: 'no Marshall release matches this checkout or the PR' }
  }

  if (release.findings.high_open > 0) {
    return {
      deny: `Marshall: ${release.slug} has ${release.findings.high_open} untriaged high finding(s). Fix, accept or defer them before merging.`,
      toast: `Marshall held a merge: ${release.slug} has untriaged high findings`,
    }
  }

  if (before === undefined) {
    return undefined
  }

  const work = (await held($, seen, onMachine(seen))).find(({ component }) =>
    component.pull_request?.number != null ? component.pull_request.number === before.number : component.topic_branch === before.headRefName,
  )

  if (work !== undefined && isGated(work)) {
    const level = levelOf(work)

    if (level?.value === 'suggest') {
      return {
        deny: `Marshall: ${work.component.slug} is at autonomy level suggest${fromLayer(level)} and this claim is autonomous: it does not land. Report back and stop.`,
        toast: `Marshall held a merge: ${work.component.slug} is at level suggest`,
      }
    }

    if (level?.value === 'pr_and_wait' && (work.component.autonomy?.approval ?? null) === null) {
      return {
        deny: `Marshall: ${work.component.slug} is at autonomy level pr_and_wait${fromLayer(level)} and no person has approved its merge. Leave the PR open and the part proposed: a person must click Approve merge for the part on the release page in Marshall. Once they have, merge with --match-head-commit set to the head the approval names, if it names one.`,
        toast: `Marshall held a merge: ${work.component.slug} waits for a person's approval`,
      }
    }
  }

  const releasePr = releaseByBranch(seen.releases, before.headRefName, seen.place.root)

  if (releasePr === undefined) {
    return undefined
  }

  const document = await call<ReleaseDocument>($, 'release_get', { project: releasePr.project, release: releasePr.slug, view: 'full' })
  const autonomy = document.autonomy
  const isDriven = (document.dispatch_runs ?? []).some(run => run.closed_at === null || run.closed_at === undefined)

  if (autonomy?.enabled === true && isDriven && autonomy.policy?.merge_to_main?.value === 'person' && (autonomy.approval ?? null) === null) {
    return {
      deny: `Marshall: ${releasePr.slug}'s merge to main needs a person${fromLayer(autonomy.policy.merge_to_main)}, an autonomous run is open on it, and no person has approved the release. Stop: a person must click Approve merge on the release page in Marshall, or merge it themselves.`,
      toast: `Marshall held a merge: ${releasePr.slug} needs a person to merge to main`,
    }
  }

  return undefined
}

const heldWorkText = async ($: EngineInterface): Promise<string | undefined> => {
  const seen = await look($)

  if (seen === undefined) {
    return undefined
  }

  const work = await held($, seen)

  if (work.length === 0) {
    return undefined
  }

  return [
    'Marshall, after the compaction: this session holds these claims, taken from this checkout. Keep working the same component; the mod keeps the claim beating.',
    ...work.map(({ claim, release, component }) =>
      [
        `- claim ${claim.id} on component ${component.slug} (${component.id}) "${component.title}", release ${release.slug} (project ${release.project}), state ${component.state}, worktree ${seen.place.root}.`,
        `  Plan of record (goal and acceptance criteria):\n${(component.notes ?? '(none)').slice(0, MAX_NOTES_CHARS)}`,
      ].join('\n'),
    ),
  ].join('\n')
}

/**
 * Folds `.`, `..` and repeated separators out of an absolute path.
 */
const lexical = (path: string): string => {
  const parts: string[] = []

  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

/**
 * Whether the store takes the path as a touch: record_touches refuses a glob
 * (`*`, `?`) or a control character (LiveTouchesService::normalise).
 */
const storeTakesPath = (path: string): boolean =>
  ![...path].some(character => character === '*' || character === '?' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/**
 * The claim on this machine whose worktree holds the file: the deepest one,
 * at a path-segment boundary. A file inside `.git` is nobody's edit.
 */
const holderOf = (claims: Claim[], file: string): { claim: Claim; worktree: string; path: string } | undefined => {
  let found: { claim: Claim; worktree: string; path: string } | undefined

  for (const claim of claims) {
    const worktree = claim.worktree === null ? undefined : lexical(claim.worktree)

    if (worktree === undefined || !onThisMachine(claim) || !file.startsWith(`${worktree}/`) || (found !== undefined && found.worktree.length >= worktree.length)) {
      continue
    }

    found = { claim, worktree, path: file.slice(worktree.length + 1) }
  }

  return found === undefined || found.path === '.git' || found.path.startsWith('.git/') ? undefined : found
}

/**
 * Where the edited file lands: its own spelling first, then the real path of
 * its folder (a symbolic link in the spelling). A folder not there yet keeps
 * the spelling.
 */
const targetOf = async ($: EngineInterface, view: View, given: string): Promise<Target | undefined> => {
  const file = lexical(given.startsWith('/') ? given : `${await $.session.cwd()}/${given}`)
  const cut = file.lastIndexOf('/')
  let holding = holderOf(view.claims, file)

  if (holding === undefined) {
    const folder = await $.fs.stat(file.slice(0, cut) || '/', { resolve: true }).catch(() => undefined)

    holding = folder?.realPath === undefined ? undefined : holderOf(view.claims, lexical(`${folder.realPath}/${file.slice(cut + 1)}`))
  }

  if (holding === undefined) {
    return undefined
  }

  const { claim } = holding
  const release = view.releases.find(candidate => candidate.claims.some(owned => owned.id === claim.id))

  return release === undefined ? undefined : { ...holding, release, file }
}

const releaseName = (view: View, conflict: Conflict): string =>
  view.releases.find(release => release.id === conflict.release.id)?.slug ?? conflict.release.version ?? conflict.release.id

const holderText = (view: View, conflict: Conflict): string =>
  [
    `release ${releaseName(view, conflict)}`,
    `component ${conflict.component.slug} "${conflict.component.title}"`,
    `agent ${conflict.agent ?? 'unknown'}`,
    `machine ${conflict.machine ?? 'unknown'}`,
    `worktree ${conflict.worktree ?? 'unknown'}`,
  ].join(', ') + (conflict.yours ? ' (another session of yours)' : '')

/**
 * The store's answer, read for this edit: another claim of this project that
 * has edited the file (live) or changed it in its pull request (reported)
 * refuses it; one that only declared it warns. Claims taken in the same
 * checkout are this session's own, and another project's same relative path
 * is not this file.
 */
const verdictOf = (view: View, target: Target, conflicts: Conflict[]): Verdict => {
  const others = conflicts.filter(
    conflict =>
      conflict.release.project === target.release.project &&
      !view.claims.some(claim => claim.id === conflict.claim && claim.worktree !== null && lexical(claim.worktree) === target.worktree && onThisMachine(claim)),
  )
  const hard = others.filter(conflict => conflict.overlap.live.length > 0 || conflict.overlap.reported.length > 0)

  if (hard.length > 0) {
    return {
      refuse: [
        `Marshall refused this edit: another claim is already working in ${target.path}.`,
        ...hard.map(conflict => `- ${holderText(view, conflict)}: it has ${conflict.overlap.live.length > 0 ? 'edited this file' : 'changed this file in its pull request'}.`),
        'Coordinate with that session before you change this file, or wait for that claim to land (merged, or its claim released) and edit it then. Do not route the change around this check.',
        'If that claim looks abandoned (no heartbeat in release_status), tell the user: they can revoke_claim it, or release_claim it if it is their own finished session (operator runbook §28.3).',
      ].join('\n'),
    }
  }

  const soft = others.filter(conflict => conflict.overlap.declared.length > 0)

  return soft.length > 0
    ? {
        declared: `Marshall: ${target.path} is in the declared touches of ${soft.map(conflict => holderText(view, conflict)).join('; ')}. That claim has not edited it yet, so the edit ran; coordinate if your change and theirs will meet.`,
      }
    : { clear: true }
}

/**
 * The view the edit check reads: the one the last beat read, while fresh.
 */
const currentView = async ($: EngineInterface): Promise<View> =>
  lastView !== undefined && (await $.clock.now()) - lastView.at < VIEW_FRESH_MS ? lastView.view : readView($)

type Checked = { target: Target; verdict: Verdict } | { target?: Target; unchecked: string } | undefined

/**
 * Asks the store who else is in the edited file, once per file per turn of
 * the loop the edit runs in. Any failure lets the edit run, and pauses the
 * checks for a minute so a throttled or absent store is not asked again on
 * every edit.
 */
const checkEdit = async ($: EngineInterface, given: string, loop: string): Promise<Checked> => {
  const now = await $.clock.now()
  const isPaused = now < checkPausedUntil
  const paused = 'the store did not answer a moment ago; checks resume within a minute'
  let view: View

  if (isPaused && lastView === undefined) {
    return { unchecked: paused }
  }

  try {
    view = isPaused && lastView !== undefined ? lastView.view : await currentView($)
  } catch (error) {
    const message = errorText(error)

    checkPausedUntil = now + CHECK_BACKOFF_MS

    return { unchecked: looksRefused(message) ? `the store refused the read; ${ALLOW_RULE}` : message }
  }

  const target = await targetOf($, view, given)

  if (target === undefined) {
    return undefined
  }

  if (!storeTakesPath(target.path)) {
    return { unchecked: 'its name carries a character the store does not take in a path' }
  }

  const key = `${target.claim.id}\u0000${target.path}`
  const cache = checked.get(loop) ?? new Map<string, Verdict>()
  const cached = cache.get(key)

  checked.set(loop, cache)

  if (cached !== undefined) {
    return { target, verdict: cached }
  }

  if (isPaused) {
    return { target, unchecked: paused }
  }

  try {
    const { conflicts, switched_off } = await call<{ conflicts: Conflict[]; switched_off?: true }>($, 'touch_conflicts', { paths: [target.path], claim: target.claim.id })

    if (switched_off === true) {
      return { target, unchecked: 'the collision check is switched off in Marshall' }
    }

    const verdict = verdictOf(view, target, conflicts)

    cache.set(key, verdict)

    return { target, verdict }
  } catch (error) {
    const message = errorText(error)

    checkPausedUntil = now + CHECK_BACKOFF_MS

    return { target, unchecked: looksRefused(message) ? `the store refused the check; ${ALLOW_RULE}` : message }
  }
}

const remember = (target: Target): void => {
  const paths = pending.get(target.claim.id) ?? new Set<string>()

  if (paths.size < PATHS_PER_CLAIM) {
    paths.add(target.path)
  }

  pending.set(target.claim.id, paths)
}

/**
 * Reports the files edited this turn, per claim, in batches of 100. A claim
 * that has ended drops its files quietly; a refusal drops them and says so;
 * anything else keeps them for the next turn's report.
 */
const flushTouches = async ($: EngineInterface): Promise<void> => {
  for (const [claim, paths] of [...pending.entries()]) {
    const all = [...paths].sort()

    for (let at = 0; at < all.length; at += PATHS_PER_CALL) {
      const batch = all.slice(at, at + PATHS_PER_CALL)

      try {
        await call($, 'record_touches', { claim, paths: batch })
        batch.forEach(path => paths.delete(path))
      } catch (error) {
        const message = errorText(error)

        if (/lease_lost|claim_not_found/.test(message)) {
          paths.clear()
        } else if (/not_holder|touches_limit_exceeded|invalid_touch_path/.test(message)) {
          paths.clear()
          $.ui.toast(`Marshall could not record the files this claim edited: ${message.slice(0, 100)}`)
        }

        break
      }
    }

    if (paths.size === 0) {
      pending.delete(claim)
    }
  }
}

const editedPath = (e: { tool: string }): string | undefined => {
  const input = e as { file_path?: unknown; notebook_path?: unknown }
  const path = e.tool === 'NotebookEdit' ? input.notebook_path : input.file_path

  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * The verdict for one of the mod's own store calls: allowed when this plugin
 * made it, unless a deny beneath stands. Anyone else's call (the model's)
 * keeps the verdict beneath, so the person's rules decide it.
 */
export const ownCallVerdict = <V extends { decision: 'allow' | 'ask' | 'deny' }>(origin: string, plugin: string, verdict: V): V =>
  origin !== plugin || verdict.decision === 'deny' ? verdict : { ...verdict, decision: 'allow' }

/**
 * The claims a loop works: the ones it beat or took itself, and for the main
 * loop the claims taken from this checkout.
 */
const claimsOfLoop = (loop: string): string[] => {
  const own = [...(loopClaims.get(loop) ?? [])]
  const local = loop === MAIN_LOOP && lastRoot !== undefined ? (lastView?.view.claims ?? []).filter(claim => isLocal(claim, lastRoot as string)).map(claim => claim.id) : []

  return [...new Set([...own, ...local])]
}

const pauseOf = (ids: string[]): { id: string; pause: Pause } | undefined => {
  for (const id of ids) {
    const pause = pauses.get(id)

    if (pause !== undefined) {
      return { id, pause }
    }
  }

  return undefined
}

const bump = async ($: EngineInterface): Promise<void> => {
  lastActivityAt = await $.clock.now()
}

const withContext = <T extends { context?: readonly string[] }>(ran: T, line: string | undefined): T =>
  line === undefined ? ran : { ...ran, context: [...(ran.context ?? []), line] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    optedIn = await readOptIn($).catch(() => false)

    if (optedIn) {
      // The store's server may still be connecting when the session starts.
      const connected = await $.mcp.connect(MANIFEST_SERVER).catch(() => undefined)

      server = connected?.isConnected === true ? connected.server : MARSHALL
      host = await readHost($)
      await bump($)
      arm($)
      await beatQuietly($)
    }

    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation but not the work: no session.start
    // follows it, so the timer keeps beating.
    if (e.reason !== 'clear') {
      timer?.cancel()
      timer = undefined
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A new turn of a loop asks the store again about the files it edits.
    checked.delete(e.agentId ?? MAIN_LOOP)

    if (optedIn && e.agentId === undefined) {
      uncheckedToasted = false

      if (declaredNote !== undefined) {
        declaredNote = undefined
        $.ui.status(withNotes(lastLine, []))
      }
    }

    if (optedIn) {
      await bump($)

      if (timer === undefined) {
        arm($)
      }
    }

    return next(e)
  })

  // The files edited in a turn are reported to the store when it ends; a
  // subagent's run ending is a turn end too.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      checked.delete(e.agentId)
    }

    if (optedIn && pending.size > 0) {
      await flushTouches($).catch(() => undefined)
    }

    return done
  }).catch(($, e, next) => next(e))

  // Any tool call is activity, and one still running keeps the session awake.
  // While a claim this loop works is paused, only the reads, the heartbeat,
  // a hand-back and a resume run.
  on('tool.call', async ($, e, next) => {
    if (!optedIn) {
      return next(e)
    }

    const pause = PAUSE_EXEMPT.has(e.tool) ? undefined : pauseOf(claimsOfLoop(e.agentId ?? MAIN_LOOP))

    if (pause !== undefined) {
      if (!pauseToasted.has(pause.id)) {
        pauseToasted.add(pause.id)
        $.ui.toast(`Marshall: this worker is paused${pause.pause.by === undefined ? '' : ` by ${pause.pause.by}`}; its tool calls wait for a resume`)
      }

      return { deny: pausedText(pause.pause) }
    }

    callsInFlight++
    await bump($)

    try {
      return await next(e)
    } finally {
      callsInFlight--
      await bump($).catch(() => undefined)
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const gh = optedIn ? ghPr(e.command) : undefined

    if (gh === undefined) {
      return next(e)
    }

    let before: PullRequest | undefined
    let unchecked: string | undefined

    if (gh.verb === 'merge') {
      // Read before the merge: --delete-branch moves the checkout off the PR.
      before = await viewPr($, gh, gh.selector).catch(() => undefined)
    }

    const verdict = await (gh.verb === 'merge' ? guardMerge($, before) : guardCreate($, gh)).catch(error => ({ unchecked: `the guard failed: ${errorText(error)}` }))

    if (verdict !== undefined && 'deny' in verdict) {
      $.ui.toast(verdict.toast)

      return { deny: verdict.deny }
    }

    if (verdict !== undefined) {
      unchecked = `Marshall did not check this ${gh.verb === 'merge' ? 'merge' : 'pull request'} (${verdict.unchecked}); it ran unchecked.`
      $.ui.toast(unchecked)
    }

    const ran = await next(e)

    if (ran.deny !== undefined || ran.isError === true) {
      return withContext(ran, unchecked)
    }

    const result = ran.result as { interrupted?: boolean; backgroundTaskId?: string; gitOperation?: { pr?: { number: number; action: string } } } | undefined

    if (result?.interrupted === true || result?.backgroundTaskId !== undefined || gh.isWeb) {
      return withContext(withContext(ran, unchecked), `Marshall did not record this PR: the command did not finish here. If it ${gh.verb === 'merge' ? 'merged' : 'opened'} a PR for a component you hold, record it by hand.`)
    }

    const reported = result?.gitOperation?.pr?.action === 'merged' ? result.gitOperation.pr.number : undefined
    const observed = await (gh.verb === 'create' ? observeCreate($, gh) : observeMerge($, gh, before, reported)).catch(
      error => `Marshall could not check what this ${gh.verb} changed (${errorText(error)}); if it moved a component you hold, record it by hand.`,
    )

    return withContext(withContext(ran, unchecked), observed)
  }).catch(($, e, next) => {
    $.ui.toast(
      next.called
        ? 'Marshall: it could not check what this command changed; record any PR it opened or merged by hand.'
        : 'Marshall: its guard failed, so the command ran unchecked.',
    )

    return next(e)
  })

  // Before an edit lands, the store is asked who else is in the file: another
  // claim that has edited it refuses the edit; one that only declared it warns.
  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const given = optedIn ? editedPath(e) : undefined

    if (given === undefined) {
      return next(e)
    }

    const checkedEdit = await checkEdit($, given, e.agentId ?? MAIN_LOOP)
    const holderPause = checkedEdit?.target === undefined ? undefined : pauses.get(checkedEdit.target.claim.id)

    if (holderPause !== undefined) {
      return { deny: pausedText(holderPause) }
    }

    if (checkedEdit !== undefined && 'verdict' in checkedEdit && 'refuse' in checkedEdit.verdict) {
      $.ui.toast(`Marshall refused an edit to ${checkedEdit.target.path}: another claim is working in it`)

      return { deny: checkedEdit.verdict.refuse }
    }

    const ran = await next(e)

    if (checkedEdit === undefined || ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    if ('unchecked' in checkedEdit) {
      if (checkedEdit.target !== undefined) {
        remember(checkedEdit.target)
      }

      if (!uncheckedToasted) {
        uncheckedToasted = true
        $.ui.toast(`Marshall could not check this edit against other agents: ${checkedEdit.unchecked.replace(ALLOW_RULE, ALLOW_HINT).slice(0, 120)}`)
      }

      return withContext(ran, `Marshall did not check this edit against other agents' claims (${checkedEdit.unchecked}); it ran unchecked.`)
    }

    remember(checkedEdit.target)

    if ('declared' in checkedEdit.verdict && !warned.has(checkedEdit.target.file)) {
      warned.add(checkedEdit.target.file)
      declaredNote = `declared elsewhere: ${checkedEdit.target.path}`
      $.ui.status(withNotes(lastLine, []))

      return withContext(ran, checkedEdit.verdict.declared)
    }

    return ran
  }).catch(($, e, next) => {
    if (!next.called) {
      $.ui.toast("Marshall's edit check failed; the edit ran unchecked.")
    }

    return next(e)
  })

  // A claim the model takes or ends changes which files are held here.
  on('tool.call', { tool: CLAIM_TOOLS }, async ($, e, next) => {
    const ran = await next(e)

    lastView = undefined

    return ran
  }).catch(($, e, next) => next(e))

  // The model's own heartbeats and claims say which claim each loop works,
  // and a heartbeat refused worker_paused is the moment a pause is learned.
  on('tool.call', { tool: [`${TOOL_PREFIX}heartbeat_claim`, `${TOOL_PREFIX}claim_component`] }, async ($, e, next) => {
    const ran = await next(e)

    if (!optedIn || ran.deny !== undefined) {
      return ran
    }

    const input = e as { claim?: unknown; component?: unknown }
    const answered = ran.isError === true ? undefined : jsonBodyOf(ran.text)
    const id =
      typeof answered?.id === 'string'
        ? answered.id
        : typeof input.claim === 'string'
          ? input.claim
          : lastView?.view.claims.find(claim => claim.component_id === input.component)?.id

    if (id === undefined) {
      return ran
    }

    const loop = e.agentId ?? MAIN_LOOP
    const ids = loopClaims.get(loop) ?? new Set<string>()

    loopClaims.set(loop, ids.add(id))

    if (ran.isError === true) {
      const refusal = refusalOf(ran.text)

      if (refusal?.error === 'worker_paused') {
        markRefused(id, refusal)
      }
    } else if (e.tool === `${TOOL_PREFIX}heartbeat_claim`) {
      clearPause(id)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A compacted session keeps working the same component: the held claim,
  // its component and its acceptance criteria follow the summary.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)

    if (!optedIn || e.agentId !== undefined || e.trigger === 'precompute' || compacted.skip !== undefined) {
      return compacted
    }

    const text = await heldWorkText($).catch(error => {
      $.ui.toast(`Marshall could not restore the held claim after compaction: ${errorText(error).slice(0, 80)}`)

      return undefined
    })

    return text === undefined ? compacted : { ...compacted, messages: [...compacted.messages, { role: 'user' as const, text, toolUses: [] }] }
  }).catch(($, e, next) => next(e))

  // The mod's own store calls are its grant; the model's are left to the
  // person's rules, and a deny beneath always stands.
  on(
    'tool.check',
    { tool: OWN_TOOLS.map(tool => `${TOOL_PREFIX}${tool}`) },
    async ($, e, next) => ownCallVerdict(next.origin.plugin, $.plugin.name, await next(e)),
  ).catch(($, e, next) => next(e))
}
