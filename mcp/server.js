#!/usr/bin/env node
/**
 * Kuinta tools - MCP server for Barco Event Master / Encore 3 (programming aid).
 *
 * Speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC), with NO dependencies:
 * it reuses client.js / geometry.js / layerops.js of the Companion module.
 *
 * Configuration (environment variables):
 *   EM_HOST         IP / host name of the processor (required)
 *   EM_PORT         JSON-RPC port, default 9999
 *   EM_AUTH_MODE    none | operator | super_user   (default none)
 *   EM_AUTH_VALUE   operator index (0..2) or super operator password
 *   EM_READONLY     1 = only the list_* / get_* tools are offered
 *
 * Everything is written to PREVIEW only. There is deliberately no cut / take / activatePreset / delete tool.
 */
import { EventMasterClient } from '../client.js'
import { maskOf, rectOf } from '../geometry.js'
import { writeLayer } from '../layerops.js'

const HOST = process.env.EM_HOST
const READONLY = process.env.EM_READONLY === '1'
const client = new EventMasterClient(HOST || 'localhost', Number(process.env.EM_PORT) || 9999, 5000, process.env.EM_AUTH_MODE || 'none', process.env.EM_AUTH_VALUE ?? '')

// ---------- helpers ----------

const norm = (s) =>
	String(s ?? '')
		.toLowerCase()
		.replace(/destination/g, 'dest')
		.replace(/[\s_\-.:]+/g, '')

/** Picks ONE item of `list` ({ id, name }) for a spoken / typed `query`, or throws with the candidates. */
function resolve(list, query, what) {
	const q = norm(query)
	if (q === '') throw new Error(`${what}: empty name`)
	const names = list.map((i) => `"${i.name}" (id ${i.id})`).join(', ')
	let hits = list.filter((i) => norm(i.name) === q)
	if (hits.length === 0) {
		// "destination 1" / "dest 1" / "1" -> a name that ends with that number, or the id
		const m = q.match(/^(?:dest|input|source|src)?(\d+)$/)
		if (m) {
			const byNumber = list.filter((i) => new RegExp(`(^|\\D)${m[1]}$`).test(norm(i.name)))
			if (byNumber.length === 1) hits = byNumber
			else if (byNumber.length === 0) hits = list.filter((i) => String(i.id) === m[1])
		}
	}
	if (hits.length === 0) hits = list.filter((i) => norm(i.name).includes(q))
	if (hits.length === 1) return hits[0]
	if (hits.length === 0) throw new Error(`${what} "${query}" not found. Available: ${names}`)
	throw new Error(`${what} "${query}" is ambiguous: ${hits.map((i) => `"${i.name}" (id ${i.id})`).join(', ')}. Ask which one is meant.`)
}

async function screens() {
	const { screens: s } = await client.listDestinations()
	return s.map((d) => ({ id: d.id, name: d.Name ?? `Dest ${d.id}`, w: Number(d.HSize), h: Number(d.VSize) }))
}

async function auxes() {
	const { auxes: a } = await client.listDestinations()
	return a.map((d) => ({ id: d.id, name: d.Name ?? `Aux ${Number(d.id) + 1}` }))
}

async function sources() {
	const s = await client.listSources(0)
	return s.map((x) => ({ id: x.id, name: x.Name ?? `Source ${x.id}`, w: Number(x.HSize), h: Number(x.VSize) }))
}

async function readLayers(destId) {
	const content = await client.listContent(destId)
	return Array.isArray(content) ? content : (content?.Layers ?? [])
}

/** "1", "1A", "layer 2 b", 3 -> { n, side } */
function parseLayer(v) {
	const m = String(v).toLowerCase().replace(/layer/g, '').trim().match(/^(\d+)\s*([ab])?$/)
	if (!m) throw new Error(`Layer "${v}" not understood. Use a number (1, 2, ...) optionally followed by A or B.`)
	return { n: Number(m[1]), side: m[2] ? m[2].toUpperCase() : null }
}

/**
 * Layers come in A/B pairs: id 0 = 1A, id 1 = 1B, id 2 = 2A ...
 * Without an explicit A/B the one that is NOT on program is used (same rule as the Companion module).
 */
function pickLayer(layers, { n, side }) {
	if (n < 1) throw new Error('Layer numbers start at 1')
	const a = layers.find((l) => l.id === (n - 1) * 2)
	const b = layers.find((l) => l.id === (n - 1) * 2 + 1)
	if (!a && !b) throw new Error(`Layer ${n} does not exist on this destination`)
	if (side === 'A' && a) return { layer: a, label: `${n}A` }
	if (side === 'B' && b) return { layer: b, label: `${n}B` }
	if (side) throw new Error(`Layer ${n}${side} does not exist`)
	const onPgm = (l) => l && Number(l.PgmMode) > 0
	const onPvw = (l) => l && Number(l.PvwMode) > 0
	let pick = a ?? b
	let label = a ? `${n}A` : `${n}B`
	if (a && b) {
		if (onPgm(a) && !onPgm(b)) [pick, label] = [b, `${n}B`]
		else if (!onPgm(a) && !onPgm(b) && onPvw(b) && !onPvw(a)) [pick, label] = [b, `${n}B`]
	}
	return { layer: pick, label }
}

const round = (n) => Math.round(n)

/** Source / mode fields echoed with a window write (the Mask is NOT sent: the Barco document says it must be sent separately). */
function windowExtras(raw) {
	return () => {
		const out = { PvwMode: 1, PgmMode: Number(raw?.PgmMode) > 0 ? 1 : 0 }
		const s = Array.isArray(raw?.Source) ? (raw.Source[0] ?? raw.Source[1]) : raw?.Source
		if (s && [s.HPos, s.VPos, s.HSize, s.VSize].every((v) => Number.isFinite(Number(v)))) {
			out.Source = { HPos: Number(s.HPos), VPos: Number(s.VPos), HSize: Number(s.HSize), VSize: Number(s.VSize) }
		}
		return out
	}
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

// ---------- tools ----------

const POSITIONS = ['center', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right']

const TOOLS = [
	{
		name: 'list_destinations',
		write: false,
		description: 'List the screen destinations (name, id, size in pixels) and aux destinations of the processor.',
		schema: { type: 'object', properties: {} },
		async run() {
			const s = await screens()
			const a = await auxes()
			return text(
				[`Screen destinations:`, ...s.map((d) => `- ${d.name} (id ${d.id}) ${d.w}x${d.h}`), `Aux destinations:`, ...a.map((d) => `- ${d.name} (id ${d.id})`)].join('\n'),
			)
		},
	},
	{
		name: 'list_sources',
		write: false,
		description: 'List the input sources (name, id, size).',
		schema: { type: 'object', properties: {} },
		async run() {
			const s = await sources()
			return text(s.map((x) => `- ${x.name} (id ${x.id}) ${x.w}x${x.h}`).join('\n') || 'No sources')
		},
	},
	{
		name: 'list_presets',
		write: false,
		description: 'List the presets stored on the processor.',
		schema: { type: 'object', properties: {} },
		async run() {
			const p = await client.listPresets()
			return text(p.map((x) => `- ${x.Name ?? x.PresetName ?? x.presetName ?? '?'} (id ${x.id}${x.presetSno !== undefined ? `, sno ${x.presetSno}` : ''})`).join('\n') || 'No presets')
		},
	},
	{
		name: 'get_layers',
		write: false,
		description: 'Show the layers of a screen destination: which source, whether in preview / program, and the preview window.',
		schema: { type: 'object', properties: { destination: { type: 'string', description: 'Destination name, e.g. "tv" or "destination 1"' } }, required: ['destination'] },
		async run({ destination }) {
			const d = resolve(await screens(), destination, 'Destination')
			const srcs = await sources()
			const layers = (await readLayers(d.id)).filter((l) => Number(l.PvwMode) > 0 || Number(l.PgmMode) > 0)
			const lines = layers.map((l) => {
				const r = rectOf(l)
				const src = srcs.find((s) => s.id === l.LastSrcIdx)
				return `- Layer ${Math.floor(l.id / 2) + 1}${l.id % 2 === 0 ? 'A' : 'B'} (id ${l.id}): ${src ? src.name : `source ${l.LastSrcIdx}`}, preview=${Number(l.PvwMode) > 0}, program=${Number(l.PgmMode) > 0}${r ? `, window ${round(r.w)}x${round(r.h)} at ${round(r.x)},${round(r.y)}` : ''}`
			})
			return text(`${d.name} (${d.w}x${d.h})\n${lines.join('\n') || 'No active layers'}`)
		},
	},
	{
		name: 'save_preset',
		write: true,
		description: 'Save a preset from the current PREVIEW (or program) of the given screen destinations. Without destinations the destinations that are armed on the processor are used.',
		schema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Preset name' },
				destinations: { type: 'array', items: { type: 'string' }, description: 'Screen destination names (optional)' },
				from: { type: 'string', enum: ['preview', 'program'], description: 'Default preview' },
			},
			required: ['name'],
		},
		async run({ name, destinations = [], from = 'preview' }) {
			const all = await screens()
			const ids = destinations.map((q) => resolve(all, q, 'Destination').id)
			const candidates = client.presetCandidates(name, ids, [], from === 'program')
			let used = null
			for (const c of candidates) {
				await client.savePresetParams(c.params)
				const list = await client.listPresets()
				if (list.some((p) => (p.Name ?? p.PresetName ?? p.presetName) === name)) {
					used = c.key
					break
				}
			}
			if (!used) throw new Error(`The processor did not create a preset named "${name}" (checked by reading the preset list back).`)
			return text(`Preset "${name}" saved from ${from}${ids.length ? ` of ${destinations.join(', ')}` : ' (armed destinations)'}.`)
		},
	},
	{
		name: 'rename_preset',
		write: true,
		description: 'Rename an existing preset.',
		schema: { type: 'object', properties: { preset: { type: 'string', description: 'Current preset name' }, new_name: { type: 'string' } }, required: ['preset', 'new_name'] },
		async run({ preset, new_name }) {
			const list = await client.listPresets()
			const nameOf = (p) => p.Name ?? p.PresetName ?? p.presetName
			const items = list.map((p) => ({ id: p.id, name: nameOf(p) }))
			const p = resolve(items, preset, 'Preset')
			await client.call('renamePreset', { presetName: p.name, newPresetName: new_name })
			const after = await client.listPresets()
			if (!after.some((x) => nameOf(x) === new_name)) throw new Error(`Rename not confirmed: "${new_name}" is not in the preset list.`)
			return text(`Preset "${p.name}" renamed to "${new_name}".`)
		},
	},
	{
		name: 'assign_input',
		write: true,
		description: 'Put an input source on a layer of a screen destination (preview). Without A/B the one of the pair that is not on program is used.',
		schema: {
			type: 'object',
			properties: {
				destination: { type: 'string', description: 'Destination name, e.g. "tv"' },
				layer: { type: 'string', description: 'Layer number, optionally with A or B: "1", "2B"' },
				input: { type: 'string', description: 'Input / source name, e.g. "ppt1"' },
			},
			required: ['destination', 'layer', 'input'],
		},
		async run({ destination, layer, input }) {
			const d = resolve(await screens(), destination, 'Destination')
			const src = resolve(await sources(), input, 'Input')
			const { layer: l, label } = pickLayer(await readLayers(d.id), parseLayer(layer))
			await client.changeContent(d.id, l.id, src.id, !(Number(l.PvwMode) > 0))
			const now = (await readLayers(d.id)).find((x) => x.id === l.id)
			if (now?.LastSrcIdx !== src.id) throw new Error(`The processor did not apply it: layer ${label} on ${d.name} still has source ${now?.LastSrcIdx}.`)
			return text(`Layer ${label} on ${d.name} now shows ${src.name} (preview).`)
		},
	},
	{
		name: 'set_window',
		write: true,
		description:
			'Set the size and position of a layer window in PREVIEW. size_percent is the width of the window as a percent of the destination (the window keeps its aspect ratio unless keep_aspect is false, then size_percent applies to width AND height).',
		schema: {
			type: 'object',
			properties: {
				destination: { type: 'string' },
				layer: { type: 'string', description: '"1", "2B", ...' },
				size_percent: { type: 'number', description: '1..100' },
				position: { type: 'string', enum: POSITIONS, description: 'Default center' },
				keep_aspect: { type: 'boolean', description: 'Default true' },
			},
			required: ['destination', 'layer', 'size_percent'],
		},
		async run({ destination, layer, size_percent, position = 'center', keep_aspect = true }) {
			if (!(size_percent > 0 && size_percent <= 100)) throw new Error('size_percent must be between 1 and 100')
			if (!POSITIONS.includes(position)) throw new Error(`position must be one of ${POSITIONS.join(', ')}`)
			const d = resolve(await screens(), destination, 'Destination')
			if (!(d.w > 0 && d.h > 0)) throw new Error(`Size of ${d.name} unknown`)
			const { layer: l, label } = pickLayer(await readLayers(d.id), parseLayer(layer))
			const cur = rectOf(l)
			let w = (d.w * size_percent) / 100
			let h = (d.h * size_percent) / 100
			if (keep_aspect && cur && cur.w > 0 && cur.h > 0) {
				const aspect = cur.w / cur.h
				h = w / aspect
				if (h > d.h) {
					h = d.h
					w = h * aspect
				}
			}
			w = round(w)
			h = round(h)
			const x = position.includes('left') ? 0 : position.includes('right') ? d.w - w : round((d.w - w) / 2)
			const y = position.includes('top') ? 0 : position.includes('bottom') ? d.h - h : round((d.h - h) / 2)
			const target = { x, y, w, h }
			const pgm = Array.isArray(l.Window) ? l.Window[1] : undefined
			const res = await writeLayer({ client, destId: d.id, layerId: l.id, kind: 'window', target, pgm, extras: windowExtras(l), startFormat: 'object', verify: true })
			if (!res.ok) throw new Error(`The processor did not apply the window ${JSON.stringify(target)} (last request: ${JSON.stringify(client.lastRequest?.params)}).`)
			const m = maskOf((await readLayers(d.id)).find((z) => z.id === l.id))
			return text(`Layer ${label} on ${d.name}: window ${w}x${h} at ${x},${y} (${position}, ${size_percent}%)${m && (m.left || m.right || m.top || m.bottom) ? ' - note: the layer has a crop (mask)' : ''}.`)
		},
	},
]

// ---------- MCP over stdio ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const visible = () => TOOLS.filter((t) => !(READONLY && t.write))

async function handle(msg) {
	const { id, method, params } = msg
	if (id === undefined) return // notification (e.g. notifications/initialized)
	try {
		if (method === 'initialize') {
			return send({
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'kuinta-eventmaster', version: '0.1.0' },
					instructions:
						'Programming aid for a Barco Event Master / Encore 3. Everything is written to PREVIEW only. If a name is ambiguous, ask the user instead of guessing. Report back what the tool answered.',
				},
			})
		}
		if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
		if (method === 'tools/list') {
			return send({ jsonrpc: '2.0', id, result: { tools: visible().map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) } })
		}
		if (method === 'tools/call') {
			const tool = visible().find((t) => t.name === params?.name)
			if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } })
			if (!HOST) return send({ jsonrpc: '2.0', id, result: { ...text('EM_HOST is not set: configure the IP of the Event Master.'), isError: true } })
			try {
				return send({ jsonrpc: '2.0', id, result: await tool.run(params.arguments ?? {}) })
			} catch (e) {
				return send({ jsonrpc: '2.0', id, result: { ...text(`Error: ${e.message}`), isError: true } })
			}
		}
		return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
	} catch (e) {
		send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } })
	}
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let i
	while ((i = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, i).trim()
		buffer = buffer.slice(i + 1)
		if (!line) continue
		try {
			handle(JSON.parse(line))
		} catch (e) {
			send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
		}
	}
})
process.stdin.on('end', () => process.exit(0))
