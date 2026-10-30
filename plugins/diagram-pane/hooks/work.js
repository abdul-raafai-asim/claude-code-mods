// work.js: what the pane's other tabs read, as plain functions with no `$`.
//
//   diffs   `git diff --numstat` and `git status` into one row per changed file
//   github  `gh pr view` and `gh run list` into a PR line and a CI tally
//   chats   the chain of sessions one terminal tab has held, across /clear,
//           handoffs and restarts
//   shots   the screenshots a conversation holds: image files its tools named,
//           and images that came back inline (a browser tool's screenshot)
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
const REVIEW_RE = /\b(review|audit|adversarial|critique|find (the )?bugs|verify (the )?findings)\b/i

// A command as a list of the commands it runs: heredoc bodies and quoted text
// dropped (a grep for "git push" pushes nothing), split at && || ; | and newlines,
// each without the VAR=value words before it
export function commandsIn(cmd) {
  return String(cmd || '')
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '<<')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    .split(/&&|\|\||[;|\n]/)
    .map(c => c.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(cd \S+\s*)$/, ''))
    .filter(Boolean)
}

// One command that runs tests: a runner in the command's own place, never a
// file name (jest.config.js) or an install (pip install pytest)
const TEST_RUNNER = /^((npx|pnpx|bunx|uv run|poetry run|python3? -m)\s+)?(pytest|jest|vitest|mocha|rspec|tox|phpunit|unittest)(\s|$)|^(go|cargo) test\b|^(npm|pnpm|yarn|bun)( run)? test\b|^claude plugin test\b|^make (test|check)\b|^(npx )?playwright test\b/
const GIT = /^git(\s+-[Cc]\s+\S+)*\s+/
const SHELL_EDIT_RE = /^sed -i\b|^python3? - <<|^python3? -\s*$|^cat >|^tee\b|^patch\b|^perl -p?i/

// The commit message a git commit names: -m "...", -am '...', or a heredoc's first line
export function commitMessage(cmd) {
  const m = /\s-[a-zA-Z]*m\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(cmd)
  if (m && !m[2].startsWith('$(')) return m[2].replace(/\\(.)/g, '$1').split('\n')[0]
  const h = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n\s*([^\n]+)/.exec(cmd)
  return h ? h[2].trim() : ''
}

// The signals of one tool call, in order: [{ stage, note, failed, file }].
// `after` says what came before, since an edit after a review is a fix and a
// test after a fix is a verify.
function signalsOf(t, after) {
  const i = t.input || {}
  const running = t.text === undefined && t.result === undefined && !t.isError
  if (t.tool === 'mcp__diagram-pane__progress_set') {
    if (!STAGES.includes(i.stage)) return []
    const of = i.total ? ` ${i.done ?? 0}/${i.total}` : ''
    return [{ stage: i.stage, note: (i.note || '') + of, declared: true }]
  }
  if (['ExitPlanMode', 'EnterPlanMode', 'TodoWrite'].includes(t.tool)) return [{ stage: 'plan', note: t.tool }]
  if (EDITS.includes(t.tool)) return [{ stage: after.has('review') ? 'fix' : 'implement', file: String(i.file_path || i.notebook_path || '') }]
  if (['Agent', 'Task'].includes(t.tool)) {
    if (i.subagent_type === 'Plan') return [{ stage: 'plan', note: i.description || 'Plan agent' }]
    if (REVIEW_RE.test(`${i.description || ''} ${i.prompt || ''}`.slice(0, 2000))) return [{ stage: 'review', note: i.description || 'review agent' }]
    return []
  }
  if (t.tool === 'Skill' && /review/.test(String(i.skill || ''))) return [{ stage: 'review', note: '/' + i.skill }]
  if (t.tool !== 'Bash') return []
  const raw = String(i.command || '')
  const out = []
  const seen = new Set(after)
  for (const c of commandsIn(raw)) {
    let sig = null
    const g = GIT.test(c) ? c.replace(GIT, '') : null
    if (g?.startsWith('commit')) sig = { stage: 'commit', note: commitMessage(raw) }
    else if (g?.startsWith('push')) sig = { stage: 'push' }
    else if (/^gh pr create\b/.test(c)) sig = { stage: 'pr', note: 'gh pr create' }
    else if (/^gh pr merge\b/.test(c)) sig = { stage: 'merge', note: 'gh pr merge' }
    else if (TEST_RUNNER.test(c)) sig = { stage: seen.has('fix') ? 'verify' : 'test', note: c.split(/\s+/).slice(0, 3).join(' '), test: true }
    else if (SHELL_EDIT_RE.test(c)) sig = { stage: seen.has('review') ? 'fix' : 'implement' }
    if (sig) {
      out.push(sig)
      seen.add(sig.stage)
    }
  }
  // Which part of a chain failed is not said: the last part that marks a stage
  // carries the call's outcome, and the parts before it went through
  const last = out.at(-1)
  if (last) {
    if (running) last.note = [last.note, 'running'].filter(Boolean).join(' · ')
    else {
      last.failed = Boolean(t.isError)
      if (last.test) last.note += t.isError ? ' · failed' : ' · passed'
      else if (t.isError) last.note = [last.note, 'failed'].filter(Boolean).join(' · ')
    }
  }
  return out
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
      for (const sig of signalsOf(t, after)) {
        const s = (stages[sig.stage] ||= { turn, files: [] })
        s.last = turn
        if (sig.note) s.note = sig.note
        if (sig.file && !s.files.includes(sig.file)) s.files.push(sig.file)
        s.failed = Boolean(sig.failed)
        after.add(sig.stage)
        now = sig.stage
        declared = sig.declared ? sig.note : null
      }
    }
  }
  // A chat that came from a handoff starts where the one before it stood
  if (seed?.stages) {
    for (const [name, s] of Object.entries(seed.stages)) if (!stages[name]) stages[name] = { ...s, inherited: true }
    if (!now) now = seed.now
  }
  if (pr) {
    if (!stages.pr) stages.pr = { turn: null, files: [], note: `#${pr.number}` }
    // Once pushed, the work waits on CI and then the merge; a later edit or
    // test is the work again, and stays the stage
    const waiting = !now || STAGES.indexOf(now) >= STAGES.indexOf('push')
    if (checks && checks.pass + checks.fail + checks.pending > 0) {
      stages.ci = { turn: null, files: [], note: checks.fail ? `${checks.fail} failing` : checks.pending ? `${checks.pending} running` : `${checks.pass} passed`, failed: checks.fail > 0, running: checks.pending > 0 }
      if (waiting && now !== 'merge') now = 'ci'
    }
    if (pr.state === 'MERGED') {
      stages.merge = { turn: stages.merge?.turn ?? null, files: [], note: 'merged' }
      if (waiting) now = 'merge'
    }
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
    else if (s) mark = s.failed ? '✗' : s.running ? '…' : '✓'
    else if (i < at) mark = '–'
    return { name, mark, ...(s || {}) }
  })
}

// One pane per herdr tab. `rec` is the tab's record ({ owner, hidden }), `me`
// this chat's herdr pane, `live` the tab's agent panes (null when unknown).
// A chat claims the pane when it is new to the tab (a handoff's chat takes over
// from the one it left) or the owner's pane is gone. It shows the pane when it
// owns it and nobody hid it. Outside herdr every chat has a terminal pane of
// its own, so it always shows.
export function paneOwner(rec, me, live, { fresh = false } = {}) {
  if (!me) return { show: true, claim: false }
  const owner = rec?.owner || null
  const alive = Boolean(owner) && (owner === me || !live || live.some(p => p.pane === owner))
  const mine = owner === me || fresh || !alive
  // Off until /diagram: only showHere writes hidden: false
  return { show: mine && rec?.hidden === false, claim: mine && owner !== me }
}

// A short id for a piece of text (djb2, base 36)
export function textHash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

// An absolute or ~ path to an image, not inside a URL (https://x/a.png)
const IMAGE_PATH = /(?<![\w:/.~-])(?:~\/|\/(?!\/))[^\s'"`<>()|,;*?]*\.(?:png|jpe?g|gif|webp)(?![\w.])/gi
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i
// Input fields a tool names its output file in, where a relative path counts too
const PATH_FIELDS = ['file_path', 'path', 'filename', 'filePath', 'output', 'outputPath', 'savePath', 'screenshotPath']

export function imagePathsIn(text) {
  return String(text ?? '').match(IMAGE_PATH) || []
}

// Every image path a tool call names: in any string of its input, or in what it returned
function pathsOfToolUse(use, cwd, home) {
  const found = []
  const visit = (value, key) => {
    if (typeof value === 'string') {
      found.push(...imagePathsIn(value))
      const isRelativeFile = PATH_FIELDS.includes(key) && IMAGE_FILE.test(value) && !/^[/~]/.test(value)
      if (isRelativeFile) found.push(`${cwd}/${value.replace(/^\.\//, '')}`)
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v, key)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k)
    }
  }
  visit(use.input, '')
  found.push(...imagePathsIn(use.text))
  const absolute = found.map(p => (p.startsWith('~/') ? home + p.slice(1) : p))
  return [...new Set(absolute)]
}

// What one tool use was, for the shot's caption: `Read`, `claude-in-chrome computer`
export function toolCaption(tool) {
  return String(tool).replace(/^mcp__/, '').replace(/__/g, ' ')
}

// The screenshots of one conversation, oldest first. `rows` is it as
// $.session.messages() returns it, `api` as $.session.messages({ as: 'api' }).
// Files are every image path a tool named (existence is the caller's check).
// Inline images are image blocks in tool results, and images pasted into a
// prompt; one a tool read from a file it named is left to that file.
export function shotsIn(rows, api, { cwd = '', home = '', from = 'main' } = {}) {
  const files = []
  const pathsByUse = {}
  for (const m of rows || []) {
    for (const use of m.toolUses || []) {
      const paths = pathsOfToolUse(use, cwd, home)
      pathsByUse[use.tool_use_id] = paths
      for (const path of paths) files.push({ kind: 'file', path, tool: use.tool, from, order: files.length })
    }
  }

  const inline = []
  const toolOf = {}
  const addImage = (block, tool, from) => {
    const data = block.source?.type === 'base64' ? String(block.source.data || '') : ''
    if (!data) return
    const media = String(block.source.media_type || 'image/png')
    const id = 'i' + textHash(`${media}:${data.length}:${data.slice(0, 4096)}:${data.slice(-4096)}`)
    inline.push({ kind: 'inline', id, media, data, tool, from, order: inline.length })
  }
  for (const m of api || []) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === 'tool_use') toolOf[block.id] = block.name
      if (block.type === 'image' && m.role === 'user') addImage(block, 'pasted', from)
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue
      if (pathsByUse[block.tool_use_id]?.length) continue
      for (const part of block.content) {
        if (part.type === 'image') addImage(part, toolOf[block.tool_use_id] || 'tool', from)
      }
    }
  }
  return { files, inline }
}

// The Agent tool uses of a conversation that spawned an agent: its id and task
export function agentsIn(rows) {
  const agents = []
  for (const m of rows || []) {
    for (const use of m.toolUses || []) {
      if (use.agentId) agents.push({ id: use.agentId, task: String(use.input?.description || 'subagent') })
    }
  }
  return agents
}

// How many rows and columns a picture of `width` x `height` pixels takes in a
// pane `w` columns wide: a terminal cell is about twice as tall as it is wide
const CELL_ASPECT = 0.5
export function shotBox(width, height, w, maxRows = 48) {
  const ratio = height / Math.max(1, width)
  let columns = Math.max(1, Math.min(255, w))
  let rows = Math.round(columns * ratio * CELL_ASPECT)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round(rows / ratio / CELL_ASPECT))
  }
  return { columns, rows: Math.max(1, Math.min(255, rows)) }
}
