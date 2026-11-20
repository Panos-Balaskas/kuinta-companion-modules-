// Fake Barco Event Master for testing the Companion module without hardware.
// Run:  node mock-server.js        (listens on port 9999; set PORT=xxxx to change)
// In Companion use host 127.0.0.1, port 9999.
//
// NOTE: this mimics the API shapes the module assumes. It proves the module's logic works,
// but it cannot prove that a real E2/S3-4K/EX answers in exactly the same format.
import http from 'node:http'

const PORT = Number(process.env.PORT) || 9999

const sources = Array.from({ length: 8 }, (_, i) => ({ id: i, Name: `Input ${i + 1}` }))

// Layers use the NEWER reply format: Window is an array [preview, program] (observed on a real unit)
const mkWindow = () => [
	{ HPos: 100, VPos: 800, HSize: 800, VSize: 500 }, // preview (index 0, as seen on a real unit)
	{ HPos: 0, VPos: 0, HSize: 1920, VSize: 1080 }, // program (index 1)
]
const screens = [
	{ id: 0, Name: 'Main Wall', layers: 4, HSize: 3840, VSize: 2160 },
	{ id: 1, Name: 'Stage Left', layers: 2, HSize: 1920, VSize: 1080 },
].map((d) => ({
	...d,
	bg: [
		{ id: 0, LastBGSourceIndex: -1 },
		{ id: 1, LastBGSourceIndex: -1 },
	],
	content: Array.from({ length: d.layers }, (_, i) => ({
		id: i,
		Name: `Layer ${String.fromCharCode(65 + i)}`,
		LastSrcIdx: 0,
		PvwMode: 0,
		PgmMode: 0,
		Window: mkWindow(),
		Source: [
			{ HPos: 0, VPos: 0, HSize: 3840, VSize: 2160 },
			{ HPos: 0, VPos: 0, HSize: 3840, VSize: 2160 },
		],
		Mask: [
			{ id: 0, Top: 0, Left: 0, Right: 0, Bottom: 0 },
			{ id: 0, Top: 0, Left: 0, Right: 0, Bottom: 0 },
		],
	})),
}))

const presets = []
const userKeys = [
	{ id: 0, Name: 'Lower third' },
	{ id: 1, Name: 'Logo bug' },
	{ id: 2, Name: 'Sponsor strip' },
]

const auxes = [
	{ id: 0, Name: 'Aux 1', PvwLastSrcIndex: 0, PgmLastSrcIndex: 0 },
	{ id: 1, Name: 'Confidence', PvwLastSrcIndex: 1, PgmLastSrcIndex: 1 },
]

const ok = (response) => ({ success: 0, response })

const methods = {
	listDestinations: () =>
		ok({
			ScreenDestination: screens.map(({ id, Name, HSize, VSize, layers }) => ({ id, Name, HSize, VSize, Layers: layers })),
			AuxDestination: auxes.map(({ id, Name }) => ({ id, Name })),
		}),
	listSources: () => ok(sources),
	listContent: ({ id }) => {
		const s = screens.find((d) => d.id === id)
		return s ? ok({ id: s.id, Name: s.Name, IsActive: s.armed ? 1 : 0, BGLyr: s.bg, Layers: s.content }) : { success: 1 }
	},
	// CLEAR=fallback: the unit has no clearLayers (the module then uses changeContent PvwMode 0)
	clearLayers: ({ screenId, Layers = [] }) => {
		if (process.env.CLEAR === 'fallback') return { success: 1 }
		const s = screens.find((d) => d.id === screenId) // documented parameter name: screenId
		for (const l of Layers) {
			const t = s?.content.find((c) => c.id === l.id)
			if (t) t.PvwMode = 0
		}
		return { success: 0 }
	},
	changeContent: ({ id, Layers = [], BGLyr = [] }) => {
		const s = screens.find((d) => d.id === id)
		if (!s) return { success: 1 }
		// WRITE_FORMAT=object|array|flat makes the mock silently ignore the other forms (like a strict firmware might)
		const fmt = process.env.WRITE_FORMAT || 'any'
		const allow = (f) => fmt === 'any' || fmt === f
		for (const l of Layers) {
			const target = s.content.find((c) => c.id === l.id)
			if (!target) continue
			const ix = 0 // preview entry
			// PARTIAL=ignore: a strict unit that ignores windows that do not carry all four values
			if (process.env.PARTIAL === 'ignore') {
				const w = Array.isArray(l.Window) ? l.Window[0] : l.Window
				if (w && Object.keys(w).filter((k) => k.endsWith('Pos') || k.endsWith('Size')).length < 4) continue
			}
			// SPEC=1: the Barco document says Mask must be sent separately from Window, so a layer carrying both is ignored
			if (process.env.SPEC === '1' && l.Window !== undefined && l.Mask !== undefined) continue
			// STRICT_SHAPES=1: Window, Source and Mask must all use the same shape (array vs object), else the layer write is ignored
			if (process.env.STRICT_SHAPES === '1') {
				const shapes = [l.Window, l.Source, l.Mask].filter((x) => x !== undefined && typeof x === 'object').map((x) => Array.isArray(x))
				if (new Set(shapes).size > 1) continue
			}
			if (l.LastSrcIdx !== undefined) target.LastSrcIdx = l.LastSrcIdx
			if (l.PgmMode !== undefined) target.PgmMode = l.PgmMode
			if (l.PvwMode !== undefined) target.PvwMode = l.PvwMode
			if (l.Window) {
				if (Array.isArray(l.Window)) {
					if (allow('array')) target.Window[ix] = { ...target.Window[ix], ...l.Window[0] }
				} else if (allow('object')) target.Window[ix] = { ...target.Window[ix], ...l.Window }
			}
			if (l.HPos !== undefined && allow('flat')) {
				target.Window[ix] = { HPos: l.HPos, VPos: l.VPos, HSize: l.HSize, VSize: l.VSize }
			}
			if (l.Mask) {
				if (Array.isArray(l.Mask)) {
					if (allow('array')) target.Mask[ix] = { ...target.Mask[ix], ...l.Mask[0] }
				} else if (allow('object')) target.Mask[ix] = { ...target.Mask[ix], ...l.Mask }
			}
		}
		for (const b of BGLyr) {
			const target = s.bg.find((x) => x.id === b.id)
			if (target && b.LastBGSourceIndex !== undefined) target.LastBGSourceIndex = b.LastBGSourceIndex
		}
		return { success: 0, response: null }
	},
	listUserKeys: () => ok(userKeys),
	recallUserKey: ({ id }) => (userKeys.some((k) => k.id === id) ? { success: 0, response: null } : { success: 1 }),
	storeUserKey: ({ userkeyName }) => {
		userKeys.push({ id: userKeys.length, Name: userkeyName })
		return { success: 0, response: null }
	},
	// strict like a picky firmware: only a plain array of ids creates a preset; other shapes are "accepted" but ignored
	// documented: ScreenDestination / AuxDestination arrays of {id}; omitted = the armed destinations; saveFromProgram: 1 = from program
	armUnarmDestination: ({ arm, ScreenDestination = [], AuxDestination = [] }) => {
		for (const d of ScreenDestination) {
			const s = screens.find((x) => x.id === d.id)
			if (s) s.armed = arm === 1
		}
		for (const d of AuxDestination) {
			const a = auxes.find((x) => x.id === d.id)
			if (a) a.armed = arm === 1
		}
		return { success: 0, response: null }
	},
	savePreset: (p) => {
		const { presetName, ScreenDestination, AuxDestination } = p
		const explicit = Array.isArray(ScreenDestination) ? ScreenDestination.length : 0
		const armed = screens.filter((s) => s.armed).length
		if (typeof presetName === 'string' && (explicit > 0 || armed > 0 || (AuxDestination || []).length > 0)) presets.push({ id: presets.length, Name: presetName, from: p.saveFromProgram === 1 ? 'pgm' : 'pvw', screens: explicit || armed })
		return { success: 0, response: null }
	},
	renamePreset: ({ presetName, newPresetName, id }) => {
		const p = presets.find((x) => x.Name === presetName || x.id === id)
		if (!p) return { success: 1, response: null }
		p.Name = newPresetName
		return { success: 0, response: null }
	},
	listPresets: () => ok(presets),
	listAuxContent: ({ id }) => {
		const a = auxes.find((d) => d.id === id)
		return a ? ok(a) : { success: 1 }
	},
	changeAuxContent: ({ id, PvwLastSrcIndex, PgmLastSrcIndex }) => {
		const a = auxes.find((d) => d.id === id)
		if (!a) return { success: 1 }
		if (PvwLastSrcIndex !== undefined) a.PvwLastSrcIndex = PvwLastSrcIndex
		if (PgmLastSrcIndex !== undefined) a.PgmLastSrcIndex = PgmLastSrcIndex
		return { success: 0, response: null }
	},
}

const time = () => new Date().toLocaleTimeString()

http
	.createServer((req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			let msg
			try {
				msg = JSON.parse(body)
			} catch {
				res.writeHead(400).end()
				return
			}
			const handler = methods[msg.method]
			const result = handler ? handler(msg.params ?? {}) : { success: 1 }
			if (/^(change|recall|save)/.test(msg.method)) {
				console.log(`${time()}  ${msg.method}  ${JSON.stringify(msg.params)}`)
			}
			res.setHeader('Content-Type', 'application/json')
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
		})
	})
	.listen(PORT, () => {
		console.log(`Mock Event Master listening on port ${PORT}`)
		console.log(`Screens: ${screens.map((s) => s.Name).join(', ')} | Aux: ${auxes.map((a) => a.Name).join(', ')} | ${sources.length} sources`)
		console.log('Every change command is printed below:')
	})
