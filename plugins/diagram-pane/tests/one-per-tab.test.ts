import { expect, mock, test } from 'claude-code/testing'
import { paneOwner } from '../hooks/work.js'

// One pane per herdr tab: the chat that owns the tab's record shows it, the
// others keep it closed, and hiding it hides it for the whole tab

const LIVE = [{ pane: 'wK:p1' }, { pane: 'wK:p2' }]

test('the owner shows the pane, a new chat takes it over, a dead owner loses it', () => {
  expect(paneOwner(null, 'wK:p1', null)).toEqual({ show: true, claim: true })
  expect(paneOwner({ owner: 'wK:p1' }, 'wK:p1', null)).toEqual({ show: true, claim: false })
  expect(paneOwner({ owner: 'wK:p1' }, 'wK:p2', LIVE)).toEqual({ show: false, claim: false })
  // herdr unknown: the owner is taken to be alive
  expect(paneOwner({ owner: 'wK:p1' }, 'wK:p2', null)).toEqual({ show: false, claim: false })
  expect(paneOwner({ owner: 'wK:p1' }, 'wK:p2', LIVE, { fresh: true })).toEqual({ show: true, claim: true })
  expect(paneOwner({ owner: 'wK:p9' }, 'wK:p2', LIVE)).toEqual({ show: true, claim: true })
  // Hidden stays hidden for whoever owns it, a new chat included
  expect(paneOwner({ owner: 'wK:p1', hidden: true }, 'wK:p1', null)).toEqual({ show: false, claim: false })
  expect(paneOwner({ owner: 'wK:p1', hidden: true }, 'wK:p2', LIVE, { fresh: true })).toEqual({ show: false, claim: true })
  // Outside herdr each chat has its own terminal pane
  expect(paneOwner({ owner: 'wK:p1' }, null, null)).toEqual({ show: true, claim: false })
})

const FILE = '/home/.claude/diagram-pane/tabs/wK_t1.json'

function world(on: any) {
  const files: Record<string, string> = {}
  const pane = { up: true, placed: true, opens: 0, closes: 0 }
  mock.store(on)
  mock.clock(on)
  mock.env(on, { HERDR_ENV: '1', HERDR_TAB_ID: 'wK:t1', HERDR_PANE_ID: 'wK:p2', HERDR_WORKSPACE_ID: 'wK', HERDR_BIN_PATH: '/bin/herdr', HOME: '/home', DIAGRAM_PANE_SYNC: '1' })
  on('session.id', () => ({ value: 's2' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] }))
  on('fs.read', (_: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('ui.panes', () => ({ value: pane.up ? [{ id: 'diagrams', title: 'Diagrams', isPlaced: pane.placed }] : [] }))
  on('ui.open', () => ((pane.up = true), (pane.placed = true), pane.opens++, { value: { isPlaced: true } }))
  on('ui.close', () => ((pane.up = false), pane.closes++, { value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'test' } }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'test' } }))
  const rec = () => JSON.parse(files[FILE] || 'null')
  return { files, pane, rec }
}

test('bare /diagram hides the pane for the tab, and again shows it here', async ($, on) => {
  const w = world(on)
  w.files[FILE] = JSON.stringify({ owner: 'wK:p2' })
  await $.command.run({ command: 'diagram', args: '' } as never)
  expect(w.rec().hidden).toBe(true)
  expect(w.pane.up).toBe(false)
  await $.command.run({ command: 'diagram', args: '' } as never)
  expect(w.rec()).toMatchObject({ owner: 'wK:p2', hidden: false })
  expect(w.pane.up).toBe(true)
})

test('a chat whose tab another pane owns keeps the pane closed, until /diagram claims it', async ($, on) => {
  const w = world(on)
  w.files[FILE] = JSON.stringify({ owner: 'wK:p1' })
  await $.tool.call({ tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: 'flowchart TD\n  a[x.js]' } as never)
  expect(w.pane.up).toBe(false)
  await $.command.run({ command: 'diagram', args: 'diffs' } as never)
  expect(w.rec().owner).toBe('wK:p2')
  expect(w.pane.up).toBe(true)
})

test('/diagram hide, then a hidden tab stays hidden', async ($, on) => {
  const w = world(on)
  w.files[FILE] = JSON.stringify({ owner: 'wK:p2' })
  await $.command.run({ command: 'diagram', args: 'hide' } as never)
  expect(w.pane.up).toBe(false)
  await $.tool.call({ tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: 'flowchart TD\n  a[x.js]' } as never)
  expect(w.pane.up).toBe(false)
  await $.command.run({ command: 'diagram', args: 'show' } as never)
  expect(w.pane.up).toBe(true)
})

test('in a narrow chat, where the pane waits undrawn, bare /diagram shows it', async ($, on) => {
  const w = world(on)
  w.files[FILE] = JSON.stringify({ owner: 'wK:p2' })
  w.pane.placed = false
  await $.command.run({ command: 'diagram', args: '' } as never)
  expect(w.rec().hidden).toBe(false)
  expect(w.pane).toMatchObject({ up: true, placed: true })
})
