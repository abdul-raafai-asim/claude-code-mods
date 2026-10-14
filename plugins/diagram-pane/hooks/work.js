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
