import { expect, mock, test } from 'claude-code/testing'

// The pane stays off until the person types /diagram: a new chat, a resumed
// one and a handoff all start with it closed, in herdr and outside it

const FILE = '/home/.claude/diagram-pane/tabs/wK_t1.json'

function world(on: any, env: Record<string, string>) {
  const files: Record<string, string> = {}
  const pane = { up: false, opens: 0 }
  mock.store(on)
  mock.clock(on)
  mock.env(on, { HOME: '/home', DIAGRAM_PANE_SYNC: '1', ...env })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('fs.read', (_: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('ui.panes', () => ({ value: pane.up ? [{ id: 'diagrams', title: 'Diagrams', isPlaced: true }] : [] }))
  on('ui.open', () => ((pane.up = true), pane.opens++, { value: { isPlaced: true } }))
  on('ui.close', () => ((pane.up = false), { value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'test' } }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'test' } }))
  return { files, pane }
}

test('outside herdr a new chat starts with the pane closed, and /diagram opens it', async ($, on) => {
  const w = world(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: 'flowchart TD\n  a[x.js]' } as never)
  expect(w.pane.opens).toBe(0)
  await $.command.run({ command: 'diagram', args: '' } as never)
  expect(w.pane.up).toBe(true)
})

test('in a herdr tab with no record a new chat starts with the pane closed', async ($, on) => {
  const w = world(on, { HERDR_ENV: '1', HERDR_TAB_ID: 'wK:t1', HERDR_PANE_ID: 'wK:p2', HERDR_BIN_PATH: '/bin/herdr' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(w.pane.opens).toBe(0)
})

test('a handoff in a tab where /diagram showed the pane takes it over', async ($, on) => {
  const w = world(on, { HERDR_ENV: '1', HERDR_TAB_ID: 'wK:t1', HERDR_PANE_ID: 'wK:p2', HERDR_BIN_PATH: '/bin/herdr' })
  w.files[FILE] = JSON.stringify({ owner: 'wK:p1', hidden: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(w.pane.up).toBe(true)
})
