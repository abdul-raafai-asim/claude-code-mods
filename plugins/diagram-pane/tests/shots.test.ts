import { expect, mock, test } from 'claude-code/testing'
import { agentsIn, imagePathsIn, shotBox, shotsIn, toolCaption } from '../hooks/work.js'

// The shots tab: screenshots a chat's tools took or read, files and inline images

const JPEG = 'aGVsbG8tanBlZw=='
// A whole 1×1 PNG: the Image refuses bytes that are not one
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('image paths are found in text, but not inside a URL or without a folder', () => {
  expect(imagePathsIn('saved /tmp/shots/01-login.png and ~/s/y.JPG, see https://x.com/z.png or rel.png')).toEqual(['/tmp/shots/01-login.png', '~/s/y.JPG'])
  expect(imagePathsIn('"/Users/o/sc-1.jpeg"')).toEqual(['/Users/o/sc-1.jpeg'])
  expect(toolCaption('mcp__claude-in-chrome__computer')).toBe('claude-in-chrome computer')
})

test('a Read of a screenshot file is one file shot, a browser screenshot an inline one', () => {
  const rows = [
    { role: 'user', text: 'test the login page', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/tmp/shots/01-login.png' }, text: '' },
      { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npx playwright screenshot http://x shots/02.png' }, text: 'saved' },
      { tool_use_id: 'w1', tool: 'mcp__playwright__browser_take_screenshot', input: { filename: 'shots/03.png' }, text: '' },
      { tool_use_id: 'c1', tool: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' }, text: '' },
      { tool_use_id: 'a1', tool: 'Agent', input: { description: 'QA the form' }, agentId: 'ag1', text: 'done' },
    ] },
  ]
  const img = (data: string, media = 'image/jpeg') => ({ type: 'image', source: { type: 'base64', media_type: media, data } })
  const api = [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
      { type: 'tool_use', id: 'c1', name: 'mcp__claude-in-chrome__computer', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'r1', content: [img(PNG_B64, 'image/png')] },
      { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ok' }, img(JPEG)] },
    ] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, img(JPEG + 'x', 'image/png')] },
  ]
  const { files, inline } = shotsIn(rows, api, { cwd: '/repo', home: '/home' })
  expect(files.map((f: any) => f.path)).toEqual(['/tmp/shots/01-login.png', '/repo/shots/03.png'])
  expect(inline.map((s: any) => [s.tool, s.media])).toEqual([['mcp__claude-in-chrome__computer', 'image/jpeg'], ['pasted', 'image/png']])
  expect(agentsIn(rows)).toEqual([{ id: 'ag1', task: 'QA the form' }])
})

test('a picture keeps its shape in the pane, a tall one capped in rows', () => {
  expect(shotBox(1280, 800, 60)).toEqual({ columns: 60, rows: 19 })
  expect(shotBox(400, 2000, 60)).toEqual({ columns: 19, rows: 48 })
})

// ---------------------------------------------------------------------------
// The pane, with the transcript, the files and sips answered here
// ---------------------------------------------------------------------------

function world(on: any, withShots = true) {
  const files: Record<string, string> = {}
  const ran: string[] = []
  const opened: string[] = []
  mock.store(on)
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { HOME: '/home' })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }))
  on('ui.panes', () => ({ value: [{ id: 'diagrams', title: 'Diagrams', isPlaced: true }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const rows = !withShots ? [{ role: 'user', text: 'hi', toolUses: [] }] : [
    { role: 'user', text: 'test the login page', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/tmp/shots/01-login.png' }, text: '' },
      { tool_use_id: 'a1', tool: 'Agent', input: { description: 'QA the form' }, agentId: 'ag1', text: 'done' },
    ] },
  ]
  const agentApi = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'mcp__claude-in-chrome__computer', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } }] }] },
  ]
  on('session.messages', (_: any, e: any) => {
    if (e?.agentId === 'ag1') return { value: e.as === 'api' ? agentApi : [{ role: 'user', text: 'QA', toolUses: [] }] }
    if (e?.agentId) return { value: { deny: 'no such agent' } }
    return { value: e?.as === 'api' ? [] : rows }
  })
  on('fs.stat', (_: any, e: any) => (e.path === '/tmp/shots/01-login.png' ? { value: { kind: 'file', size: 10, mtimeMs: 1_799_999_000_000, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.write', (_: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('fs.read', (_: any, e: any) => (e.path in files ? { value: e.as === 'bytes' ? { base64: PNG_B64 } : files[e.path] } : { deny: 'ENOENT' }))
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    ran.push(argv.join(' '))
    if (argv[0] === 'sips' && argv[1] === '-g') return ok('  pixelWidth: 2560\n  pixelHeight: 1600\n')
    if (argv[0] === 'sips') return ((files[argv[argv.length - 1]] = 'png'), ok())
    if (argv[0] === 'base64') return ((files[argv[argv.length - 1]] = 'raw'), ok())
    if (argv[0] === 'open') return (opened.push(argv.slice(1).join(' ')), ok())
    if (argv[0] === 'mkdir' || argv[0] === 'rm') return ok()
    return { value: { exitCode: 1, stdout: '', stderr: 'not a repo', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { files, ran, opened }
}

const mount = ($: any) => $.ui.mount({
  plugin: 'diagram-pane', surface: 'terminal', component: 'Pane', requestId: 'diagrams',
  props: { title: 'Diagrams', isFocused: true, bodyColumns: 70, placement: 'dock' } as never,
})

const has = async (ui: any, text: RegExp) => expect(await ui.find({ type: 'Text', text } as never)).toBeDefined()

test('the shots tab draws the newest screenshot, a subagent\'s browser shot included', async ($, on) => {
  const { ran, opened } = world(on)
  await $.command.run({ command: 'diagram', args: 'shots' } as never)
  const ui = await mount($)
  await ui.press({ key: 'tab:shots' } as never)
  await has(ui, /SCREENSHOTS IN THIS CHAT/)
  await has(ui, /2 · newest first/)
  // The inline one was first seen now, after the file's mtime: it is newest
  await has(ui, /1\. claude-in-chrome computer screenshot/)
  await has(ui, /in subagent "QA the form"/)
  const image = await ui.find({ type: 'Image' } as never)
  expect(image).toBeDefined()
  // The inline JPEG was decoded into the shots folder, then made a PNG
  expect(ran.find(r => r.startsWith('base64'))).toMatch(/^base64 -D -i \/home\/\.claude\/diagram-pane\/shots\/i\w+\.b64 -o /)
  // 2560 wide is scaled to 1400 on the long side
  expect(ran.some(r => r.startsWith('sips -s format png -Z 1400'))).toBe(true)

  await ui.press({ key: 'older' } as never)
  await has(ui, /2\. 01-login\.png/)
  await has(ui, /\/tmp\/shots\/01-login\.png/)
  await ui.press({ key: 'finder' } as never)
  await ui.press({ key: 'preview' } as never)
  expect(opened).toEqual(['-R /tmp/shots/01-login.png', '/tmp/shots/01-login.png'])
})

test('with no screenshots the tab says what will show there', async ($, on) => {
  world(on, false)
  const ui = await mount($)
  await ui.press({ key: 'tab:shots' } as never)
  await has(ui, /Screenshots Claude takes or reads show here/)
})
