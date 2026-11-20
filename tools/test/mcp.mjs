// Tests the MCP server (mcp/server.js) against mock-server.js over stdio, like Claude Desktop would run it.
// Usage: node tools/test/mcp.mjs [port]
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = process.argv[2] || '19950'
const mock = spawn('node', [path.join(root, 'mock-server.js')], { env: { ...process.env, PORT: port }, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 600))

const runServer = (env) => {
	const p = spawn('node', [path.join(root, 'mcp/server.js')], { env: { ...process.env, EM_HOST: '127.0.0.1', EM_PORT: port, ...env } })
	let buf = ''
	const waiting = new Map()
	p.stdout.on('data', (d) => {
		buf += d
		let i
		while ((i = buf.indexOf('\n')) >= 0) {
			const m = JSON.parse(buf.slice(0, i))
			buf = buf.slice(i + 1)
			waiting.get(m.id)?.(m)
		}
	})
	let n = 0
	const rpc = (method, params) =>
		new Promise((resolve) => {
			const id = ++n
			waiting.set(id, resolve)
			p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
		})
	const call = async (name, args = {}) => {
		const r = await rpc('tools/call', { name, arguments: args })
		return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), err: !!r.result?.isError || !!r.error }
	}
	return { p, rpc, call, close: () => p.kill() }
}

let failed = 0
const ok = (c, m) => {
	console.log(c ? '  PASS' : '  FAIL', m)
	if (!c) failed++
}

const s = runServer({})
const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
ok(init.result?.serverInfo?.name === 'kuinta-eventmaster', 'initialize')
const tools = (await s.rpc('tools/list', {})).result.tools.map((t) => t.name)
ok(['list_destinations', 'list_sources', 'list_presets', 'get_layers', 'save_preset', 'rename_preset', 'assign_input', 'set_window'].every((t) => tools.includes(t)), 'tools/list: ' + tools.join(','))

let r = await s.call('list_destinations')
ok(r.text.includes('Main Wall') && r.text.includes('3840x2160'), 'list_destinations')
r = await s.call('list_sources')
ok(r.text.includes('Input 3'), 'list_sources')

r = await s.call('assign_input', { destination: 'main wall', layer: '1', input: 'input3' })
ok(!r.err && r.text.includes('Input 3'), 'assign_input: ' + r.text)
r = await s.call('assign_input', { destination: 'nonexistent', layer: '1', input: 'input3' })
ok(r.err && r.text.includes('Available'), 'unknown destination lists the candidates')
r = await s.call('assign_input', { destination: 'main wall', layer: '1', input: 'input' })
ok(r.err && r.text.includes('ambiguous'), 'ambiguous input is reported, not guessed')

r = await s.call('set_window', { destination: 'main wall', layer: '1', size_percent: 50, position: 'center' })
ok(!r.err && r.text.includes('at'), 'set_window: ' + r.text)
r = await s.call('get_layers', { destination: 'main wall' })
// preview window 800x500 (aspect 1.6) -> 50% of 3840 = 1920 wide, 1200 high, centered at 960,480
ok(r.text.includes('1920x1200 at 960,480'), 'window is 50% and centered, aspect kept: ' + r.text.split('\n').slice(1).join(' | '))
r = await s.call('set_window', { destination: 'main wall', layer: '1', size_percent: 50, position: 'center', keep_aspect: false })
ok(!r.err, 'set_window keep_aspect=false')
r = await s.call('get_layers', { destination: 'main wall' })
ok(r.text.includes('1920x1080 at 960,540'), 'keep_aspect=false gives exactly 50% x 50%: ' + r.text.split('\n').slice(1).join(' | '))
r = await s.call('set_window', { destination: 'main wall', layer: '1', size_percent: 25, position: 'top_left', keep_aspect: false })
r = await s.call('get_layers', { destination: 'main wall' })
ok(r.text.includes('960x540 at 0,0'), 'top_left: ' + r.text.split('\n').slice(1).join(' | '))
r = await s.call('set_window', { destination: 'main wall', layer: '1', size_percent: 0 })
ok(r.err, 'size 0 rejected')

r = await s.call('save_preset', { name: 'Opening', destinations: ['main wall'] })
ok(!r.err && r.text.includes('Opening'), 'save_preset: ' + r.text)
r = await s.call('rename_preset', { preset: 'opening', new_name: 'Opening v2' })
ok(!r.err, 'rename_preset: ' + r.text)
r = await s.call('list_presets')
ok(r.text.includes('Opening v2') && !r.text.includes('- Opening ('), 'preset renamed in the list')
s.close()

const ro = runServer({ EM_READONLY: '1' })
await ro.rpc('initialize', { protocolVersion: '2025-06-18' })
const roTools = (await ro.rpc('tools/list', {})).result.tools.map((t) => t.name)
ok(!roTools.some((t) => ['save_preset', 'rename_preset', 'assign_input', 'set_window'].includes(t)) && roTools.includes('list_sources'), 'EM_READONLY hides the write tools')
ro.close()

mock.kill()
console.log(failed === 0 ? 'ALL PASSED' : `${failed} FAILED`)
process.exit(failed ? 1 : 0)
