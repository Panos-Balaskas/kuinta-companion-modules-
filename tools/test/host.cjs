// Mock Companion host: runs the PACKAGED module (pkg/main.js) over the real nodejs-ipc protocol
// against mock-server.js, and checks definitions, variables, feedbacks and actions.
// Usage: WRITE_FORMAT=any|object|array node tools/test/host.cjs dist/pkg mock-server.js 19911
const { fork, spawn } = require('child_process')
const http = require('http')
const path = require('path')

const [pkgDir, mockJs, portArg] = process.argv.slice(2)
const PORT = Number(portArg)
let failures = 0
const ok = (cond, what) => {
	console.log((cond ? '  PASS ' : '  FAIL ') + what)
	if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- fake Event Master ----------
let mockOut = ''
const mock = spawn('node', [mockJs], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
mock.stdout.on('data', (d) => (mockOut += d))
mock.stderr.on('data', (d) => (mockOut += d))
function rpc(method, params) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: '1' })
		const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
			let b = ''
			res.on('data', (c) => (b += c))
			res.on('end', () => resolve(JSON.parse(b).result.response))
		})
		req.on('error', reject)
		req.end(body)
	})
}
const layerOf = async (dest, id) => (await rpc('listContent', { id: dest })).Layers.find((l) => l.id === id)
const win = (l) => l.Window[0] // preview entry

// ---------- module process ----------
const child = fork(path.join(pkgDir, 'main.js'), [], {
	env: { ...process.env, MODULE_MANIFEST: path.join(pkgDir, 'companion/manifest.json'), CONNECTION_ID: 'conn1', VERIFICATION_TOKEN: 'verify1' },
	stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
let stdout = ''
child.stdout.on('data', (d) => (stdout += d))
child.stderr.on('data', (d) => (stdout += d))

const got = { defs: {}, vars: {}, status: [], logs: [], fbValues: {}, saved: [] }
let nextId = 1
const pending = new Map()
function call(name, payload) {
	const id = nextId++
	child.send({ direction: 'call', name, payload: JSON.stringify(payload), callbackId: id })
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
child.on('message', (msg) => {
	if (msg.direction === 'response') {
		const p = pending.get(msg.callbackId)
		pending.delete(msg.callbackId)
		if (p) (msg.success ? p.resolve : p.reject)(msg.payload ? JSON.parse(msg.payload) : undefined)
		return
	}
	const data = msg.payload ? JSON.parse(msg.payload) : undefined
	const reply = (res) => msg.callbackId && child.send({ direction: 'response', callbackId: msg.callbackId, success: true, payload: JSON.stringify(res) })
	switch (msg.name) {
		case 'register':
			got.registered = data
			reply({})
			break
		case 'setActionDefinitions':
			got.defs.actions = data.actions
			break
		case 'setFeedbackDefinitions':
			got.defs.feedbacks = data.feedbacks
			break
		case 'setVariableDefinitions':
			got.defs.variables = data.variables
			break
		case 'setPresetDefinitions':
			got.defs.presets = data.presets
			break
		case 'setVariableValues':
			for (const v of data.newValues) got.vars[v.id] = v.value
			break
		case 'set-status':
			got.status.push(data)
			break
		case 'log-message':
			got.logs.push(data)
			break
		case 'saveConfig':
			got.saved.push(data)
			reply({})
			break
		case 'updateFeedbackValues':
			for (const v of data.values) got.fbValues[v.id] = v.value
			break
		case 'parseVariablesInString':
			reply({ text: data.text, variableIds: [] })
			break
		default:
			reply({})
	}
})
const lastStatus = () => got.status[got.status.length - 1] || {}

let fbInstances = {}
function presetFeedbacks() {
	fbInstances = {}
	let n = 0
	for (const p of got.defs.presets) {
		for (const f of p.feedbacks || []) {
			const id = `fb${n++}`
			fbInstances[id] = { id, controlId: `bank:${p.id}`, feedbackId: f.feedbackId, options: f.options, isInverted: false, disabled: false, upgradeIndex: null, preset: p.id }
		}
	}
	return fbInstances
}
const fbOf = (presetId, feedbackId) => {
	const e = Object.values(fbInstances).find((f) => f.preset === presetId && f.feedbackId === feedbackId)
	return e ? got.fbValues[e.id] : undefined
}
const preset = (id) => got.defs.presets.find((p) => p.id === id)
async function run(actionId, options, settle = 350) {
	await call('executeAction', { action: { id: 'a' + nextId, controlId: 'x', actionId, options, disabled: false, upgradeIndex: null }, surfaceId: undefined })
	await wait(settle)
}
const errorsLogged = () => got.logs.filter((l) => l.level === 'error')

;(async () => {
	await wait(900)
	console.log('1. Registration and init (WRITE_FORMAT=' + (process.env.WRITE_FORMAT || 'any') + ')')
	ok(got.registered && got.registered.connectionId === 'conn1', 'module registered over IPC (apiVersion ' + (got.registered && got.registered.apiVersion) + ')')
	const init = await call('init', {
		label: 'kteventmaster', isFirstInit: true, config: { host: '127.0.0.1', port: PORT, pollInterval: 2, guidesJson: '{}' }, lastUpgradeIndex: -1, feedbacks: {}, actions: {},
	})
	ok(init && init.hasHttpHandler === false, 'init answered')
	await wait(300)
	ok(lastStatus().status === 'bad_config', 'first start has no host yet → "' + lastStatus().message + '"')
	// the operator now enters the real address, as in Companion > Connections > Edit
	await call('updateConfigAndLabel', { label: 'kteventmaster', config: { host: '127.0.0.1', port: PORT, pollInterval: 2, guidesJson: '{}' } })
	await wait(1800)
	ok(lastStatus().status === 'ok', 'status OK (' + JSON.stringify(lastStatus()) + ')')
	const fields = await call('getConfigFields', {})
	ok(fields.fields.map((f) => f.id).join(',') === 'notice,host,port,pollInterval,authMode,authValue,guidesJson', 'config fields: ' + fields.fields.map((f) => f.id).join(','))

	console.log('2. Definitions')
	const ids = (l) => l.map((x) => x.id).sort().join(',')
	const want = ['adjust_param', 'arm_destination', 'assign_input', 'layer_align', 'layer_fill', 'mask_disable', 'mask_enable', 'multi_select', 'raw_call', 'refresh', 'save_preset', 'select_layer', 'select_logical_layer', 'select_param', 'set_guides', 'unarm_all']
	ok(ids(got.defs.actions) === want.join(','), 'actions: ' + ids(got.defs.actions))
	ok(['destination_armed', 'multi_select_on', 'layer_selected', 'param_active', 'rotary_active'].every((f) => got.defs.feedbacks.some((x) => x.id === f)), 'feedbacks: ' + ids(got.defs.feedbacks))
	const cats = {}
	for (const p of got.defs.presets) (cats[p.category] = cats[p.category] || []).push(p.name)
	for (const c in cats) console.log(`     ${c}: ${cats[c].length} presets`)
	ok(['Arm destination', 'Select layer', 'Assign input', 'Align / Fill', 'Align to guides', 'Shuttle', 'Shuttle rotary', 'Save'].every((c) => cats[c]), 'all preset categories present')
	ok(cats['Arm destination'].length === 6 && cats['Assign input'].length === 8, 'presets built from the device lists (4 arm + multi-select + unarm all, 8 inputs)')
	ok(cats['Select layer'].length === 10 && cats['Select layer (A/B direct)'].length === 16, 'before arming: 8 layer buttons (A/B auto) + Background PVW + PGM, and 16 direct A/B buttons')
	const aIds = new Set(got.defs.actions.map((a) => a.id))
	const fIds = new Set(got.defs.feedbacks.map((f) => f.id))
	const refsOk = got.defs.presets.every((p) => p.steps.every((s) => [...(s.down || []), ...(s.rotate_left || []), ...(s.rotate_right || [])].every((a) => aIds.has(a.actionId))) && (p.feedbacks || []).every((f) => fIds.has(f.feedbackId)))
	ok(refsOk, 'every preset refers to existing actions / feedbacks')
	for (const id of ['rot_jog', 'rot_ring_stop', 'rot_ring_freq']) {
		const p = preset(id)
		const s = p && p.steps[0]
		ok(p && p.options && p.options.rotaryActions === true && s.rotate_left && s.rotate_left.length === 1 && s.rotate_right && s.rotate_right.length === 1, `${id}: rotary preset has Rotate left / right actions`)
	}
	ok(preset('rot_jog').options && JSON.stringify(preset('rot_jog').steps[0].rotate_left[0].options.direction) === '"dec"', 'rotate LEFT = Decrease, rotate RIGHT = Increase')

	await call('updateFeedbacks', { feedbacks: presetFeedbacks() })

	console.log('3. Arm, layer, input')
	await run('arm_destination', { dest: 'screen:0', mode: 'toggle' })
	ok(got.vars.armed_destination === 'Main Wall' && got.vars.armed_type === 'Screen', 'armed: ' + got.vars.armed_destination)
	ok(got.defs.presets.filter((p) => p.category === 'Select layer (A/B direct)').length === 16, 'after arming: all layers incl. inactive ones are offered (16 direct buttons)')
	ok(got.vars.dest_w === 3840 && got.vars.dest_h === 2160, 'destination size ' + got.vars.dest_w + 'x' + got.vars.dest_h)
	await run('select_layer', { layer: 0 })
	ok(got.vars.selected_layer === 'Layer A' && got.vars.layer_w === 800, 'selected ' + got.vars.selected_layer + ', window ' + got.vars.layer_x + ',' + got.vars.layer_y + ' ' + got.vars.layer_w + 'x' + got.vars.layer_h)
	ok(fbOf('arm_screen:0', 'destination_armed') === true && fbOf('layer_0', 'layer_selected') === true && fbOf('arm_screen:1', 'destination_armed') === false, 'feedbacks: armed + layer lit')
	await run('assign_input', { source: 3, auxTarget: 'both' })
	ok((await layerOf(0, 0)).LastSrcIdx === 3 && got.vars.selected_layer_source === 'Input 4', 'assign input 3 → layer source "' + got.vars.selected_layer_source + '"')

	console.log('4. Align / fill / guides (user example: height 2160, guides 300 + 1500, window 500 high → VPos 650)')
	await run('set_guides', { axis: 'y', values: '300, 1500' })
	ok(got.vars.guides_y === '300, 1500' && got.saved.length > 0, 'guides stored (' + got.vars.guides_y + ') and saved in config')
	await run('layer_align', { mode: 'vcenter', reference: 'guides' })
	ok(win(await layerOf(0, 0)).VPos === 650, 'V Center between guides → VPos ' + win(await layerOf(0, 0)).VPos)
	await run('layer_align', { mode: 'center', reference: 'dest' })
	let w = win(await layerOf(0, 0))
	ok(w.HPos === 1520 && w.VPos === 830, `Absolute Center → ${w.HPos},${w.VPos}`)
	await run('layer_align', { mode: 'right', reference: 'dest' })
	ok(win(await layerOf(0, 0)).HPos === 3040, 'Absolute Right → HPos 3040')
	await run('layer_fill', { mode: 'fillHV', keepAspect: true })
	w = win(await layerOf(0, 0))
	ok(w.HPos === 0 && w.VPos === 0 && w.HSize === 3840 && w.VSize === 2160, `Fill H/V → ${w.HSize}x${w.VSize}`)

	console.log('5. Rotary editing on Layer B (jog / shuttle, batched writes)')
	await run('select_layer', { layer: 1 })
	await run('select_param', { param: 'size' })
	ok(got.vars.active_param === 'Size' && fbOf('param_size', 'param_active') === true, 'Size selected, button lit')
	for (let i = 0; i < 2; i++) await run('adjust_param', { direction: 'inc', step: '100', param: 'active', anchor: 'center' }, 150)
	await wait(400)
	w = win(await layerOf(0, 1))
	ok(w.HSize === 1000 && w.VSize === 625 && w.HPos === 0, `Size +100 twice (centre anchor) → ${w.HSize}x${w.VSize} at ${w.HPos},${w.VPos}`)
	ok(got.vars.layer_w === 1000, 'variable layer_w updated: ' + got.vars.layer_w)
	ok(fbOf('rot_jog', 'rotary_active') !== undefined, 'rotary flash feedback is evaluated (' + fbOf('rot_jog', 'rotary_active') + ')')
	await run('select_param', { param: 'hpos' })
	await run('adjust_param', { direction: 'inc', step: '10', param: 'active', anchor: 'center' }, 150)
	await run('adjust_param', { direction: 'dec', step: '1', param: 'vpos', anchor: 'center' }, 150)
	await wait(400)
	const before = { x: w.HPos, y: w.VPos }
	w = win(await layerOf(0, 1))
	ok(w.HPos === before.x + 10 && w.VPos === before.y - 1, `H +10 / V -1 → ${w.HPos},${w.VPos}`)
	// fast shuttle: 40 clicks in a burst must not become 40 writes
	const writesBefore = (mockOut.match(/changeContent/g) || []).length
	for (let i = 0; i < 40; i++) call('executeAction', { action: { id: 'b' + i, controlId: 'x', actionId: 'adjust_param', options: { direction: 'inc', step: '1', param: 'hpos', anchor: 'center' }, disabled: false, upgradeIndex: null }, surfaceId: undefined })
	await wait(700)
	const burst = (mockOut.match(/changeContent/g) || []).length - writesBefore
	const x2 = win(await layerOf(0, 1)).HPos
	ok(x2 === before.x + 10 + 40 && burst <= 6, `40 fast clicks → HPos +40 with only ${burst} write(s)`)
	await run('select_param', { param: 'mask_left' })
	await run('adjust_param', { direction: 'inc', step: '3', param: 'active', anchor: 'center' }, 150)
	await wait(400)
	ok((await layerOf(0, 1)).Mask[0].Left === 3, 'Mask Left +3 → ' + (await layerOf(0, 1)).Mask[0].Left)
	await run('mask_disable', {})
	ok((await layerOf(0, 1)).Mask[0].Left === 0, 'Mask Disable → 0')
	await run('mask_enable', {})
	ok((await layerOf(0, 1)).Mask[0].Left === 3, 'Mask Enable → restored to 3')

	console.log('6. Background, aux, user keys, save')
	await run('select_layer', { layer: -1 })
	ok(got.vars.selected_layer === 'Background PVW', 'background selected: ' + got.vars.selected_layer)
	await run('assign_input', { source: 4, auxTarget: 'both' })
	ok((await rpc('listContent', { id: 0 })).BGLyr[1].LastBGSourceIndex === 4, 'Background PVW ← input 4')
	await run('arm_destination', { dest: 'aux:0', mode: 'arm' })
	await run('assign_input', { source: 5, auxTarget: 'both' })
	ok((await rpc('listAuxContent', { id: 0 })).PgmLastSrcIndex === 5, 'Aux 1 ← input 5')
	await run('arm_destination', { dest: 'aux:0', mode: 'unarm' })
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	await run('select_layer', { layer: 0 })
	await run('save_preset', { name: 'Test', from: 'pgm' }, 800)
	ok((await rpc('listPresets', {})).some((x) => x.Name === 'Test'), 'Save preset created "Test" on the device (format found by trial)')
	await wait(200)
	ok(/savePreset/.test(mockOut), 'savePreset reached the device')
	await run('unarm_all', {})
	ok(got.vars.armed_destination === 'None', 'unarm → None')

	console.log('7. Multi-select: two screens armed, the same layer is used on both')
	await run('multi_select', { mode: 'on' })
	ok(got.vars.multi_select === 'On' && fbOf('multi_select', 'multi_select_on') === true, 'multi-select on, button lit')
	await run('arm_destination', { dest: 'screen:0', mode: 'toggle' })
	await run('arm_destination', { dest: 'screen:1', mode: 'toggle' })
	ok(got.vars.armed_destination === 'Main Wall, Stage Left' && got.vars.armed_count === 2, 'armed: ' + got.vars.armed_destination)
	ok(fbOf('arm_screen:0', 'destination_armed') === true && fbOf('arm_screen:1', 'destination_armed') === true, 'both destination buttons lit')
	await run('select_layer', { layer: 1 })
	await run('assign_input', { source: 6, auxTarget: 'both' })
	ok((await layerOf(0, 1)).LastSrcIdx === 6 && (await layerOf(1, 1)).LastSrcIdx === 6, 'input 6 → layer 1 on BOTH screens')
	await run('layer_fill', { mode: 'fillHV', keepAspect: true })
	const wa = win(await layerOf(0, 1)), wb = win(await layerOf(1, 1))
	ok(wa.HSize === 3840 && wa.VSize === 2160 && wb.HSize === 1920 && wb.VSize === 1080, `Fill H/V uses each screen's own size (${wa.HSize}x${wa.VSize} / ${wb.HSize}x${wb.VSize})`)
	await run('select_param', { param: 'hpos' })
	await run('adjust_param', { direction: 'dec', step: '10', param: 'active', anchor: 'center' }, 150)
	await wait(400)
	ok(win(await layerOf(0, 1)).HPos === -10 && win(await layerOf(1, 1)).HPos === -10, 'rotary moves the layer on both screens')
	await run('save_preset', { name: 'Multi', from: 'pvw' }, 800)
	ok((await rpc('listPresets', {})).some((x) => x.Name === 'Multi'), 'Save from PVW works with TWO destinations armed')
	await run('arm_destination', { dest: 'screen:1', mode: 'toggle' })
	ok(got.vars.armed_destination === 'Main Wall' && fbOf('arm_screen:1', 'destination_armed') === false, 'toggle removes one destination from the selection')
	await run('arm_destination', { dest: 'screen:1', mode: 'arm' })
	await run('multi_select', { mode: 'off' })
	ok(got.vars.armed_destination === 'Main Wall' && got.vars.multi_select === 'Off', 'multi-select off keeps only the first armed destination')
	await run('arm_destination', { dest: 'screen:1', mode: 'arm' })
	ok(got.vars.armed_destination === 'Stage Left', 'single mode again replaces the selection')
	await run('unarm_all', {})

	console.log('8. Layer outside preview/program, param switch keeps position, destinations stay lit')
	await run('multi_select', { mode: 'on' })
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	await run('arm_destination', { dest: 'screen:1', mode: 'arm' })
	ok(fbOf('arm_screen:0', 'destination_armed') === true && fbOf('arm_screen:1', 'destination_armed') === true, 'default: first destination keeps its colour when the second is armed')
	await run('arm_destination', { dest: 'screen:1', mode: 'unarm' })
	await run('select_layer', { layer: 9 })
	ok(fbOf('layer_9', 'layer_selected') === true, 'layer id 9 (not in preview) can be selected')
	await run('select_layer', { layer: 2 })
	await run('select_param', { param: 'vpos' })
	await run('adjust_param', { direction: 'inc', step: '50', param: 'active', anchor: 'center' }, 150)
	await wait(400)
	const p1 = win(await layerOf(0, 2))
	await wait(1700) // longer than the rotary session timeout
	await run('select_param', { param: 'hpos' })
	await run('adjust_param', { direction: 'inc', step: '20', param: 'active', anchor: 'center' }, 150)
	await wait(400)
	const p2 = win(await layerOf(0, 2))
	ok(p2.VPos === p1.VPos && p2.HPos === p1.HPos + 20 && p2.HSize === p1.HSize, `V then H keeps the current position (${p1.HPos},${p1.VPos} → ${p2.HPos},${p2.VPos})`)
	await run('unarm_all', {})

	console.log('9. Arm is sent to the Event Master and read back from it')
	await run('multi_select', { mode: 'off' })
	await run('unarm_all', {})
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	ok((await rpc('listContent', { id: 0 })).IsActive === 1, 'arming in Companion arms the screen on the Event Master (IsActive 1)')
	await run('arm_destination', { dest: 'screen:1', mode: 'arm' })
	ok((await rpc('listContent', { id: 0 })).IsActive === 0 && (await rpc('listContent', { id: 1 })).IsActive === 1, 'single mode: the previous screen is unarmed on the Event Master')
	await rpc('armUnarmDestination', { arm: 1, ScreenDestination: [{ id: 0 }], AuxDestination: [] }) // somebody arms on the console
	await wait(2600)
	ok(got.vars.armed_count === 2 && fbOf('arm_screen:0', 'destination_armed') === true, 'an arm done on the Event Master shows up in Companion: ' + got.vars.armed_destination)
	await rpc('armUnarmDestination', { arm: 0, ScreenDestination: [{ id: 0 }, { id: 1 }], AuxDestination: [] })
	await wait(2600)
	ok(got.vars.armed_destination === 'None', 'an unarm on the Event Master also clears Companion')
	await run('multi_select', { mode: 'on' })
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	await run('arm_destination', { dest: 'aux:0', mode: 'arm' })
	await run('save_preset', { name: 'WithAux', from: 'pgm' }, 800)
	const pl = await rpc('listPresets', {})
	ok(pl.some((x) => x.Name === 'WithAux' && x.from === 'pgm'), 'Save from PGM works with a screen and an aux armed (saveFromProgram)')
	await run('unarm_all', {})

	console.log('10. Layer button picks the free one of A / B on every armed screen')
	await run('multi_select', { mode: 'on' })
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	await run('arm_destination', { dest: 'screen:1', mode: 'arm' })
	await rpc('changeContent', { id: 0, Layers: [{ id: 0, PgmMode: 1 }] }) // Main Wall: 1A is on program
	await rpc('changeContent', { id: 1, Layers: [{ id: 1, PgmMode: 1 }] }) // Stage Left: 1B is on program
	await run('select_logical_layer', { n: 1 }, 600)
	ok(got.vars.selected_ab === 'Main Wall 1B | Stage Left 1A', 'free layers chosen per destination: ' + got.vars.selected_ab)
	await run('assign_input', { source: 5, auxTarget: 'both' })
	ok((await layerOf(0, 1)).LastSrcIdx === 5 && (await layerOf(1, 0)).LastSrcIdx === 5, 'input goes to 1B on Main Wall and to 1A on Stage Left')
	await rpc('changeContent', { id: 0, Layers: [{ id: 0, PgmMode: 0 }, { id: 1, PgmMode: 1 }] }) // after a transition
	await run('select_logical_layer', { n: 1 }, 600)
	ok(got.vars.selected_ab.startsWith('Main Wall 1A'), 'after the transition the other layer is chosen: ' + got.vars.selected_ab)
	ok(fbOf('llayer_1', 'logical_selected') === true, 'layer button lit')
	await run('unarm_all', {})

	console.log('11. Align keeps size and the other axis')
	await run('multi_select', { mode: 'off' })
	await run('arm_destination', { dest: 'screen:0', mode: 'arm' })
	await run('select_layer', { layer: 3 })
	await run('select_param', { param: 'size' })
	await run('adjust_param', { direction: 'inc', step: '100', param: 'active', anchor: 'topleft' }, 150)
	await run('layer_align', { mode: 'hcenter', reference: 'dest' }, 500)
	let a1 = win(await layerOf(0, 3))
	ok(a1.HSize === 900 && a1.VSize === 563 && a1.VPos === 800 && a1.HPos === 1470, `H Center keeps size and vertical → ${a1.HPos},${a1.VPos} ${a1.HSize}x${a1.VSize}`)
	await run('layer_align', { mode: 'top', reference: 'dest' }, 500)
	a1 = win(await layerOf(0, 3))
	ok(a1.VPos === 0 && a1.HPos === 1470 && a1.HSize === 900, `Top keeps horizontal and size → ${a1.HPos},${a1.VPos}`)
	await run('layer_align', { mode: 'right', reference: 'dest' }, 500)
	a1 = win(await layerOf(0, 3))
	ok(a1.VPos === 0 && a1.HPos === 2940 && a1.VSize === 563, `Right keeps vertical → ${a1.HPos},${a1.VPos}`)
	await run('unarm_all', {})

	const errs = errorsLogged()
	ok(errs.length === 0, 'no error logs from the module' + (errs.length ? ': ' + errs.map((e) => e.message).join(' | ') : ''))
	const confirmed = got.logs.filter((l) => /confirmed/.test(l.message)).map((l) => l.message)
	console.log('     module log: ' + (confirmed.join(' | ') || '(no write-format message)'))

	child.kill()
	mock.kill()
	console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
	if (failures) console.log(stdout, '\n--- mock:\n' + mockOut)
	process.exit(failures ? 1 : 0)
})().catch((e) => {
	console.error(e)
	console.log(stdout)
	child.kill()
	mock.kill()
	process.exit(1)
})
