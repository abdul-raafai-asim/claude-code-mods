// panel.js: the pane's other tabs. The map and the pins are register.js's;
// this file keeps the rest of what the pane shows, reads it with git and gh,
// and lays each tab out as the same items register.js draws.
//
//   diffs   every file changed against the base branch (or HEAD), with its
//           line counts and when it was last written; a number opens its diff
//   github  the branch's PR, its review state and CI checks, the latest runs
//   chats   the sessions this terminal tab has held, oldest first, each with
//           what it did; a /clear, a handoff or a new `claude` adds one

import { short } from './draw.js'
import {
  STAGES, STATUS_MARK, ago, paneOwner, progressFrom, stageRows, changedFiles, ciWord, herdrPanes, hunksOf, lastCommitted, clock, handoffFrom, joinChain, leftCut, prWord, reviewWord, runState, splitDiff, tabIdFrom, tallyChecks,
} from './work.js'

export const TABS = [
  { id: 'map', hotkey: 'm', label: 'map' },
  { id: 'progress', hotkey: 'w', label: 'progress' },
  { id: 'diffs', hotkey: 'd', label: 'diffs' },
  { id: 'github', hotkey: 'g', label: 'github' },
  { id: 'chats', hotkey: 's', label: 'chats' },
]

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export const W = {
  tab: 'map',
  repo: null,        // the git repository the chat works in: its root
  git: null,         // { branch, baseRef, baseLabel, files, diffs, at, error }
  diffMode: 'chat',  // 'chat': since this chat started; 'branch': since the branch left its base; 'head': uncommitted only
  openFile: null,    // the file whose diff the diffs tab shows
  gh: null,          // { pr, checks, runs, sync, at, error }
  chain: null,       // { sessions, overall, overallOf }
  chainKey: null,
  tabId: null,
  sessionId: null,
  interactive: true, // a -p run or the SDK is no chat of the tab's
  ctx: null,         // the context window's fill, percent
  firstPrompt: '',
  touched: [],       // files Claude wrote this session, newest last, absolute
  fetched: {},       // base branch -> when origin's copy was last fetched
  herdr: null,       // { bin, workspace, pane, tab, label, panes, at, error }: the tab's live panes
  tabFile: undefined,// the herdr tab's record of which pane shows the pane (null outside herdr)
  myPane: null,      // this chat's herdr pane
  paneOwner: null,   // the herdr pane that shows the tab's pane
  hidden: false,     // hidden outside herdr, where no tab record is kept
  msgs: [],          // the transcript as last read, for the progress tab
  declared: null,    // { input, seen }: the last progress_set, until the transcript holds it
  busy: { git: false, gh: false, overall: false },
  ghDueAt: 0,
  gitDueAt: 0,
}

// A new session id (/clear): the tab's chain goes on, the session's own facts start over
export function startPanelSession(id) {
  if (W.sessionId === id) return
  Object.assign(W, { sessionId: id, touched: [], firstPrompt: '', openFile: null, ctx: null, msgs: [], declared: null })
}

// ---------------------------------------------------------------------------
// Which repository
// ---------------------------------------------------------------------------

const dirOf = p => String(p).replace(/\/[^/]*$/, '') || '/'

async function toplevel($, dir) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

// The repository of the file Claude wrote last, else of the session's folder:
// a session started above its repositories still shows the one it works in
async function findRepo($) {
  for (const file of [...W.touched].reverse()) {
    const top = await toplevel($, dirOf(file))
    if (top) return top
  }
  return toplevel($, await $.session.cwd())
}

// What the transcript says about this session: the files written, the first prompt
export function readMessages(messages, cwd) {
  const abs = p => (String(p).startsWith('/') ? String(p) : `${cwd}/${p}`)
  const touched = []
  for (const m of messages) {
    for (const t of m.toolUses || []) {
      const f = t.input?.file_path || t.input?.notebook_path
      if (EDIT_TOOLS.includes(t.tool) && f) {
        const p = abs(f)
        const i = touched.indexOf(p)
        if (i >= 0) touched.splice(i, 1)
        touched.push(p)
      }
    }
  }
  W.touched = touched
  W.msgs = messages
  // A slash command (/reload-plugins, /diagram) and its output are no prompt
  const first = messages.find(m => m.role === 'user' && m.text && !m.toolResults?.length && !/^\s*<(command-|local-command-)/.test(m.text))
  W.firstPrompt = first ? plain(first.text) : ''
}

// One line of text a Text element takes: no control characters, no escapes
// eslint-disable-next-line no-control-regex
export const plain = text => String(text ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// git: the diffs tab
// ---------------------------------------------------------------------------

async function git($, args, timeoutMs = 15000) {
  const r = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd: W.repo, timeoutMs })
  if (r.exitCode !== 0) return null
  // Output cut at 4 MiB ends mid-file: drop the last file rather than draw half of it
  return r.isStdoutTruncated ? r.stdout.slice(0, Math.max(0, r.stdout.lastIndexOf('\ndiff --git '))) : r.stdout
}

// A repository born during the chat is compared with nothing at all
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export const DIFF_MODES = ['chat', 'pr', 'head']
const MODE_NAMES = { chat: 'this chat', pr: 'the PR', head: 'uncommitted' }

// origin's copy of the base branch, fetched at most every five minutes, so the
// PR view starts where the branch left the base as it is on GitHub
async function fetchBase($, branch) {
  const now = await $.clock.now()
  if (W.fetched[branch] && now - W.fetched[branch] < 300000) return
  W.fetched[branch] = now
  // Never a credential prompt: a fetch that needs one just fails
  await $.process.run(['git', 'fetch', '--quiet', '--no-tags', 'origin', branch], { cwd: W.repo, timeoutMs: 20000, env: { GIT_TERMINAL_PROMPT: '0' } }).catch(() => {})
}

// What a view compares: `ref` against the working tree, or `ref` to `to` (committed only)
async function baseOf($) {
  if (W.diffMode === 'head') return { ref: 'HEAD', label: 'uncommitted' }
  if (W.diffMode === 'chat') {
    // The commit HEAD was on when the chat started: committed or not, what
    // changed since is this chat's work (and anything pulled in meanwhile)
    const { startedAt } = await $.session.usage()
    const at = (await git($, ['rev-list', '-1', `--before=@${Math.floor(startedAt / 1000)}`, 'HEAD']))?.trim()
    return { ref: at || EMPTY_TREE, label: `this chat (since ${clock(startedAt).split(' ')[1]})` }
  }
  // The PR: what the branch's commits add on top of where it last met its
  // base. Merging or rebasing the base in moves that point, so the base's own
  // changes never show, as on GitHub's Files changed.
  const pr = W.gh?.pr?.state === 'OPEN' || W.gh?.pr?.state === 'MERGED' ? W.gh.pr : null
  const head = (await git($, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  const wanted = pr?.baseRefName || head?.replace(/^origin\//, '') || 'main'
  await fetchBase($, wanted)
  const candidates = [...new Set([`origin/${wanted}`, head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean))]
  for (const c of candidates) {
    const mb = (await git($, ['merge-base', 'HEAD', c]))?.trim()
    if (mb) return { ref: mb, to: 'HEAD', label: `${pr ? `PR #${pr.number}` : 'branch'} vs ${c.replace(/^origin\//, '')}`, committed: true }
  }
  return { ref: 'HEAD', label: 'uncommitted' }
}

export async function refreshGit($) {
  // A view switched while git runs is read again once it is done
  if (W.busy.git) {
    W.gitAgain = true
    return
  }
  W.busy.git = true
  W.gitAgain = false
  try {
    W.repo = await findRepo($)
    if (!W.repo) {
      W.git = { error: 'not in a git repository', files: [], diffs: {} }
      return
    }
    const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || '?'
    const base = await baseOf($)
    const range = base.to ? [base.ref, base.to] : [base.ref]
    const hasLog = base.ref !== 'HEAD' && base.ref !== EMPTY_TREE
    const [numstat, status, nameStatus, diff, log, dates] = await Promise.all([
      git($, ['diff', '--numstat', '-M', ...range]),
      // The PR view is commits only: what the working tree has on top is not in it
      base.committed ? '' : git($, ['status', '--porcelain=v1', '--untracked-files=all']),
      git($, ['diff', '--name-status', '-M', ...range]),
      git($, ['diff', '-M', '--no-color', ...range], 30000),
      hasLog ? git($, ['log', '--format=%h %s', `${base.ref}..HEAD`]) : '',
      base.committed ? git($, ['log', '--format=@%ct', '--name-only', `${base.ref}..HEAD`]) : '',
    ])
    const commits = (log || '').split('\n').filter(Boolean)
    const committedAt = lastCommitted(dates)
    const diffs = splitDiff(diff || '')
    // Untracked files have no diff in git: their lines are all new
    const untracked = {}
    for (const line of (status || '').split('\n')) {
      if (!line.startsWith('?? ')) continue
      const path = line.slice(3).replace(/^"|"$/g, '')
      if (Object.keys(untracked).length >= 20) break
      try {
        const text = await $.fs.read(`${W.repo}/${path}`)
        if (typeof text !== 'string' || text.length > 200000) continue
        const lines = text.replace(/\n$/, '').split('\n')
        untracked[path] = lines.length
        diffs[path] = `@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => '+' + l).join('\n')
      } catch {}
    }
    const files = changedFiles({ numstat, status, nameStatus, untracked }).slice(0, 80)
    const mine = new Set(W.touched.map(p => p.startsWith(W.repo + '/') ? p.slice(W.repo.length + 1) : null).filter(Boolean))
    await Promise.all(files.map(async f => {
      f.mine = mine.has(f.path)
      // In the PR view a file's time is its last commit's; elsewhere, its last write
      if (base.committed) {
        f.mtime = committedAt[f.path] || 0
        return
      }
      try {
        f.mtime = (await $.fs.stat(`${W.repo}/${f.path}`)).mtimeMs
      } catch {
        f.mtime = 0 // deleted
      }
    }))
    files.sort((a, b) => b.mtime - a.mtime)
    W.git = { branch, baseRef: base.ref, baseLabel: base.label, committed: Boolean(base.committed), files, diffs, commits, at: await $.clock.now() }
    if (W.openFile && !files.some(f => f.path === W.openFile)) W.openFile = null
  } catch (err) {
    W.git = { ...(W.git || { files: [], diffs: {} }), error: 'git: ' + err.message }
  } finally {
    W.busy.git = false
  }
  if (W.gitAgain) await refreshGit($)
}

// ---------------------------------------------------------------------------
// gh: the github tab
// ---------------------------------------------------------------------------

const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergeable,mergeStateStatus,updatedAt,latestReviews'
const RUN_FIELDS = 'databaseId,status,conclusion,workflowName,displayTitle,createdAt,url,event'

export async function refreshGh($) {
  if (W.busy.gh) return
  W.busy.gh = true
  try {
    if (!W.repo) W.repo = await findRepo($)
    if (!W.repo) {
      W.gh = { error: 'not in a git repository' }
      return
    }
    const run = argv => $.process.run(argv, { cwd: W.repo, timeoutMs: 20000 })
    const branch = W.git?.branch || (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
    const [pr, runs, counts] = await Promise.all([
      run(['gh', 'pr', 'view', '--json', PR_FIELDS]),
      run(['gh', 'run', 'list', '--branch', branch || 'HEAD', '--limit', '5', '--json', RUN_FIELDS]),
      git($, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    ])
    const out = { at: await $.clock.now(), branch }
    if (pr.exitCode === 0) {
      out.pr = JSON.parse(pr.stdout)
      out.checks = tallyChecks(out.pr.statusCheckRollup)
    } else if (!/no pull requests found/i.test(pr.stderr)) {
      out.error = short('gh: ' + (pr.stderr.trim().split('\n')[0] || `exit ${pr.exitCode}`), 120)
    }
    if (runs.exitCode === 0) out.runs = JSON.parse(runs.stdout || '[]')
    if (counts) {
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
      out.sync = { ahead, behind }
    } else out.sync = null
    W.gh = out
    const pending = out.checks?.pending || (out.runs || []).some(r => runState(r) === 'pending')
    W.ghDueAt = out.at + (pending ? 45000 : 180000)
  } catch (err) {
    W.gh = { ...(W.gh || {}), error: 'gh: ' + err.message }
    W.ghDueAt = (await $.clock.now()) + 180000
  } finally {
    W.busy.gh = false
  }
}

// ---------------------------------------------------------------------------
// Chats: the tab's chain of sessions
// ---------------------------------------------------------------------------

async function tabId($) {
  return tabIdFrom({
    HERDR_TAB_ID: await $.env.get('HERDR_TAB_ID'),
    TMUX_PANE: await $.env.get('TMUX_PANE'),
    ZELLIJ_PANE_ID: await $.env.get('ZELLIJ_PANE_ID'),
    WEZTERM_PANE: await $.env.get('WEZTERM_PANE'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    ITERM_SESSION_ID: await $.env.get('ITERM_SESSION_ID'),
    TERM_SESSION_ID: await $.env.get('TERM_SESSION_ID'),
  })
}

// The chain's writes go one at a time: each reads the chain fresh, changes
// it and writes it back, so a summary written while a turn's row is written
// is not lost to it
let chainQueue = Promise.resolve()
const queued = work => {
  const run = chainQueue.then(work)
  chainQueue = run.catch(() => {})
  return run
}

// Record this session in the tab's chain, so a second process in the tab loses little
export function updateChain($, fields = {}) {
  return queued(() => writeChain($, fields))
}

async function writeChain($, fields) {
  if (!W.sessionId) return
  if (W.tabId === null) W.tabId = (await tabId($)) || ''
  // The project is where the session started, which does not move as Claude
  // works in one repository or another beneath it
  const root = await $.session.root()
  W.chainKey = 'chain:' + (W.tabId || 'folder:' + root)
  const now = await $.clock.now()
  const chain = await $.store.get(W.chainKey)
  // A -p run or the SDK reads the tab's chain and is not added to it
  if (!W.interactive) {
    W.chain = chain?.sessions ? chain : { sessions: [] }
    return
  }
  const known = chain?.sessions?.find(s => s.id === W.sessionId)
  const row = {
    id: W.sessionId,
    root,
    ...(W.repo ? { repo: W.repo } : {}),
    ...(W.herdr?.pane ? { pane: W.herdr.pane } : {}),
    lastAt: now,
    ...(W.git?.branch ? { branch: W.git.branch } : {}),
    ...(W.firstPrompt ? { firstPrompt: short(W.firstPrompt, 200) } : {}),
    ...(W.ctx !== null ? { ctx: W.ctx } : {}),
    ...progressRow(),
    ...fields,
  }
  // Once the session has a first prompt: did it start from an earlier one's handoff?
  if (W.firstPrompt && !known?.from && !known?.firstPrompt && chain?.sessions?.length) {
    const from = handoffFrom([W.firstPrompt], chain.sessions.filter(s => s.id !== W.sessionId))
    if (from) row.from = from
  }
  W.chain = joinChain(chain, row, now)
  await $.store.set(W.chainKey, W.chain)
}

const OVERALL_SYSTEM = 'You summarize a chain of coding-agent chats in one terminal tab. Reply with one or two plain sentences, no preamble.'

// One line on the whole chain, from each chat's own summary: a Haiku call,
// and only when the summaries changed
export async function refreshOverall($) {
  const done = (W.chain?.sessions || []).filter(s => s.summary || s.firstPrompt)
  if (done.length < 2 || W.busy.overall) return
  const of = done.map(s => `${s.id.slice(0, 8)}:${s.summary || s.firstPrompt}`).join('|')
  if (W.chain.overallOf === of) return
  W.busy.overall = true
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: OVERALL_SYSTEM,
      prompt: 'The chats, oldest first. Each picked up where the one before stopped (a handoff, a /clear or a restart):\n' +
        done.map((s, i) => `${i + 1}. ${s.summary || 'started with: ' + s.firstPrompt}`).join('\n') +
        '\n\nWhat is the overall goal, and where does it stand now?',
      maxTokens: 160,
      timeoutMs: 20000,
    })
    if (!r.isAnswered) return
    await queued(async () => {
      const chain = (await $.store.get(W.chainKey)) || W.chain
      W.chain = { ...chain, overall: plain(r.text), overallOf: of }
      await $.store.set(W.chainKey, W.chain)
    })
  } finally {
    W.busy.overall = false
  }
}

// herdr: the panes of this tab that run an agent, and which session each holds
export async function refreshHerdr($) {
  if (W.herdr === null) {
    if ((await $.env.get('HERDR_ENV')) !== '1') {
      W.herdr = { off: true }
      return
    }
    W.herdr = {
      bin: (await $.env.get('HERDR_BIN_PATH')) || 'herdr',
      workspace: await $.env.get('HERDR_WORKSPACE_ID'),
      pane: await $.env.get('HERDR_PANE_ID'),
      tab: await $.env.get('HERDR_TAB_ID'),
      panes: [],
    }
  }
  const h = W.herdr
  if (h.off || !h.tab) return
  try {
    const [panes, tab] = await Promise.all([
      $.process.run([h.bin, 'pane', 'list', ...(h.workspace ? ['--workspace', h.workspace] : [])], { timeoutMs: 5000 }),
      $.process.run([h.bin, 'tab', 'get', h.tab], { timeoutMs: 5000 }),
    ])
    if (panes.exitCode !== 0) throw new Error(panes.stderr.trim().split('\n')[0] || `exit ${panes.exitCode}`)
    h.panes = herdrPanes(panes.stdout, h.tab)
    try {
      h.label = JSON.parse(tab.stdout)?.result?.tab?.label || ''
    } catch {}
    h.at = await $.clock.now()
    h.error = null
  } catch (err) {
    h.error = 'herdr: ' + err.message
  }
}

// Jump to a pane: herdr focuses its tab and the pane, and marks it seen
export async function focusPane($, pane) {
  const h = W.herdr
  if (!h?.bin) return 'herdr is not running here'
  const r = await $.process.run([h.bin, 'agent', 'focus', pane], { timeoutMs: 5000 })
  return r.exitCode === 0 ? null : (r.stderr.trim().split('\n')[0] || `exit ${r.exitCode}`)
}

// ---------------------------------------------------------------------------
// One pane per herdr tab
// ---------------------------------------------------------------------------

// The tab's record, { owner: herdr pane, hidden, at }, is a file every chat in
// the tab reads: $.store is each process's own copy
async function tabFile($) {
  if (W.tabFile !== undefined) return W.tabFile
  const [pane, tab, home] = await Promise.all([$.env.get('HERDR_PANE_ID'), $.env.get('HERDR_TAB_ID'), $.env.get('HOME')])
  W.myPane = (await $.env.get('HERDR_ENV')) === '1' && pane && tab ? pane : null
  W.tabFile = W.myPane && home ? `${home}/.claude/diagram-pane/tabs/${String(tab).replace(/[^\w-]/g, '_')}.json` : null
  return W.tabFile
}

async function readTab($) {
  const file = await tabFile($)
  if (!file) return null
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return null
  }
}

export async function writeTab($, fields) {
  const file = await tabFile($)
  if (!file) return
  const rec = { ...(await readTab($)), ...fields, at: await $.clock.now() }
  await $.fs.write(file, JSON.stringify(rec) + '\n')
}

// Whether this chat shows the tab's pane, claiming it when it is new to the tab
// or the owner's pane is gone. `herdr` asks herdr which panes still run an agent.
export async function settleOwner($, { fresh = false, herdr = false } = {}) {
  const rec = await readTab($)
  if (!W.myPane) return { show: !W.hidden }
  let live = null
  if (herdr && rec?.owner && rec.owner !== W.myPane && !fresh) {
    await refreshHerdr($)
    if (W.herdr?.at && !W.herdr.error) live = W.herdr.panes
  }
  const d = paneOwner(rec, W.myPane, live, { fresh })
  if (d.claim) await writeTab($, { owner: W.myPane })
  W.paneOwner = d.claim || rec?.owner === W.myPane ? W.myPane : rec?.owner
  return d
}

// /diagram and the pane's hide button: this chat takes the pane, or the tab hides it
// (outside herdr, for this chat alone)
export async function showHere($) {
  W.hidden = false
  await writeTab($, { owner: W.myPane, hidden: false })
}

export async function hideTab($) {
  W.hidden = true
  await writeTab($, { hidden: true })
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const PROGRESS_TOOL = 'mcp__diagram-pane__progress_set'

// Claude's progress_set lands at once; once the transcript holds the call
// (by its id) the transcript's copy is the one read, in its place
export function declare(input, id) {
  W.declared = { input, id }
}
const holds = (msgs, id) => msgs.some(m => (m.toolUses || []).some(t => t.tool_use_id === id))

// The chat's progress: the transcript's signals, the PR's CI and merge, and,
// for a chat that came from a handoff, where the chat before it stood
export function progress() {
  let msgs = W.msgs
  if (W.declared && !holds(msgs, W.declared.id)) {
    msgs = [...msgs, { role: 'assistant', text: '', toolUses: [{ tool: PROGRESS_TOOL, input: W.declared.input, text: 'ok' }] }]
  }
  const row = W.chain?.sessions?.find(s => s.id === W.sessionId)
  const from = row?.from && W.chain.sessions.find(s => s.id === row.from)
  return progressFrom(msgs, { pr: W.gh?.pr, checks: W.gh?.checks, seed: from?.progress })
}

// What the chain keeps of it: the stage and each stage's turn and note
function progressRow() {
  const p = progress()
  if (!p.now) return {}
  const stages = Object.fromEntries(Object.entries(p.stages).map(([k, s]) => [k, { turn: s.turn, note: s.note || (s.files?.length ? `${s.files.length} files` : ''), failed: s.failed }]))
  return { progress: { now: p.now, stages } }
}

export function progressItems(w, act) {
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const p = progress()
  add(spread('◆ PROGRESS', p.now ? `now: ${p.now}` : '', w), { bold: true, color: 'yellow' })
  if (!p.now) add('Nothing to place yet: the stages fill in as Claude plans, edits, tests, reviews, commits and pushes.', { dim: true, wrap: true })
  for (const r of stageRows(p)) {
    const isNow = r.mark === '▶' || (r.name === p.now)
    const when = r.inherited ? 'prev chat' : r.turn != null ? `turn ${r.turn}` : ''
    const what = r.note || (r.files?.length ? `${r.files.length} file${r.files.length > 1 ? 's' : ''}` : '')
    add(short(`${r.mark} ${r.name.padEnd(10)} ${when.padEnd(9)} ${what}`, w), {
      bold: isNow,
      color: r.mark === '✗' ? 'red' : isNow ? 'yellow' : r.mark === '✓' ? 'green' : undefined,
      dim: r.mark === '·' || r.mark === '–' || r.inherited,
    })
  }
  if (p.declared) add('Claude: ' + p.declared, { wrap: true, color: 'yellow' })
  add('')
  add('✓ done  ▶ now  ✗ failed  – skipped  · not yet', { dim: true })
  add('Stages come from what Claude ran: edits, test commands, review agents, git and gh, and the PR\'s CI. Claude can name a stage itself with progress_set.', { dim: true, wrap: true })
  return out
}

export async function readContext($) {
  try {
    const { context } = await $.session.usage()
    W.ctx = context.percent ?? null
  } catch {}
}

// ---------------------------------------------------------------------------
// What the pane draws
// ---------------------------------------------------------------------------

function spread(left, right, w) {
  return right ? left + ' '.repeat(Math.max(1, w - left.length - right.length)) + right : left
}

// The tab bar, then one line of state every tab shares, then what this chat is doing
export function headItems(w, act, summary) {
  const out = []
  out.push({ buttons: TABS.map(t => ({
    key: 'tab:' + t.id, hotkey: t.hotkey, label: (W.tab === t.id ? '▸' : '') + t.label, onPress: () => act?.tab(t.id),
  })).concat({ key: 'hide', hotkey: 'x', label: 'hide', onPress: () => act?.hide() }) })
  out.push({ text: short(strip(), w), dim: true })
  const what = summary || (W.firstPrompt ? 'started with: ' + W.firstPrompt : '')
  if (what) out.push({ text: '▍' + what, wrap: true, color: 'yellow' })
  out.push({ text: '─'.repeat(w), dim: true })
  return out
}

function strip() {
  const parts = []
  const p = progress()
  if (p.now) parts.push('▶ ' + p.now)
  if (W.git?.branch) parts.push('⎇ ' + W.git.branch)
  if (W.gh) {
    parts.push(prWord(W.gh.pr))
    if (W.gh.pr) parts.push('CI ' + ciWord(W.gh.checks))
  }
  if (W.git?.files) {
    const add = W.git.files.reduce((n, f) => n + f.add, 0)
    const del = W.git.files.reduce((n, f) => n + f.del, 0)
    parts.push(`${W.git.files.length} files +${add} −${del}`)
  }
  if (W.ctx !== null) parts.push(`ctx ${W.ctx}%`)
  return parts.join(' · ') || 'reading git…'
}

export function diffItems(w, act, now) {
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const g = W.git
  if (!g) return [{ text: 'reading git…', dim: true }]
  if (g.error && !g.files?.length) return [{ text: g.error, dim: true }]

  if (W.openFile) {
    const f = g.files.find(x => x.path === W.openFile)
    const i = g.files.indexOf(f)
    add(short(`◆ ${W.openFile}`, w), { bold: true, color: 'green' })
    const verb = g.committed ? 'committed' : 'written'
    add(f ? `${f.status}  +${f.add} −${f.del}  ·  ${f.mtime ? `${verb} ${clock(f.mtime)} (${ago(f.mtime, now)} ago)` : 'gone from disk'}${f.mine ? '  ·  ✎ by Claude' : ''}` : '', { dim: true })
    const abs = `${W.repo}/${W.openFile}`
    const parts = hunksOf(g.diffs[W.openFile])
    out.push({ buttons: [
      { key: 'back', hotkey: 'b', label: 'files', onPress: () => act?.openFile(null) },
      ...(f?.status !== 'D' ? [{ key: 'vscode', hotkey: 'o', label: 'open in VS Code', onPress: () => act?.openInEditor(abs, parts[0]?.line || 1) }] : []),
      ...(i > 0 ? [{ key: 'prev', hotkey: 'p', label: 'prev', onPress: () => act?.openFile(g.files[i - 1].path) }] : []),
      ...(i >= 0 && i < g.files.length - 1 ? [{ key: 'next', hotkey: 'n', label: 'next', onPress: () => act?.openFile(g.files[i + 1].path) }] : []),
    ] })
    if (f?.binary) add('binary file', { dim: true })
    else if (parts.length) {
      // One block per hunk, each under a link to its line in VS Code: cmd+click it
      let room = DIFF_ROOM
      let cut = 0
      for (const p of parts) {
        const { source } = fitDiff(p.text)
        if (!source || source.length > room) {
          cut++
          continue
        }
        room -= source.length
        if (f?.status !== 'D') out.push({ link: { href: `vscode://file${abs.split('/').map(encodeURIComponent).join('/')}:${p.line}`, label: `↗ line ${p.line}` } })
        out.push({ code: { source, path: W.openFile } })
      }
      if (cut) add(`… ${cut} hunk${cut > 1 ? 's' : ''} not drawn: too long for the pane (o opens the file)`, { dim: true })
    }
    else add(f?.status === 'D' ? 'deleted' : 'no diff to show', { dim: true })
    return out
  }

  const add$ = g.files.reduce((n, f) => n + f.add, 0)
  const del$ = g.files.reduce((n, f) => n + f.del, 0)
  add(spread('◆ DIFFS ' + g.baseLabel, `${g.files.length} files +${add$} −${del$}`, w), { bold: true, color: 'green' })
  const nextMode = DIFF_MODES[(DIFF_MODES.indexOf(W.diffMode) + 1) % DIFF_MODES.length]
  out.push({ buttons: [
    { key: 'mode', hotkey: 'v', label: 'show ' + MODE_NAMES[nextMode], onPress: () => act?.diffMode() },
    { key: 'refresh', hotkey: 'r', label: 'refresh', onPress: () => act?.refresh() },
  ] })
  add(short(`repo ${W.repo}`, w), { dim: true })
  if (g.commits?.length) {
    add(`${g.commits.length} commit${g.commits.length > 1 ? 's' : ''} in this range:`, { dim: true })
    for (const c of g.commits.slice(0, 5)) add(short('  ' + c, w), { dim: true })
    if (g.commits.length > 5) add(`  … ${g.commits.length - 5} more`, { dim: true })
  }
  if (!g.files.length) {
    add({
      chat: 'Nothing changed in this repository since this chat started.',
      pr: 'This branch has no commits of its own on top of its base yet.',
      head: 'No uncommitted changes.',
    }[W.diffMode], { dim: true, wrap: true })
    add(`v shows ${MODE_NAMES[nextMode]}.`, { dim: true })
  }
  const wide = Math.max(10, w - 26)
  g.files.forEach((f, i) => {
    const counts = f.binary ? 'bin' : `+${f.add} −${f.del}`
    const when = f.mtime ? ago(f.mtime, now) : g.committed ? '' : 'gone'
    // The first nine draw as `1: label` beside their hotkey; the rest line up under them
    const label = `${i < 9 ? '' : '   '}${f.status} ${leftCut(f.path, wide).padEnd(wide)} ${counts.padStart(9)} ${when.padStart(4)}${f.mine ? ' ✎' : ''}`
    out.push({ buttons: [{ key: 'file:' + f.path, ...(i < 9 ? { hotkey: String(i + 1) } : {}), plain: true, label, onPress: () => act?.openFile(f.path) }] })
  })
  add(`M modified A added D deleted ? new · ✎ Claude wrote it · times are last ${g.committed ? 'commit' : 'write'}`, { dim: true })
  if (g.committed) add('Full search and cmd+click: open the PR in VS Code\'s GitHub Pull Requests view.', { dim: true, wrap: true })
  return out
}

// A Code element takes tab and newline as its only control characters, and
// draws 100,000 characters in all: keep whole hunks up to 60,000
const DIFF_ROOM = 60000
export function fitDiff(hunks) {
  // eslint-disable-next-line no-control-regex
  const clean = hunks.replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')
  if (clean.length <= DIFF_ROOM) return { source: clean, cut: 0 }
  const parts = clean.split(/\n(?=@@ )/)
  const kept = []
  let size = 0
  for (const p of parts) {
    if (size + p.length > DIFF_ROOM) break
    kept.push(p)
    size += p.length + 1
  }
  return { source: kept.join('\n'), cut: parts.length - kept.length }
}

export function githubItems(w, act, now) {
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const gh = W.gh
  add(spread('◆ GITHUB', gh?.at ? `read ${ago(gh.at, now)} ago` : '', w), { bold: true, color: 'blue' })
  out.push({ buttons: [{ key: 'refresh', hotkey: 'r', label: 'refresh', onPress: () => act?.refresh() }] })
  if (!gh) return [...out, { text: W.busy.gh ? 'asking gh…' : 'not read yet', dim: true }]
  if (gh.error) add(gh.error, { color: 'red' })
  const sync = gh.sync ? `${gh.sync.ahead} ahead, ${gh.sync.behind} behind upstream` : 'no upstream: not pushed'
  add(`⎇ ${gh.branch || '?'}  ·  ${sync}`)
  add('')
  const pr = gh.pr
  if (pr) {
    add(short(`${prWord(pr)}: ${pr.title}`, w), { bold: true })
    out.push({ link: { href: pr.url, label: short(pr.url, w) } })
    const review = reviewWord(pr)
    const reviewers = (pr.latestReviews || []).map(r => `${r.author?.login || '?'} ${String(r.state || '').toLowerCase().replace('_', ' ')}`)
    add(`${pr.headRefName} → ${pr.baseRefName}  ·  ${String(pr.mergeStateStatus || pr.mergeable || '').toLowerCase()}`, { dim: true })
    if (review || reviewers.length) add('review: ' + [review, ...reviewers].filter(Boolean).join(', '))
    const t = gh.checks
    add('')
    add(`CI  ${ciWord(t)}` + (t && t.pass + t.fail + t.pending ? `   (✓${t.pass} ✗${t.fail} …${t.pending}${t.skip ? ' skip ' + t.skip : ''})` : ''), {
      bold: true, color: t?.fail ? 'red' : t?.pending ? 'yellow' : 'green',
    })
    for (const c of t?.failing || []) add(short('  ✗ ' + c.name, w), { color: 'red' })
    for (const c of t?.waiting || []) add(short('  … ' + c.name, w), { color: 'yellow' })
  } else {
    add('No PR for this branch.', { dim: true })
  }
  if (gh.runs?.length) {
    add('')
    add('Latest runs on this branch', { bold: true })
    for (const r of gh.runs) {
      const st = runState(r)
      const mark = { pass: '✓', fail: '✗', pending: '…', skip: '–' }[st]
      add(short(`${mark} ${r.workflowName} · ${r.event} · ${ago(Date.parse(r.createdAt), now)} ago`, w), {
        color: st === 'fail' ? 'red' : st === 'pending' ? 'yellow' : undefined,
      })
    }
  }
  return out
}

export function chatItems(w, act, now) {
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const c = W.chain || { sessions: [] }
  const h = W.herdr
  const live = h?.panes || []
  const rowOf = id => c.sessions.find(s => s.id === id)
  const name = h?.tab ? `${h.label ? `"${h.label}"` : h.tab}` : W.tabId || 'this folder'
  const count = live.length ? `${live.length} pane${live.length === 1 ? '' : 's'}` : `${c.sessions.length} chat${c.sessions.length === 1 ? '' : 's'}`
  add(spread('◆ CHATS IN THIS TAB', `${name} · ${count}`, w), { bold: true, color: 'magenta' })
  if (c.overall) add('Overall: ' + c.overall, { wrap: true })
  else if (c.sessions.length > 1 && W.busy.overall) add('… summarizing the chain', { dim: true })
  if (h?.error) add(h.error, { color: 'red' })

  // What a recorded chat says about itself, under its row
  const details = (s, isNow) => {
    if (!s) return
    const facts = [
      s.turns ? `${s.turns} turns` : '',
      s.ctx != null ? `ctx ${s.ctx}%` : '',
      s.progress?.now ? `▶ ${s.progress.now}` : '',
      s.branch ? `⎇ ${s.branch}` : '',
      s.ended ? `ended (${s.ended})` : '',
    ].filter(Boolean).join(' · ')
    if (s.from) {
      const k = c.sessions.findIndex(x => x.id === s.from)
      add(`    ↳ from ${k >= 0 ? `chat ${s.from.slice(0, 8)}'s handoff note` : 'a handoff'}`, { dim: true })
    }
    const what = s.summary || (s.firstPrompt ? 'started with: ' + s.firstPrompt : '')
    if (what) add('    ' + what, { wrap: true, dim: !isNow })
    if (facts) add('    ' + facts, { dim: true })
  }

  // The tab's panes as herdr has them: a number jumps to one
  if (live.length) {
    add('')
    add('Live in herdr, newest first · a number jumps to that pane', { dim: true })
    live.forEach((p, i) => {
      const isNow = p.pane === h.pane
      const mark = STATUS_MARK[p.status] || '?'
      const label = `${i < 9 ? '' : '   '}${mark} ${p.status.padEnd(7)} ${short(p.title || p.agent, Math.max(10, w - 26))}${isNow ? '  ◀ here' : ''}`
      out.push({ buttons: [{
        key: 'pane:' + p.pane, ...(i < 9 ? { hotkey: String(i + 1) } : {}), plain: true, label,
        onPress: () => act?.focusPane(p.pane),
      }] })
      details(p.session && rowOf(p.session), isNow)
    })
  } else if (!c.sessions.length) {
    add('No chats recorded in this tab yet: this one is added at the end of its first turn.', { dim: true, wrap: true })
  }

  // Chats the tab held that no pane holds now
  const gone = [...c.sessions].reverse().filter(s => !live.some(p => p.session === s.id))
  if (gone.length) {
    add('')
    add(live.length ? 'Earlier chats, no longer in a pane' : 'Chats in this tab, newest first', { dim: true })
    for (const s of gone) {
      const isNow = s.id === W.sessionId
      add(short(`${isNow ? '▶' : ' '} ${s.id.slice(0, 8)}  ${clock(s.startedAt)} · ${isNow ? 'now' : `${ago(s.lastAt, now)} ago`}`, w), { bold: isNow })
      details(s, isNow)
      if (!isNow) out.push({ buttons: [{ key: 'resume:' + s.id, label: 'copy resume command', onPress: () => act?.copy(`claude --resume ${s.id}`) }], indent: 4 })
    }
  }
  add('')
  add('● working  ! needs you  ✓ finished, unseen  ○ idle', { dim: true })
  if (W.ctx !== null && W.ctx >= 80) add(`Context is ${W.ctx}% full: time to hand off soon.`, { color: 'yellow' })
  return out
}
