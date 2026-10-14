// work.js: what the pane's other tabs read, as plain functions with no `$`.
//
//   diffs   `git diff --numstat` and `git status` into one row per changed file
//   github  `gh pr view` and `gh run list` into a PR line and a CI tally
//   chats   the chain of sessions one terminal tab has held, across /clear,
//           handoffs and restarts
//
// register.js runs the commands and keeps the results; everything here is
// pure, so the tests feed it text and read what comes back.

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

// `git diff --numstat` names a rename as `old => new` or `dir/{old => new}/f`:
// the file is the new name
export function renamedTo(path) {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (braced) return (braced[1] + braced[3] + braced[4]).replace(/\/\//g, '/')
  const plain = /^(.*) => (.*)$/.exec(path)
  return plain ? plain[2] : path
}

// One row per file: { path, add, del, binary }
export function parseNumstat(text) {
  return String(text || '').split('\n').filter(Boolean).map(line => {
    const [add, del, ...rest] = line.split('\t')
    const binary = add === '-' && del === '-'
    return { path: renamedTo(rest.join('\t')), add: binary ? 0 : Number(add) || 0, del: binary ? 0 : Number(del) || 0, binary }
  })
}

// `git status --porcelain`: path -> the two status letters, `??` for untracked
export function parseStatus(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ').pop()
    out[path.replace(/^"|"$/g, '')] = code
  }
  return out
}

// What a status code means, in one letter the list shows
export function statusLetter(code, isNew) {
  if (!code) return isNew ? 'A' : 'M'
  if (code === '??') return '?'
  const c = code.trim()[0]
  return { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'M' }[c] || 'M'
}

// `git diff --name-status` against the base: path -> its letter (R100 is R)
export function parseNameStatus(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const [code, ...paths] = line.split('\t')
    if (code && paths.length) out[paths.at(-1)] = code[0]
  }
  return out
}

// The changed files: numstat rows merged with untracked files (which numstat
// never lists). The letter is the change against the base (`nameStatus`),
// which `git status` cannot say for what the branch already committed.
export function changedFiles({ numstat, status, nameStatus, untracked = {} }) {
  const rows = parseNumstat(numstat)
  const codes = parseStatus(status)
  const letters = parseNameStatus(nameStatus)
  const seen = new Set(rows.map(r => r.path))
  for (const [path, code] of Object.entries(codes)) {
    if (code === '??' && !seen.has(path) && !path.endsWith('/')) {
      rows.push({ path, add: untracked[path] ?? 0, del: 0, binary: false })
      seen.add(path)
    }
  }
  return rows.map(r => ({ ...r, status: codes[r.path] === '??' ? '?' : letters[r.path] || statusLetter(codes[r.path]) }))
}

// A unified diff split per file: { path -> the file's hunks, headers dropped }
export function splitDiff(text) {
  const files = {}
  let path = null
  let body = []
  const flush = () => {
    if (path !== null && body.length) files[path] = body.join('\n')
  }
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      body = []
      // `diff --git a/x b/x`: the b side is the file as it is now
      const m = / b\/(.*)$/.exec(line)
      path = m ? m[1] : null
      continue
    }
    if (path === null) continue
    // Inside a hunk every line is the file's own, even one that opens with --- or +++
    if (body.length) {
      body.push(line)
      continue
    }
    if (line.startsWith('+++ ')) {
      const m = /^\+\+\+ b\/(.*)$/.exec(line)
      if (m) path = m[1]
      continue
    }
    if (line.startsWith('@@')) body.push(line)
  }
  flush()
  return files
}

// `git log --format=@%ct --name-only`, newest first: path -> when a commit
// last changed it, in ms
export function lastCommitted(text) {
  const out = {}
  let at = 0
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('@')) at = Number(line.slice(1)) * 1000
    else if (line && !(line in out)) out[line] = at
  }
  return out
}

// The hunks of one file's diff, each with the line it starts at in the new file
export function hunksOf(diff) {
  return String(diff || '').split(/\n(?=@@ )/).filter(h => h.startsWith('@@')).map(text => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text)
    return { text, line: m ? Math.max(1, Number(m[1])) : 1 }
  })
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

// A check from statusCheckRollup is a CheckRun (status, conclusion) or a
// StatusContext (state): both come out as pass, fail, pending or skip
export function checkState(c) {
  const s = String(c.conclusion || c.state || c.status || '').toUpperCase()
  if (['SUCCESS', 'NEUTRAL'].includes(s)) return 'pass'
  if (['SKIPPED', 'STALE', 'CANCELLED'].includes(s)) return 'skip'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'fail'
  return 'pending'
}

export function tallyChecks(rollup) {
  const t = { pass: 0, fail: 0, pending: 0, skip: 0, failing: [], waiting: [] }
  const seen = new Set()
  for (const c of rollup || []) {
    const name = c.name || c.context || 'check'
    // A re-run lists the check again: the latest one counts
    const key = `${c.workflowName || ''}/${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const st = checkState(c)
    t[st] += 1
    if (st === 'fail') t.failing.push({ name, url: c.detailsUrl || c.targetUrl || '' })
    if (st === 'pending') t.waiting.push({ name, url: c.detailsUrl || c.targetUrl || '' })
  }
  return t
}

// The CI word the strip shows
export function ciWord(t) {
  if (!t || t.pass + t.fail + t.pending + t.skip === 0) return 'no checks'
  if (t.fail) return `✗ ${t.fail} failing`
  if (t.pending) return `… ${t.pending} running`
  return `✓ ${t.pass} passed`
}

export function prWord(pr) {
  if (!pr) return 'no PR'
  const state = pr.isDraft && pr.state === 'OPEN' ? 'draft' : String(pr.state || '').toLowerCase()
  return `PR #${pr.number} ${state}`
}

export function reviewWord(pr) {
  const d = String(pr?.reviewDecision || '')
  return { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[d] || ''
}

// A workflow run from `gh run list` as one state, like a check
export function runState(r) {
  return checkState({ status: r.status, conclusion: r.conclusion })
}

// ---------------------------------------------------------------------------
// Chats: the chain of sessions in one terminal tab
// ---------------------------------------------------------------------------

// What names "this tab": a multiplexer's or a terminal's own id for it, the
// first one set. With none, the project folder stands for the tab.
export function tabIdFrom(env) {
  for (const [name, prefix] of [
    ['HERDR_TAB_ID', 'herdr'], ['TMUX_PANE', 'tmux'], ['ZELLIJ_PANE_ID', 'zellij'], ['WEZTERM_PANE', 'wezterm'],
    ['KITTY_WINDOW_ID', 'kitty'], ['ITERM_SESSION_ID', 'iterm'], ['TERM_SESSION_ID', 'term'],
  ]) {
    if (env[name]) return `${prefix}:${env[name]}`
  }
  return null
}

const DAY = 24 * 60 * 60 * 1000

// Add or update `session` (by id) in `chain`. A tab reused for other work
// (another project, or after a day idle) starts a new chain instead.
// Returns the chain to keep.
export function joinChain(chain, session, now) {
  const fresh = { sessions: [], startedAt: now, overall: '' }
  let c = chain && Array.isArray(chain.sessions) ? chain : fresh
  const last = c.sessions.at(-1)
  const known = c.sessions.some(s => s.id === session.id)
  if (!known && last && ((last.root && last.root !== session.root) || now - (last.lastAt || 0) > DAY)) c = fresh
  const sessions = known
    ? c.sessions.map(s => (s.id === session.id ? { ...s, ...session } : s))
    : [...c.sessions, { ...session, startedAt: session.startedAt ?? now }]
  return { ...c, sessions: sessions.slice(-30) }
}

// A session that names an earlier one's handoff note (HANDOFF-<8 chars>.md)
// came from it
export function handoffFrom(texts, sessions) {
  const all = texts.join('\n')
  for (const s of sessions) {
    const short = String(s.id).slice(0, 8)
    if (all.includes(`HANDOFF-${short}`)) return s.id
  }
  return /\bhand-?off\b/i.test(all) ? 'unknown' : null
}

// `herdr pane list` JSON -> the agent panes of one tab, newest first. herdr's
// ids count up in base 36 (`wJ:p1F` after `wJ:pZ`), so the order is the order
// the panes were made: a handoff's new pane comes after the one it left.
export function herdrPanes(json, tabId) {
  let panes
  try {
    panes = (typeof json === 'string' ? JSON.parse(json) : json)?.result?.panes || []
  } catch {
    return []
  }
  const order = id => parseInt(String(id).split(':p')[1] || '0', 36) || 0
  return panes
    .filter(p => p.tab_id === tabId && p.agent)
    .map(p => ({
      pane: p.pane_id,
      agent: p.agent,
      status: p.agent_status || 'unknown',
      session: p.agent_session?.value || null,
      title: p.terminal_title_stripped || p.terminal_title || '',
      focused: Boolean(p.focused),
    }))
    .sort((a, b) => order(b.pane) - order(a.pane))
}

export const STATUS_MARK = { working: '●', blocked: '!', done: '✓', idle: '○', unknown: '?' }

// ---------------------------------------------------------------------------
// Small words
// ---------------------------------------------------------------------------

export function ago(ms, now) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < DAY / 1000) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function clock(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// A path cut from the left, so the file name stays
export function leftCut(path, n) {
  return path.length <= n ? path : '…' + path.slice(path.length - n + 1)
}

// ---------------------------------------------------------------------------
// Progress: which stage of the work the chat is in
// ---------------------------------------------------------------------------

export const STAGES = ['plan', 'implement', 'test', 'review', 'fix', 'verify', 'commit', 'push', 'pr', 'ci', 'merge']

const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const TEST_RE = /(\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|\brspec\b|\bgo test\b|\bcargo test\b|\b(npm|pnpm|yarn|bun)( run)? test\b|\bplugin test\b|\bmake test\b|\btox\b|\bphpunit\b|\bplaywright test\b|\bunittest\b)/
const SHELL_EDIT_RE = /\bsed -i\b|\bpython3? - <<|\bcat >+ |\btee \b|\bpatch -p/
const REVIEW_RE = /\b(review|audit|adversarial|critique|find (the )?bugs|verify (the )?findings)\b/i

// One signal from a tool call: { stage, note } or null. `after` says what has
// happened before it, since an edit after a review is a fix and a test after
// a fix is a verify.
function signalOf(t, after) {
  const i = t.input || {}
  if (t.tool === 'mcp__diagram-pane__progress_set' && STAGES.includes(i.stage)) {
    const of = i.total ? ` ${i.done ?? 0}/${i.total}` : ''
    return { stage: i.stage, note: (i.note || '') + of, declared: true }
  }
  if (['ExitPlanMode', 'EnterPlanMode', 'TodoWrite'].includes(t.tool)) return { stage: 'plan', note: t.tool }
  if (EDITS.includes(t.tool)) {
    return { stage: after.has('review') ? 'fix' : 'implement', file: String(i.file_path || i.notebook_path || '') }
  }
  if (['Agent', 'Task'].includes(t.tool)) {
    if (i.subagent_type === 'Plan') return { stage: 'plan', note: i.description || 'Plan agent' }
    if (REVIEW_RE.test(`${i.description || ''} ${i.prompt || ''}`.slice(0, 2000))) return { stage: 'review', note: i.description || 'review agent' }
    return null
  }
  if (t.tool === 'Skill' && /review/.test(String(i.skill || ''))) return { stage: 'review', note: '/' + i.skill }
  if (t.tool !== 'Bash') return null
  const cmd = String(i.command || '')
  if (/\bgh pr merge\b/.test(cmd)) return { stage: 'merge', note: 'gh pr merge' }
  if (/\bgh pr create\b/.test(cmd)) return { stage: 'pr', note: 'gh pr create' }
  if (/\bgit push\b/.test(cmd)) return { stage: 'push', note: t.isError ? 'failed' : '' }
  if (/\bgit commit\b/.test(cmd)) {
    const m = /-m\s+(["'])(.*?)\1/.exec(cmd) || /\n([^\n]{4,})\n/.exec(cmd.split('<<')[1] || '')
    return { stage: 'commit', note: m ? (m[2] || m[1]).split('\n')[0] : '' }
  }
  if (TEST_RE.test(cmd)) return { stage: after.has('fix') ? 'verify' : 'test', note: (TEST_RE.exec(cmd)[0]) + (t.isError ? ' · failed' : ' · passed'), failed: Boolean(t.isError) }
  if (SHELL_EDIT_RE.test(cmd)) return { stage: after.has('review') ? 'fix' : 'implement' }
  return null
}

// The stages as the transcript shows them: { stages: { name -> { turn, last,
// note, files, failed } }, now, declared }. CI and merge come from the PR.
export function progressFrom(messages, { pr, checks, seed } = {}) {
  const stages = {}
  let now = null
  let declared = null
  let turn = 0
  const after = new Set()
  for (const m of messages || []) {
    if (m.role === 'user' && m.text && !m.toolResults?.length) turn++
    for (const t of m.toolUses || []) {
      const sig = signalOf(t, after)
      if (!sig) continue
      const s = (stages[sig.stage] ||= { turn, files: [] })
      s.last = turn
      if (sig.note) s.note = sig.note
      if (sig.file && !s.files.includes(sig.file)) s.files.push(sig.file)
      if ('failed' in sig) s.failed = sig.failed
      after.add(sig.stage)
      now = sig.stage
      declared = sig.declared ? sig.note : null
    }
  }
  if (pr) {
    if (!stages.pr) stages.pr = { turn: null, files: [], note: `#${pr.number}` }
    if (checks && checks.pass + checks.fail + checks.pending > 0) {
      stages.ci = { turn: null, files: [], note: checks.fail ? `${checks.fail} failing` : checks.pending ? `${checks.pending} running` : `${checks.pass} passed`, failed: checks.fail > 0, running: checks.pending > 0 }
      // Once pushed, the work waits on CI; a later fix or test is the work again
      if (STAGES.indexOf(now) >= STAGES.indexOf('push')) now = 'ci'
    }
    if (pr.state === 'MERGED') {
      stages.merge = { turn: stages.merge?.turn ?? null, files: [], note: 'merged' }
      now = 'merge'
    }
  }
  // A chat that came from a handoff starts where the one before it stood
  if (seed?.stages) {
    for (const [name, s] of Object.entries(seed.stages)) if (!stages[name]) stages[name] = { ...s, inherited: true }
    if (!now) now = seed.now
  }
  return { stages, now, declared }
}

// Each stage's mark: ✓ done, ▶ now, ✗ failed, – skipped, · not yet
export function stageRows(p) {
  const at = STAGES.indexOf(p.now)
  return STAGES.map((name, i) => {
    const s = p.stages[name]
    let mark = '·'
    if (name === p.now) mark = s?.failed ? '✗' : '▶'
    else if (s) mark = s.failed ? '✗' : '✓'
    else if (i < at) mark = '–'
    return { name, mark, ...(s || {}) }
  })
}
