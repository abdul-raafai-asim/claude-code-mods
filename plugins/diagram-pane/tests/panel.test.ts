import { expect, mock, test } from 'claude-code/testing'
import {
  ciWord, changedFiles, parseNameStatus, handoffFrom, joinChain, parseNumstat, renamedTo, splitDiff, tabIdFrom, tallyChecks,
} from '../hooks/work.js'
import { fitDiff, plain } from '../hooks/panel.js'

// The diffs, github and chats tabs: what git and gh print, and what the pane draws from it

const DIFF = `diff --git a/src/pay.js b/src/pay.js
index 1111111..2222222 100644
--- a/src/pay.js
+++ b/src/pay.js
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a }
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3333333..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone`

test('numstat rows take a rename\'s new name', () => {
  expect(renamedTo('src/{a => b}/x.js')).toBe('src/b/x.js')
  expect(renamedTo('a.js => b.js')).toBe('b.js')
  expect(parseNumstat('3\t1\tsrc/pay.js\n-\t-\timg.png\n')).toEqual([
    { path: 'src/pay.js', add: 3, del: 1, binary: false },
    { path: 'img.png', add: 0, del: 0, binary: true },
  ])
})

test('a diff splits per file, each with its hunks only', () => {
  const files = splitDiff(DIFF)
  expect(Object.keys(files)).toEqual(['src/pay.js', 'old.txt'])
  expect(files['src/pay.js'].startsWith('@@ -1,3 +1,4 @@')).toBe(true)
  expect(files['src/pay.js']).not.toContain('index ')
})

test('untracked files join the changed files', () => {
  const files = changedFiles({ numstat: '2\t1\tsrc/pay.js\n', status: ' M src/pay.js\n?? notes.md\n', untracked: { 'notes.md': 4 } })
  expect(files.map(f => [f.path, f.status, f.add])).toEqual([['src/pay.js', 'M', 2], ['notes.md', '?', 4]])
})

test('checks tally to one CI word, a re-run counted once', () => {
  const t = tallyChecks([
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' },
    { name: 'test', status: 'IN_PROGRESS', conclusion: '', workflowName: 'ci' },
    { context: 'deploy', state: 'FAILURE' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'ci' },
  ])
  expect([t.pass, t.pending, t.fail]).toEqual([1, 1, 1])
  expect(ciWord(t)).toBe('✗ 1 failing')
  expect(ciWord(tallyChecks([]))).toBe('no checks')
})

test('a tab\'s chain grows per session, and starts over for another project', () => {
  expect(tabIdFrom({ HERDR_TAB_ID: 'wK:t1', TERM_SESSION_ID: 'x' })).toBe('herdr:wK:t1')
  expect(tabIdFrom({})).toBe(null)
  let c = joinChain(null, { id: 'aaaaaaaa-1', root: '/r' }, 1000)
  c = joinChain(c, { id: 'bbbbbbbb-2', root: '/r', from: 'aaaaaaaa-1' }, 2000)
  c = joinChain(c, { id: 'aaaaaaaa-1', root: '/r', turns: 9 }, 3000)
  expect(c.sessions.map((s: any) => [s.id, s.turns])).toEqual([['aaaaaaaa-1', 9], ['bbbbbbbb-2', undefined]])
  const other = joinChain(c, { id: 'cccccccc-3', root: '/elsewhere' }, 4000)
  expect(other.sessions.map((s: any) => s.id)).toEqual(['cccccccc-3'])
  expect(handoffFrom(['read HANDOFF-aaaaaaaa.md and go on'], c.sessions)).toBe('aaaaaaaa-1')
  expect(handoffFrom(['fix the bug'], c.sessions)).toBe(null)
})

// ---------------------------------------------------------------------------
// The pane, with git and gh answered here
// ---------------------------------------------------------------------------

const PR = {
  number: 42, title: 'Add discounts', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', headRefName: 'feat/discount', baseRefName: 'main', mergeStateStatus: 'BLOCKED',
  latestReviews: [], statusCheckRollup: [
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x' },
  ],
}

function world(on: any) {
  mock.store(on)
  mock.env(on, { HERDR_TAB_ID: 'wK:t1' })
  mock.clock(on)
  on('session.id', () => ({ value: 'sess-0001-aaaa' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 41 }, rateLimits: [] } }))
  on('ui.panes', () => ({ value: [{ id: 'diagrams', title: 'Diagrams', isPlaced: true }] }))
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'add a discount step to checkout', toolUses: [] },
    { role: 'assistant', text: 'done', toolUses: [{ tool: 'Edit', input: { file_path: '/repo/src/pay.js' } }] },
  ] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a\nb\n' }))
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const no = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_: any, e: any) => {
    const a = e.argv.join(' ').replace('git -c core.quotePath=false', 'git')
    if (a === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (a === 'git rev-parse --abbrev-ref HEAD') return ok('feat/discount\n')
    if (a.startsWith('git symbolic-ref')) return ok('origin/main\n')
    if (a.startsWith('git merge-base')) return ok('abc123\n')
    if (a.startsWith('git diff --numstat')) return ok('2\t1\tsrc/pay.js\n0\t1\told.txt\n')
    if (a.startsWith('git status')) return ok(' M src/pay.js\n D old.txt\n?? notes.md\n')
    if (a.startsWith('git diff --name-status')) return ok('M\tsrc/pay.js\nD\told.txt\n')
    if (a.startsWith('git diff -M')) return ok(DIFF)
    if (a.startsWith('git rev-list -1 --before=')) return ok('abc999\n')
    if (a.startsWith('git log --format=@%ct')) return ok('@1700000000\nsrc/pay.js\n')
    if (a.startsWith('git log')) return ok('dfe8070 add discounts\n')
    if (a.startsWith('git fetch')) return ok('')
    if (a.startsWith('git rev-list')) return ok('0\t3\n')
    if (a.startsWith('gh pr view')) return ok(JSON.stringify(PR))
    if (a.startsWith('gh run list')) return ok('[]')
    return no('unexpected: ' + a)
  })
}

const mount = ($: any) => $.ui.mount({
  plugin: 'diagram-pane', surface: 'terminal', component: 'Pane', requestId: 'diagrams',
  props: { title: 'Diagrams', isFocused: true, bodyColumns: 70, placement: 'dock' } as never,
})

const has = async (ui: any, text: RegExp) => expect(await ui.find({ type: 'Text', text } as never)).toBeDefined()

test('the diffs tab lists the changed files and opens one as a diff', async ($, on) => {
  world(on)
  await $.command.run({ command: 'diagram', args: 'diffs' } as never)
  const ui = await mount($)
  await has(ui, /⎇ feat\/discount · PR #42 open · CI ✗ 1 failing · 3 files \+4 −2/)
  await has(ui, /DIFFS this chat \(since/)
  await has(ui, /1 commit in this range/)
  await ui.press({ key: 'mode' } as never)
  await has(ui, /DIFFS (PR #42|branch) vs main/)
  expect((await ui.find({ key: 'file:src/pay.js' } as never))?.text).toContain('✎')
  await ui.press({ key: 'file:src/pay.js' } as never)
  await has(ui, /◆ src\/pay\.js/)
  const code = await ui.find({ type: 'Code' } as never)
  expect(code).toBeDefined()
  expect(await ui.find({ type: 'Link' } as never)).toBeDefined()
  await has(ui, /committed .*ago/)
  await ui.press({ key: 'next' } as never)
  await has(ui, /◆ old\.txt/)
  await ui.press({ key: 'back' } as never)
  await has(ui, /DIFFS (PR #42|branch) vs main/)
})

test('the github tab shows the PR, its review and the failing check', async ($, on) => {
  world(on)
  const ui = await mount($)
  await ui.press({ key: 'tab:github' } as never)
  await has(ui, /PR #42 open: Add discounts/)
  await has(ui, /3 ahead, 0 behind/)
  await has(ui, /review: review required/)
  await has(ui, /✗ test/)
})

test('the chats tab records this session under the terminal tab', async ($, on) => {
  world(on)
  const ui = await mount($)
  await ui.press({ key: 'tab:chats' } as never)
  await has(ui, /CHATS IN THIS TAB/)
  await has(ui, /1 chat · herdr:wK:t1/)
  await has(ui, /▶ 1\. sess-000/)
  await has(ui, /started with: add a discount step/)
})

test('a diff loses carriage returns and keeps whole hunks when long', () => {
  expect(fitDiff('@@ -1 +1 @@\n-a\r\n+b\r').source).toBe('@@ -1 +1 @@\n-a\n+b')
  const hunk = '@@ -1,1 +1,1 @@\n' + '+' + 'x'.repeat(20000)
  const r = fitDiff([hunk, hunk, hunk, hunk].join('\n'))
  expect(r.cut).toBe(2)
  expect(r.source.split('\n@@').length).toBe(2)
})

test('a hunk line that opens with -- or ++ stays in the hunk', () => {
  const d = 'diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ b/x\n select 1'
  expect(splitDiff(d)).toEqual({ 'q.sql': '@@ -1,2 +1,2 @@\n--- old comment\n+++ b/x\n select 1' })
})

test('letters come from the change against the base, not from git status', () => {
  expect(parseNameStatus('A\tnew.js\nR087\told.js\tmoved.js\nD\tgone.js\n')).toEqual({ 'new.js': 'A', 'moved.js': 'R', 'gone.js': 'D' })
  const files = changedFiles({ numstat: '5\t0\tnew.js\n', status: '', nameStatus: 'A\tnew.js\n' })
  expect(files[0].status).toBe('A')
})

test('a first prompt with terminal colours becomes plain text', () => {
  expect(plain('\x1b[31merror\x1b[0m in\tfile\x07')).toBe('error in file')
})

test('the oldest of a tab\'s chain stays when a later chat starts in the same project', () => {
  let c = joinChain(null, { id: 'a', root: '/home' }, 1000)
  c = joinChain(c, { id: 'b', root: '/home' }, 2000)
  expect(c.sessions.length).toBe(2)
})
