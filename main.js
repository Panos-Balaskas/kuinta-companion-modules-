import { InstanceBase, InstanceStatus, combineRgb, runEntrypoint } from '@companion-module/base'
import { EventMasterClient } from './client.js'
import { alignRect, applyDelta, fillRect, maskOf, parseGuideList, rectOf } from './geometry.js'
import { writeLayer } from './layerops.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const ORANGE = combineRgb(230, 120, 0)
const GREEN = combineRgb(0, 150, 0)
const BLUE = combineRgb(0, 40, 100)
const PURPLE = combineRgb(80, 0, 110)
const RED = combineRgb(120, 0, 0)
const YELLOW = combineRgb(255, 200, 0)
const FLASH_MS = 250 // how long the rotary indicator stays lit

const MAX_LAYER_FALLBACK = 16 // layer choices shown while nothing is armed
const BG_PVW = -1 // pseudo layer ids for the background
const BG_PGM = -2

const PARAM_LABELS = {
	size: 'Size',
	hpos: 'H Position',
	vpos: 'V Position',
	mask_left: 'Mask Left',
	mask_right: 'Mask Right',
	mask_top: 'Mask Top',
	mask_bottom: 'Mask Bottom',
}
const PARAM_CHOICES = Object.entries(PARAM_LABELS).map(([id, label]) => ({ id, label }))
const LIVE_TTL_MS = 30000 // the working copy of the layer is kept (so switching Size / V / H keeps the values) for this long when idle
const LAST_WRITTEN_MS = 60000 // a value the module wrote itself is trusted over a device read for this long
const FLUSH_MS = 60 // rotary steps are batched: at most one write per layer part every FLUSH_MS

const destKey = (type, id) => `${type}:${id}`
const parseKey = (key) => {
	const [type, id] = String(key).split(':')
	return { type, id: Number(id) }
}

class BarcoEventMasterInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.client = null
		this.pollTimer = null
		this.busy = false
		this.lastError = null
		this.lastCounts = null
		this.signature = ''

		this.screens = [] // Screen Destinations from the processor
		this.auxes = [] // Aux Destinations
		this.sources = [] // Input sources

		this.armedList = [] // armed destinations / auxes in the order they were armed: [{ type: 'screen' | 'aux', id, name }]
		this.screenActive = new Map() // screen id -> armed on the processor (listContent IsActive)
		this.armGraceUntil = 0
		this.multi = true // multi-select mode (default on, so every armed destination keeps its colour): arming ADDS to the selection instead of replacing it
		this.armedContent = new Map() // "type:id" -> { layers, bg, auxSrc } of every armed destination
		this.selectedLogical = null // logical layer number (1 = layers 1A/1B ...) when the A/B auto-select button was used
		this.selectedByDest = new Map() // screen id -> the layer id chosen for it (A or B)
		this.selectedLayer = null // layer id (the SAME id on every armed screen), or BG_PVW / BG_PGM

		this.guides = {} // { [screenId]: { x: [...], y: [...] } } entered by the user

		// --- rotary (ShuttlePRO) editing
		this.activeParam = null // which value the jog / shuttle currently changes
		this.lastWritten = new Map() // "dest:layer" -> { rect, mask, t } what the module last wrote (and the device confirmed)
		this.live = null // working copy of the selected layer during a rotary session
		this.opChain = Promise.resolve() // serialises rotary operations
		this.flushTimer = null
		this.maskStash = {} // masks removed by "Mask Disable", restored by "Mask Enable"
		this.writeFormats = { window: null, mask: null } // confirmed write formats (see layerops.js)
		this.lastWarn = 0
		this.flashUntil = 0 // rotary indicator
		this.flashTimer = null
	}

	/* ------------------------------------------------------------------ lifecycle */

	async init(config) {
		this.config = config
		this.loadGuides()
		this.setVariableDefinitions([
			{ variableId: 'armed_destination', name: 'Armed destination(s) / aux (comma separated)' },
			{ variableId: 'armed_type', name: 'Armed type (Screen / Aux / Mixed)' },
			{ variableId: 'armed_count', name: 'Number of armed destinations' },
			{ variableId: 'multi_select', name: 'Multi-select mode (On / Off)' },
			{ variableId: 'selected_ab', name: 'Selected layer per destination (e.g. tv 1B, led 1A)' },
			{ variableId: 'selected_layer', name: 'Selected layer name' },
			{ variableId: 'selected_layer_source', name: 'Source currently on the selected layer (or armed aux)' },
			{ variableId: 'layer_list', name: 'Layers of the armed destination (id: name)' },
			{ variableId: 'layer_x', name: 'Selected layer HPos' },
			{ variableId: 'layer_y', name: 'Selected layer VPos' },
			{ variableId: 'layer_w', name: 'Selected layer HSize' },
			{ variableId: 'layer_h', name: 'Selected layer VSize' },
			{ variableId: 'dest_w', name: 'Armed destination width' },
			{ variableId: 'dest_h', name: 'Armed destination height' },
			{ variableId: 'guides_x', name: 'H guides (used for horizontal alignment) of armed destination' },
			{ variableId: 'guides_y', name: 'V guides (used for vertical alignment) of armed destination' },
			{ variableId: 'active_param', name: 'Value the jog / shuttle currently changes' },
		])
		this.updateDefinitions()
		this.updateVariables()
		await this.connect()
	}

	async destroy() {
		this.stopPolling()
		if (this.flushTimer) clearTimeout(this.flushTimer)
		if (this.flashTimer) clearTimeout(this.flashTimer)
	}

	async configUpdated(config) {
		const old = this.config ?? {}
		this.config = config
		this.loadGuides()
		if (old.host !== config.host || old.port !== config.port || old.pollInterval !== config.pollInterval || old.authMode !== config.authMode || old.authValue !== config.authValue) {
			await this.connect()
		} else {
			this.updateVariables()
		}
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'notice',
				width: 12,
				label: 'Important',
				value: 'This module is a programming aid for Event Master / Encore 3. Test every function thoroughly before using it in a show.',
			},
			{ type: 'textinput', id: 'host', label: 'Event Master IP / hostname (host unit)', width: 8, required: true },
			{ type: 'number', id: 'port', label: 'Port', width: 4, min: 1, max: 65535, default: 9999 },
			{
				type: 'number',
				id: 'pollInterval',
				label: 'Refresh interval (seconds)',
				width: 4,
				min: 2,
				max: 300,
				default: 10,
			},
			{
				type: 'dropdown',
				id: 'authMode',
				label: 'Authentication (only when the unit is in multi-operator mode)',
				width: 6,
				default: 'none',
				choices: [
					{ id: 'none', label: 'None' },
					{ id: 'operator', label: 'Operator ID (0, 1 or 2)' },
					{ id: 'super_user', label: 'Super user password' },
				],
			},
			{ type: 'textinput', id: 'authValue', label: 'Operator ID / password', width: 6, default: '' },
			{
				type: 'textinput',
				id: 'guidesJson',
				label: 'Guides storage (managed by the "Set guides" action, advanced)',
				width: 12,
				default: '{}',
			},
		]
	}

	/* ------------------------------------------------------------------ guides (entered by the user) */

	loadGuides() {
		try {
			const g = JSON.parse(this.config?.guidesJson || '{}')
			this.guides = g && typeof g === 'object' ? g : {}
		} catch {
			this.guides = {}
		}
	}

	saveGuides() {
		this.config = { ...this.config, guidesJson: JSON.stringify(this.guides) }
		this.saveConfig(this.config)
	}

	/* ------------------------------------------------------------------ connection */

	stopPolling() {
		if (this.pollTimer) clearInterval(this.pollTimer)
		this.pollTimer = null
	}

	async connect() {
		this.stopPolling()
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			return
		}
		this.client = new EventMasterClient(this.config.host, this.config.port || 9999, 3000, this.config.authMode, this.config.authValue)
		this.updateStatus(InstanceStatus.Connecting)
		await this.refreshAll()
		const every = Math.max(2, Number(this.config.pollInterval) || 10) * 1000
		this.pollTimer = setInterval(() => this.refreshAll(), every)
	}

	/** Reloads destinations, sources, user keys and the content of the armed destination. */
	async refreshAll() {
		if (this.busy || !this.client) return
		this.busy = true
		try {
			const dests = await this.client.listDestinations()
			this.screens = dests.screens
			this.auxes = dests.auxes
			this.sources = await this.client.listSources(0)
			this.logCounts()

			// armed destinations that were deleted on the processor?
			for (const a of [...this.armedList]) if (!this.findDest(a.type, a.id)) this.removeArmed(a.type, a.id)

			await this.syncArmState()
			this.updateStatus(InstanceStatus.Ok)
			this.lastError = null
		} catch (e) {
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			if (this.lastError !== e.message) this.log('error', `Event Master: ${e.message}`)
			this.lastError = e.message
		} finally {
			this.busy = false
			this.refreshDefinitionsIfChanged()
			this.updateVariables()
			this.checkFeedbacks()
		}
	}

	logCounts() {
		const msg = `Loaded ${this.screens.length} screen destination(s), ${this.auxes.length} aux, ${this.sources.length} source(s)`
		if (msg === this.lastCounts) return
		this.lastCounts = msg
		this.log('info', msg)
		if (this.screens.length + this.auxes.length === 0) {
			this.log('warn', `No destinations found. Raw reply: ${JSON.stringify(this.client.lastRawDestinations)?.slice(0, 600)}`)
		}
		if (this.sources.length === 0) {
			this.log('warn', `No sources found. Raw reply: ${JSON.stringify(this.client.lastRawSources)?.slice(0, 600)}`)
		}
	}

	/** Reloads the content of EVERY armed destination. */
	async refreshArmedContent() {
		await Promise.all(this.armedList.map((entry) => this.refreshContentOf(entry)))
		const ids = new Set(this.allLayers().map((l) => l.id))
		if (this.selectedLogical === null && this.selectedLayer !== null && this.selectedLayer >= 0 && !ids.has(this.selectedLayer)) this.selectedLayer = null
	}

	/** Reads a screen destination: layers, background and the arm flag (listContent IsActive; undefined if not reported). */
	async readScreen(id) {
		const content = await this.client.listContent(id)
		const raw = Array.isArray(content) ? content : (content?.Layers ?? [])
		const byId = new Map()
		for (const l of raw) {
			if (l && l.id !== undefined && !byId.has(l.id)) {
				byId.set(l.id, {
					id: l.id,
					name: l.Name ?? `Layer ${l.id}`,
					src: l.LastSrcIdx,
					rect: rectOf(l),
					mask: maskOf(l),
					pvwMode: l.PvwMode,
					pgmMode: l.PgmMode,
					raw: l,
					rawWindow: l.Window,
					rawMask: l.Mask,
				})
			}
		}
		const bgl = Array.isArray(content?.BGLyr) ? content.BGLyr : []
		const bg = {
			pgm: bgl.find((b) => b.id === 0)?.LastBGSourceIndex ?? null,
			pvw: bgl.find((b) => b.id === 1)?.LastBGSourceIndex ?? null,
		}
		const flag = content?.IsActive
		return {
			active: flag === undefined || flag === null ? undefined : Number(flag) === 1,
			layers: [...byId.values()].sort((a, b) => a.id - b.id),
			bg,
		}
	}

	async refreshContentOf(entry) {
		const key = destKey(entry.type, entry.id)
		if (entry.type === 'screen') {
			const r = await this.readScreen(entry.id)
			if (r.active !== undefined) this.screenActive.set(entry.id, r.active)
			// it may have been unarmed while the request was running
			if (this.isArmed(entry.type, entry.id)) this.armedContent.set(key, { layers: r.layers, bg: r.bg, auxSrc: null })
		} else {
			const content = await this.client.listAuxContent(entry.id)
			if (this.isArmed(entry.type, entry.id)) {
				this.armedContent.set(key, {
					layers: [],
					bg: { pvw: null, pgm: null },
					auxSrc: content?.PgmLastSrcIndex ?? content?.PgmLastSrcIdx ?? null,
				})
			}
		}
	}

	/**
	 * The processor is the source of truth for the arm state of SCREENS (listContent IsActive), so an arm done
	 * on the console / web UI shows up here too. The arm state of AUX destinations cannot be read: it is kept locally.
	 */
	async syncArmState() {
		const results = await Promise.all(
			this.screens.map(async (s) => {
				try {
					return [s, await this.readScreen(s.id)]
				} catch {
					return [s, null]
				}
			}),
		)
		const trust = Date.now() > this.armGraceUntil // right after our own arm command the device may still report the old state
		for (const [s, r] of results) {
			if (!r) continue
			if (r.active !== undefined) {
				this.screenActive.set(s.id, r.active)
				if (trust) {
					if (r.active && !this.isArmed('screen', s.id)) this.log('info', `Arm state: ${s.Name ?? s.id} is armed on the unit`)
					if (!r.active && this.isArmed('screen', s.id)) this.log('info', `Arm state: ${s.Name ?? s.id} is NOT armed on the unit, un-arming it here`)
					if (r.active && !this.isArmed('screen', s.id)) this.armedList = [...this.armedList, { type: 'screen', id: s.id, name: s.Name ?? `screen ${s.id}` }]
					if (!r.active && this.isArmed('screen', s.id)) this.removeArmed('screen', s.id)
				}
			}
			if (this.isArmed('screen', s.id)) this.armedContent.set(destKey('screen', s.id), { layers: r.layers, bg: r.bg, auxSrc: null })
		}
		for (const a of this.armedAuxes) await this.refreshContentOf(a)
		const ids = new Set(this.allLayers().map((l) => l.id))
		if (this.selectedLayer !== null && this.selectedLayer >= 0 && !ids.has(this.selectedLayer) && this.armedScreens.length === 0) this.selectedLayer = null
	}

	/* ------------------------------------------------------------------ state helpers */

	findDest(type, id) {
		return (type === 'screen' ? this.screens : this.auxes).find((d) => d.id === id)
	}

	/** The first armed destination (its values feed the single-value variables). */
	get armed() {
		return this.armedList[0] ?? null
	}

	get armedScreens() {
		return this.armedList.filter((a) => a.type === 'screen')
	}

	get armedAuxes() {
		return this.armedList.filter((a) => a.type === 'aux')
	}

	isArmed(type, id) {
		return this.armedList.some((a) => a.type === type && a.id === id)
	}

	contentOf(entry) {
		return this.armedContent.get(destKey(entry.type, entry.id))
	}

	/** Layers of the first armed screen (feeds the layer variables). */
	get layers() {
		const s = this.armedScreens[0]
		return (s && this.contentOf(s)?.layers) || []
	}

	get bg() {
		const s = this.armedScreens[0]
		return (s && this.contentOf(s)?.bg) || { pvw: null, pgm: null }
	}

	get auxSrc() {
		const a = this.armedAuxes[0]
		return a ? (this.contentOf(a)?.auxSrc ?? null) : null
	}

	/** Layer ids of all armed screens (union); the first name wins. */
	allLayers() {
		const byId = new Map()
		for (const s of this.armedScreens) {
			for (const l of this.contentOf(s)?.layers ?? []) if (!byId.has(l.id)) byId.set(l.id, l)
		}
		return [...byId.values()].sort((a, b) => a.id - b.id)
	}

	clearArmed() {
		this.armedList = []
		this.armedContent.clear()
		this.selectedLayer = null
	}

	removeArmed(type, id) {
		this.armedList = this.armedList.filter((a) => !(a.type === type && a.id === id))
		this.armedContent.delete(destKey(type, id))
		this.selectedByDest.delete(id)
		if (this.armedScreens.length === 0) this.selectedLayer = null
		else if (this.selectedLogical === null && this.selectedLayer !== null && this.selectedLayer >= 0 && !this.allLayers().some((l) => l.id === this.selectedLayer)) {
			this.selectedLayer = null
		}
	}

	sourceName(id) {
		if (id === undefined || id === null) return ''
		return this.sources.find((s) => s.id === id)?.Name ?? `Source ${id}`
	}

	destChoices() {
		return [
			...this.screens.map((d) => ({ id: destKey('screen', d.id), label: `Screen ${d.id}: ${d.Name ?? ''}` })),
			...this.auxes.map((d) => ({ id: destKey('aux', d.id), label: `Aux ${d.id}: ${d.Name ?? ''}` })),
		]
	}

	layerChoices() {
		// layers that are in preview / program come from listContent; the others are added from the destination's layer count
		const names = new Map(this.allLayers().map((l) => [l.id, l.name]))
		let count = 0
		for (const s of this.armedScreens) {
			const d = this.findDest('screen', s.id)
			const n = Number(d?.LayerCount ?? d?.NumLayers ?? d?.MaxLayers ?? (Array.isArray(d?.Layers) ? d.Layers.length : 0))
			if (Number.isFinite(n)) count = Math.max(count, n)
		}
		const maxKnown = names.size ? Math.max(...names.keys()) + 1 : 0
		const total = Math.max(count > 0 ? count : MAX_LAYER_FALLBACK, maxKnown)
		const ids = Array.from({ length: total }, (_, i) => i)
		const base = [...new Set([...ids, ...names.keys()])].sort((a, b) => a - b).map((id) => ({ id, label: names.has(id) ? `${names.get(id)} (id ${id})` : `Layer id ${id}` }))
		return [...base, { id: BG_PVW, label: 'Background – Preview' }, { id: BG_PGM, label: 'Background – Program' }]
	}

	sourceChoices() {
		return this.sources.map((s) => ({ id: s.id, label: `${s.id}: ${s.Name ?? ''}` }))
	}

	/* ------------------------------------------------------------------ arm / unarm / select */

	/** Sends arm / unarm to the processor for the given entries (failures are logged; the next poll corrects the display). */
	async sendArm(entries, arm) {
		if (entries.length === 0) return
		this.armGraceUntil = Date.now() + 1500
		try {
			await this.client.armUnarmDestination(
				entries.filter((e) => e.type === 'screen').map((e) => e.id),
				entries.filter((e) => e.type === 'aux').map((e) => e.id),
				arm,
			)
		} catch (e) {
			this.log('error', `${arm ? 'Arm' : 'Unarm'} ${entries.map((x) => x.name).join(', ')} failed: ${e.message}`)
		}
	}

	/** Arms a destination on the processor. Single mode: everything else is unarmed first. Multi-select mode: it is added. */
	async armDestination(type, id) {
		const dest = this.findDest(type, id)
		if (!dest) {
			this.log('warn', `Destination ${type}:${id} not found`)
			return
		}
		if (this.isArmed(type, id)) return
		const entry = { type, id, name: dest.Name ?? `${type} ${id}` }
		if (!this.multi && this.armedList.length > 0) {
			const others = [...this.armedList]
			await this.sendArm(others, false)
			this.clearArmed()
		}
		await this.sendArm([entry], true)
		this.armedList = [...this.armedList, entry]
		this.afterStateChange()
		try {
			await this.refreshContentOf(entry)
		} catch (e) {
			this.log('error', `Could not read content of ${entry.name}: ${e.message}`)
		}
		this.afterStateChange()
	}

	/** Unarms ONE destination on the processor. */
	async unarmDestination(type, id) {
		const entry = this.armedList.find((a) => a.type === type && a.id === id)
		if (!entry) return
		await this.sendArm([entry], false)
		this.removeArmed(type, id)
		this.afterStateChange()
	}

	/** Unarms everything that is armed. */
	async unarm() {
		await this.sendArm([...this.armedList], false)
		this.clearArmed()
		this.afterStateChange()
	}

	async toggleDestination(type, id) {
		if (this.isArmed(type, id)) {
			if (this.multi) await this.unarmDestination(type, id)
			else await this.unarm()
			return
		}
		await this.armDestination(type, id)
	}

	async setMulti(mode) {
		const on = mode === 'toggle' ? !this.multi : mode === 'on'
		if (on === this.multi) return
		this.multi = on
		if (!on && this.armedList.length > 1) {
			const keep = this.armedList[0]
			this.log('info', `Multi-select off: only ${keep.name} stays armed`)
			const extra = this.armedList.slice(1)
			await this.sendArm(extra, false)
			for (const a of extra) this.removeArmed(a.type, a.id)
		}
		this.afterStateChange()
	}

	/** The layer id to edit on this screen: the A/B choice made for it, or the plain layer id. */
	selectedFor(screenId) {
		if (this.selectedLayer === null || this.selectedLayer < 0) return null
		if (this.selectedLogical !== null) return this.selectedByDest.get(screenId) ?? this.resolveFree(screenId, this.selectedLogical)
		return this.selectedLayer
	}

	/**
	 * Layers come in A/B pairs: id 0 = 1A, id 1 = 1B, id 2 = 2A ... Picks the one of logical layer `n` that is NOT on program
	 * (so the next thing you set up is what appears in preview). If neither or both are on program, A is used.
	 */
	resolveFree(screenId, n) {
		const layers = this.contentOf({ type: 'screen', id: screenId })?.layers ?? []
		const a = layers.find((l) => l.id === (n - 1) * 2)
		const b = layers.find((l) => l.id === (n - 1) * 2 + 1)
		const onPgm = (l) => l && Number(l.pgmMode) > 0
		let id = (n - 1) * 2 // A
		if (onPgm(a) && !onPgm(b)) id = (n - 1) * 2 + 1
		else if (!onPgm(a) && !onPgm(b) && b && Number(b.pvwMode) > 0 && !(a && Number(a.pvwMode) > 0)) id = (n - 1) * 2 + 1
		this.selectedByDest.set(screenId, id)
		return id
	}

	/** Button "Layer n": on every armed screen select whichever of A / B is free (not on program). */
	async selectLogical(n) {
		const screens = this.armedScreens
		if (screens.length === 0) return this.log('warn', 'Select layer: arm a Screen Destination first')
		await this.flushLive()
		this.live = null
		try {
			await this.refreshArmedContent() // decide from the CURRENT program state
		} catch (e) {
			this.log('error', `Select layer: could not read content: ${e.message}`)
		}
		this.selectedLogical = n
		this.selectedByDest.clear()
		const ids = []
		for (const s of screens) {
			const id = this.resolveFree(s.id, n)
			const ls = this.contentOf(s)?.layers ?? []
			const pa = ls.find((x) => x.id === (n - 1) * 2)?.pgmMode
			const pb = ls.find((x) => x.id === (n - 1) * 2 + 1)?.pgmMode
			this.log('info', `Layer ${n} on ${s.name}: using ${n}${id % 2 === 0 ? 'A' : 'B'} (id ${id}; PgmMode A=${JSON.stringify(pa)} B=${JSON.stringify(pb)})`)
			ids.push(id)
		}
		this.selectedLayer = ids[0]
		this.afterStateChange()
	}

	/** Selects the same layer (or the background) on every armed screen. */
	selectLayer(layerId) {
		if (this.armedList.length === 0) return this.log('warn', 'Select layer: no destination is armed')
		const screens = this.armedScreens
		if (screens.length === 0) return this.log('warn', 'Select layer: an Aux has no layers, assign the input directly')
		this.selectedLayer = layerId
		this.selectedLogical = null
		this.selectedByDest.clear()
		this.afterStateChange()
	}

	/** Routes the input to the selected layer / background of EVERY armed screen, and to every armed aux. */
	async assignInput(srcId, auxTarget) {
		if (this.armedList.length === 0) return this.log('warn', 'Assign input: no destination is armed')
		let noLayer = false
		for (const entry of this.armedList) {
			try {
				if (entry.type === 'aux') {
					const pvw = auxTarget === 'pgm' ? undefined : srcId
					const pgm = auxTarget === 'pvw' ? undefined : srcId
					await this.client.changeAuxContent(entry.id, entry.name, pvw, pgm)
				} else if (this.selectedLayer === null) {
					noLayer = true
				} else if (this.selectedLayer < 0) {
					// background: BGLyr id 0 = Program, 1 = Preview
					await this.client.changeBackground(entry.id, this.selectedLayer === BG_PVW ? 1 : 0, srcId)
				} else {
					const lid = this.selectedFor(entry.id)
					const layer = this.contentOf(entry)?.layers.find((l) => l.id === lid)
					const inactive = !layer || layer.pvwMode === 0 || layer.pvwMode === '0'
					await this.client.changeContent(entry.id, lid, srcId, inactive)
				}
			} catch (e) {
				this.log('error', `Assign input failed on ${entry.name}: ${e.message}`)
			}
		}
		if (noLayer) this.log('warn', 'Assign input: no layer selected (armed screens were skipped)')
		try {
			await this.refreshArmedContent()
		} catch (e) {
			this.log('error', `Assign input: could not refresh: ${e.message}`)
		}
		this.afterStateChange()
	}

	/* ------------------------------------------------------------------ position / size / guides */

	/** For every armed screen that has the selected layer: its fresh window rect and destination size. */
	async geometryContexts() {
		const screens = this.armedScreens
		if (screens.length === 0) {
			this.log('warn', 'Position: arm a Screen Destination first')
			return []
		}
		if (this.selectedLayer === null || this.selectedLayer < 0) {
			this.log('warn', 'Position: select a real layer first (not the background)')
			return []
		}
		await this.flushLive() // pending jog / shuttle changes must be on the device first
		try {
			await this.refreshArmedContent() // always work from the current position
		} catch (e) {
			this.log('error', `Position: could not read content: ${e.message}`)
			return []
		}
		const out = []
		for (const entry of screens) {
			const dest = this.findDest('screen', entry.id)
			const layer = this.contentOf(entry)?.layers.find((l) => l.id === this.selectedFor(entry.id))
			const w = Number(dest?.HSize)
			const h = Number(dest?.VSize)
			if (!layer) {
				this.log('warn', `Position: ${entry.name} has no layer ${this.selectedFor(entry.id)}, skipped`)
			} else if (!layer.rect) {
				this.log('warn', `Position: no position data for ${entry.name} in the reply (firmware format?). Use the raw call action to inspect listContent.`)
			} else if (!(w > 0 && h > 0)) {
				this.log('warn', `Position: destination size (HSize/VSize) of ${entry.name} not available`)
			} else {
				const rect = layer.rect // what the device reports is the truth (it may clamp / recompute what was written)
				out.push({ entry, layer, dest: { w, h }, rect })
			}
		}
		return out
	}

	/** Writes a new rect (made by `makeRect(context)`) to the layer of every context. */
	async applyToAll(contexts, makeRect, partialOk = false) {
		if (contexts.length === 0) return
		await this.flushLive()
		this.live = null // the next rotary edit starts from the new position
		for (const ctx of contexts) {
			try {
				const pgm = Array.isArray(ctx.layer.rawWindow) ? ctx.layer.rawWindow[1] : undefined
				const target = makeRect(ctx)
				const k = `${ctx.entry.id}:${ctx.layer.id}`
				this.log('info', `Align/Fill on ${ctx.entry.name} (destination ${ctx.dest.w}x${ctx.dest.h}) layer ${ctx.layer.id}: device window ${JSON.stringify(ctx.layer.rect)}, base ${JSON.stringify(ctx.rect)} → target ${JSON.stringify(target)}\n  RAW layer before: ${JSON.stringify(ctx.layer.raw)}`)
				let done = false
				if (partialOk && this.partialWindow !== false) done = await this.writeWindowPartial(ctx, target, pgm)
				const extras = this.echoExtras(ctx.layer.raw, this.lastWritten.get(k)?.mask ?? ctx.layer.mask)
				if (!done) await this.writeGeometry(ctx.entry.id, ctx.layer.id, 'window', target, pgm, extras)
				// check that the unit really applied it; if not, forget the remembered format and find one that works
				if (!(await this.windowApplied(ctx, target))) {
					this.log('warn', `Align/Fill: the unit did not apply ${JSON.stringify(target)} (last request: ${JSON.stringify(this.client.lastRequest?.params)}). Trying the other write formats...`)
					this.writeFormats.window = null
					await this.writeGeometry(ctx.entry.id, ctx.layer.id, 'window', target, pgm, extras)
				}
			} catch (e) {
				this.log('error', `Move/resize failed on ${ctx.entry.name}: ${e.message}`)
			}
		}
		try {
			await this.refreshArmedContent()
			for (const ctx of contexts) {
				const now = this.contentOf(ctx.entry)?.layers.find((l) => l.id === ctx.layer.id)
				if (now?.rect) this.lastWritten.set(`${ctx.entry.id}:${ctx.layer.id}`, { rect: { ...now.rect }, mask: now.mask ? { ...now.mask } : undefined, t: Date.now() })
				this.log('info', `Align/Fill result on ${ctx.entry.name}: device now reports ${JSON.stringify(now?.rect)}\n  RAW layer after: ${JSON.stringify(now?.raw)}`)
			}
		} catch (e) {
			this.log('error', `Move/resize: could not refresh: ${e.message}`)
		}
		this.afterStateChange()
	}

	/** Clear: takes the selected layer (A or B, whichever is selected on each armed screen) out of the preview. */
	clearLayer() {
		return this.enqueue(async () => {
			const screens = this.armedScreens
			if (screens.length === 0) return this.log('warn', 'Clear: arm a Screen Destination first')
			if (this.selectedLayer === null || this.selectedLayer < 0) return this.log('warn', 'Clear: select a real layer first')
			await this.flushLive()
			this.live = null
			for (const s of screens) {
				const lid = this.selectedFor(s.id)
				try {
					await this.client.clearLayers(s.id, [lid])
					let stillOn = await this.previewOn(s, lid)
					if (stillOn) {
						this.log('warn', `Clear: clearLayers did not remove layer ${lid} from the preview of ${s.name}, trying changeContent PvwMode 0`)
						await this.client.removeFromPreview(s.id, lid)
						stillOn = await this.previewOn(s, lid)
					}
					this.log(stillOn ? 'warn' : 'info', stillOn ? `Clear: layer ${lid} is still in the preview of ${s.name}` : `Clear: layer ${lid} removed from the preview of ${s.name}`)
				} catch (e) {
					this.log('warn', `Clear: clearLayers failed on ${s.name} (${e.message}), trying changeContent PvwMode 0`)
					try {
						await this.client.removeFromPreview(s.id, lid)
					} catch (e2) {
						this.log('error', `Clear failed on ${s.name}: ${e2.message}`)
					}
				}
			}
			try {
				await this.refreshArmedContent()
			} catch {}
			this.afterStateChange()
		})
	}

	async previewOn(entry, layerId) {
		try {
			const r = await this.readScreen(entry.id)
			const l = r.layers.find((x) => x.id === layerId)
			return !!l && Number(l.pvwMode) > 0
		} catch {
			return false
		}
	}

	/** Reads the layer back and checks that its preview window equals `target`. */
	async windowApplied(ctx, target) {
		return this.geometryApplied(ctx.entry.id, ctx.layer.id, 'window', target)
	}

	/** Reads the layer back and checks that its preview window (or mask) equals `target`. */
	async geometryApplied(destId, layerId, kind, target) {
		try {
			const content = await this.client.listContent(destId)
			const layers = Array.isArray(content) ? content : (content?.Layers ?? [])
			const layer = layers.find((l) => l?.id === layerId)
			const now = kind === 'window' ? rectOf(layer) : maskOf(layer)
			if (!now) return false
			return Object.keys(target).every((key) => Math.abs(now[key] - target[key]) <= 1)
		} catch {
			return true // cannot verify
		}
	}

	/**
	 * The Event Master links a layer's Window, Source (the part of the input that is shown) and Mask (crop). The official
	 * module therefore sends Source and Mask together with every Window. Moving a window alone can make the unit
	 * recompute them, which shows up as a crop that was not there. So the CURRENT Source and Mask are sent back unchanged.
	 */
	echoExtras(raw, mask) {
		const hasSource = raw?.Source !== undefined
		const mk = mask ?? maskOf(raw)
		// returns the extras in the shape matching the Window format being written: 'array' = [program, preview] like the reply
		return (format) => {
			// Like the official module: a write to PREVIEW carries PvwMode 1 (the unit decides what the write applies to from these flags).
			// PgmMode keeps its current value so the layer is not taken off program.
			const out = { PvwMode: 1, PgmMode: Number(raw?.PgmMode) > 0 ? 1 : 0 }
			if (format === 'array') {
				if (hasSource) {
					const src = Array.isArray(raw.Source) ? raw.Source : [raw.Source, raw.Source]
					out.Source = src.map((s) => ({ ...s })) // [preview, program] exactly as read
				}
				if (raw?.Mask !== undefined || mk) {
					const base = Array.isArray(raw?.Mask) ? raw.Mask : [raw?.Mask, raw?.Mask]
					const pvw = { ...(base[0] ?? base[1] ?? { id: 0 }) }
					if (mk) Object.assign(pvw, { Top: mk.top, Left: mk.left, Right: mk.right, Bottom: mk.bottom })
					out.Mask = [pvw, { ...(base[1] ?? pvw) }]
				}
			} else {
				const pick = (v) => (Array.isArray(v) ? (v[0] ?? v[1]) : v)
				const s = pick(raw?.Source)
				if (s && [s.HPos, s.VPos, s.HSize, s.VSize].every((n) => Number.isFinite(Number(n)))) {
					out.Source = { HPos: Number(s.HPos), VPos: Number(s.VPos), HSize: Number(s.HSize), VSize: Number(s.VSize) }
				}
				if (mk) out.Mask = { Left: mk.left, Right: mk.right, Top: mk.top, Bottom: mk.bottom }
			}
			return out
		}
	}

	/** Mask-only writes also carry the preview flags. */
	modeExtras(raw) {
		return () => ({ PvwMode: 1, PgmMode: Number(raw?.PgmMode) > 0 ? 1 : 0 })
	}

	/**
	 * Align only moves ONE axis, so only that value is sent (HPos or VPos): size and the other axis can never change.
	 * It is verified by reading the layer back; if the unit does not accept partial windows, the full window is written instead.
	 */
	async writeWindowPartial(ctx, target, pgm) {
		const map = { x: 'HPos', y: 'VPos', w: 'HSize', h: 'VSize' }
		const changed = Object.keys(map).filter((key) => Math.abs(target[key] - ctx.rect[key]) > 0.5)
		if (changed.length === 0 || changed.length === 4) return false
		const fields = Object.fromEntries(changed.map((key) => [map[key], target[key]]))
		const pre = ctx.layer.rect
		const format = this.writeFormats.window ?? 'object'
		const extras = this.echoExtras(ctx.layer.raw, this.lastWritten.get(`${ctx.entry.id}:${ctx.layer.id}`)?.mask ?? ctx.layer.mask)
		await this.client.changeWindowFields(ctx.entry.id, ctx.layer.id, fields, format, pgm, extras)
		const content = await this.client.listContent(ctx.entry.id)
		const raw = Array.isArray(content) ? content : (content?.Layers ?? [])
		const after = rectOf(raw.find((l) => l?.id === ctx.layer.id))
		const near = (a, b) => Math.abs(a - b) <= 1
		const ok = !!after && Object.keys(map).every((key) => near(after[key], changed.includes(key) ? target[key] : pre[key]))
		if (this.partialWindow === undefined) {
			this.partialWindow = ok
			this.log('info', ok ? 'Align: the unit accepts partial window writes (only the changed value is sent)' : 'Align: partial window writes are not accepted by this unit, the full window is written instead')
		}
		return ok
	}

	async alignLayer(mode, reference) {
		const contexts = await this.geometryContexts()
		// every destination uses its own size and its own guides
		await this.applyToAll(contexts, (c) => alignRect(c.rect, c.dest, this.guides[c.entry.id] ?? { x: [], y: [] }, mode, reference), false)
	}

	async fillLayer(mode, keepAspect) {
		const contexts = await this.geometryContexts()
		await this.applyToAll(contexts, (c) => fillRect(c.rect, c.dest, mode, keepAspect))
	}

	/** Sets the same guide positions on every armed screen. */
	setGuides(axis, text) {
		const screens = this.armedScreens
		if (screens.length === 0) return this.log('warn', 'Guides: arm a Screen Destination first')
		const list = parseGuideList(text)
		for (const s of screens) {
			const entry = this.guides[s.id] ?? { x: [], y: [] }
			entry[axis] = list
			this.guides[s.id] = entry
		}
		this.saveGuides()
		this.log('info', `Guides ${axis.toUpperCase()}=[${list.join(', ')}] set on ${screens.map((s) => s.name).join(', ')}`)
		this.afterStateChange()
	}

	/* ------------------------------------------------------------------ presets / raw */

	/** Exactly ONE armed screen is required for actions that create something on the device. */
	singleScreen(what) {
		const screens = this.armedScreens
		if (screens.length === 0) {
			this.log('warn', `${what}: arm a Screen Destination first`)
			return null
		}
		if (screens.length > 1) {
			this.log('warn', `${what}: several destinations are armed, arm a single one`)
			return null
		}
		return screens[0]
	}

	/** Saves ONE preset that contains every armed screen (Aux destinations are not part of presets). */
	async savePreset(name, from) {
		const screens = this.armedScreens
		if (this.armedList.length === 0) return this.log('warn', 'Save preset: arm at least one destination first')
		if (!name) return this.log('warn', 'Save preset: empty name')
		const ids = screens.map((s) => s.id)
		const auxIds = this.armedAuxes.map((a) => a.id)
		let before = null
		try {
			before = (await this.client.listPresets()).length
		} catch {
			/* listPresets not available: cannot verify */
		}
		const errors = []
		const all = this.client.presetCandidates(name, ids, auxIds, from === 'pgm')
		const cands = this.presetShape ? all.filter((c) => c.key === this.presetShape) : all
		for (const c of cands.length > 0 ? cands : all) {
			try {
				await this.client.savePresetParams(c.params)
			} catch (e) {
				errors.push(`${c.key}: ${e.message}`)
				continue
			}
			if (before === null) {
				this.log('info', `Preset "${name}" sent (${c.key}, not verifiable)`)
				return
			}
			let created = false
			try {
				created = (await this.client.listPresets()).some((p) => (p?.Name ?? p?.presetName) === name)
			} catch {
				/* ignore */
			}
			if (created) {
				this.presetShape = c.key
				this.log('info', `Preset "${name}" saved from ${from === 'pgm' ? 'Program' : 'Preview'} (${this.armedList.map((s) => s.name).join(', ')}; ${c.key})`)
				return
			}
			errors.push(`${c.key}: accepted but no new preset`)
		}
		this.log('error', `Save preset failed. Tried: ${errors.join(' | ')}. Use "Send raw JSON-RPC" with savePreset to test your firmware.`)
	}

	/** Recalls the user key onto the selected layer of every armed screen. */
	async rawCall(method, paramsText) {
		let params = {}
		try {
			params = paramsText ? JSON.parse(paramsText) : {}
		} catch (e) {
			return this.log('error', `Raw call: params is not valid JSON (${e.message})`)
		}
		try {
			const r = await this.client.call(method, params)
			this.log('info', `Raw ${method} -> ${JSON.stringify(r)?.slice(0, 1500)}`)
		} catch (e) {
			this.log('error', `Raw ${method} failed: ${e.message}`)
		}
	}

	/* ------------------------------------------------------------------ rotary editing (jog / shuttle) */

	warnThrottled(text) {
		const now = Date.now()
		if (now - this.lastWarn < 2000) return
		this.lastWarn = now
		this.log('warn', text)
	}

	enqueue(fn) {
		this.opChain = this.opChain.then(fn).catch((e) => this.log('error', `Rotary edit failed: ${e.message}`))
		return this.opChain
	}

	/** Lights the "rotary step applied" feedback briefly. */
	flash() {
		this.flashUntil = Date.now() + FLASH_MS
		this.checkFeedbacks('rotary_active')
		if (this.flashTimer) clearTimeout(this.flashTimer)
		this.flashTimer = setTimeout(() => this.checkFeedbacks('rotary_active'), FLASH_MS + 20)
	}

	selectParam(param) {
		this.activeParam = param
		this.afterStateChange()
	}

	/** Makes sure `this.live` is a fresh working copy of the selected layer on EVERY armed screen. */
	async ensureLive() {
		const screens = this.armedScreens
		if (screens.length === 0 || this.selectedLayer === null || this.selectedLayer < 0) {
			this.warnThrottled('Rotary edit: arm a Screen Destination and select a real layer first')
			return false
		}
		const key = screens.map((s) => `${s.id}.${this.selectedFor(s.id)}`).join(',')
		const now = Date.now()
		if (this.live && this.live.key === key && now - this.live.t < LIVE_TTL_MS) {
			this.live.t = now
			return true
		}
		await this.flushLive()
		await this.refreshArmedContent()
		const items = []
		for (const s of this.armedScreens) {
			const layer = this.contentOf(s)?.layers.find((l) => l.id === this.selectedFor(s.id))
			if (!layer) continue
			if (layer.rect && !(layer.rect.w > 0 && layer.rect.h > 0)) {
				this.warnThrottled(`Rotary edit: ${s.name} layer ${layer.id} has no size yet (not in preview?). Assign an input first.`)
				continue
			}
			if (!layer.rect) {
				this.warnThrottled(`Rotary edit: no position data for ${s.name} in the reply (firmware format?)`)
				continue
			}
			const lw = this.lastWritten.get(`${s.id}:${layer.id}`)
			let rect = { ...layer.rect }
			let mask = layer.mask ? { ...layer.mask } : { top: 0, left: 0, right: 0, bottom: 0 }
			if (lw && Date.now() - lw.t < LAST_WRITTEN_MS) {
				const same = lw.rect && ['x', 'y', 'w', 'h'].every((k) => Math.abs(lw.rect[k] - rect[k]) <= 1)
				if (lw.rect && !same) {
					this.log('info', `Rotary: device reports window ${JSON.stringify(rect)} but ${JSON.stringify(lw.rect)} was just written: continuing from the written values`)
					rect = { ...lw.rect }
				}
				if (lw.mask) mask = { ...lw.mask }
			}
			this.log('info', `Rotary: ${s.name} layer ${layer.id} raw Window=${JSON.stringify(layer.rawWindow)} Mask=${JSON.stringify(layer.rawMask)} → ${JSON.stringify(rect)}`)
			items.push({
				key: `${s.id}:${layer.id}`,
				destId: s.id,
				layerId: layer.id,
				rect,
				aspect: rect.h > 0 ? rect.w / rect.h : 1,
				mask,
				raw: layer.raw,
				pgmWindow: Array.isArray(layer.rawWindow) ? layer.rawWindow[1] : undefined,
				pgmMask: Array.isArray(layer.rawMask) ? layer.rawMask[1] : undefined,
				dirty: { window: false, mask: false },
			})
		}
		if (items.length === 0) {
			this.warnThrottled('Rotary edit: the selected layer does not exist on the armed destinations')
			return false
		}
		this.live = { key, items, t: now }
		return true
	}

	adjustParam(direction, step, paramOption, anchor) {
		return this.enqueue(async () => {
			const param = paramOption === 'active' ? this.activeParam : paramOption
			if (!param) return this.warnThrottled('Rotary edit: first press Size / H Position / V Position / a Mask edge to choose what to change')
			if (!(await this.ensureLive())) return
			for (const item of this.live.items) {
				const part = applyDelta(item, param, direction * step, anchor)
				if (part) item.dirty[part] = true
			}
			this.flash()
			this.mirrorLiveIntoLayers()
			this.scheduleFlush()
		})
	}

	/** Updates the layer shown in variables right away, without waiting for the device. */
	mirrorLiveIntoLayers() {
		for (const item of this.live?.items ?? []) {
			const layer = this.contentOf({ type: 'screen', id: item.destId })?.layers.find((l) => l.id === item.layerId)
			if (layer) {
				layer.rect = { ...item.rect }
				layer.mask = { ...item.mask }
			}
		}
		this.updateVariables()
	}

	scheduleFlush() {
		if (this.flushTimer) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			this.enqueue(() => this.flushLive())
		}, FLUSH_MS)
	}

	async flushLive() {
		const live = this.live
		if (!live) return
		for (const item of live.items) {
			for (const kind of ['mask', 'window']) { // crop first: the unit recomputes the window and Source from it
				if (!item.dirty[kind]) continue
				item.dirty[kind] = false
				const target = kind === 'window' ? { ...item.rect } : { ...item.mask }
				try {
					if (kind === 'window') await this.resyncItem(item, false) // fresh Source / modes before a window write
					const pgm = kind === 'window' ? item.pgmWindow : item.pgmMask
					const extras = kind === 'window' ? this.echoExtras(item.raw, item.mask) : this.modeExtras(item.raw)
					await this.writeGeometry(item.destId, item.layerId, kind, target, pgm, extras)
					// the unit silently ignores writes in a format it does not understand: read back, and re-detect if needed
					if (!(await this.geometryApplied(item.destId, item.layerId, kind, target))) {
						this.log('warn', `Rotary: the unit did not apply the ${kind} ${JSON.stringify(target)} (last request: ${JSON.stringify(this.client.lastRequest?.params)}). Trying the other write formats...`)
						this.writeFormats[kind] = null
						await this.writeGeometry(item.destId, item.layerId, kind, target, pgm, extras)
					}
					const k = `${item.destId}:${item.layerId}`
					const prev = this.lastWritten.get(k) ?? {}
					this.lastWritten.set(k, { ...prev, [kind === 'window' ? 'rect' : 'mask']: target, t: Date.now() })
					// a crop changes the visible window and the Source region: continue from what the unit now reports,
					// so that Size keeps the aspect of the CROPPED window instead of the old uncropped one
					if (kind === 'mask') await this.resyncItem(item, true)
				} catch (e) {
					this.log('error', `Rotary edit failed on destination ${item.destId}: ${e.message}`)
				}
			}
		}
	}

	/**
	 * Re-reads the layer of a rotary item from the unit. `full`: also take over the window rect (+ aspect) and mask,
	 * unless the user has already changed them again (dirty). The raw layer (Source / modes) is always refreshed.
	 */
	async resyncItem(item, full) {
		try {
			const entry = this.armedScreens.find((s) => s.id === item.destId)
			if (!entry) return
			await this.refreshContentOf(entry)
			const layer = this.contentOf(entry)?.layers.find((l) => l.id === item.layerId)
			if (!layer) return
			item.raw = layer.raw
			item.pgmWindow = Array.isArray(layer.rawWindow) ? layer.rawWindow[1] : undefined
			item.pgmMask = Array.isArray(layer.rawMask) ? layer.rawMask[1] : undefined
			if (full) {
				if (layer.rect && layer.rect.w > 0 && layer.rect.h > 0 && !item.dirty.window) {
					item.rect = { ...layer.rect }
					item.aspect = layer.rect.w / layer.rect.h
				}
				if (layer.mask && !item.dirty.mask) item.mask = { ...layer.mask }
				this.log('info', `Rotary: after the crop the unit reports window ${JSON.stringify(item.rect)} mask ${JSON.stringify(item.mask)}`)
			}
		} catch (e) {
			this.log('warn', `Rotary: could not re-read the layer: ${e.message}`)
		}
	}

	/**
	 * Writes a layer's window or mask. The first write of each kind tries the known reply formats and keeps the
	 * one that is confirmed by reading the layer back (see layerops.js); later writes reuse it.
	 */
	async writeGeometry(destId, layerId, kind, target, pgm, extras) {
		const known = this.writeFormats[kind]
		const res = await writeLayer({
			client: this.client,
			destId,
			layerId,
			kind,
			target,
			pgm,
			extras,
			startFormat: known ?? 'object',
			verify: known === null,
		})
		if (known === null) {
			if (res.ok) {
				this.writeFormats[kind] = res.format
				this.log('info', `Layer ${kind} writes confirmed (format "${res.format}")`)
			} else {
				this.log('error', `Layer ${kind} write was not confirmed by reading it back. Use "Send raw JSON-RPC" to check how your firmware wants it.`)
			}
		}
		return res
	}

	maskDisable() {
		return this.enqueue(async () => {
			if (!(await this.ensureLive())) return
			for (const item of this.live.items) {
				const m = item.mask
				if (m.top || m.left || m.right || m.bottom) this.maskStash[item.key] = { ...m }
				item.mask = { top: 0, left: 0, right: 0, bottom: 0 }
				item.dirty.mask = true
			}
			this.mirrorLiveIntoLayers()
			await this.flushLive()
		})
	}

	maskEnable() {
		return this.enqueue(async () => {
			if (!(await this.ensureLive())) return
			let restored = 0
			for (const item of this.live.items) {
				const stash = this.maskStash[item.key]
				if (!stash) continue
				item.mask = { ...stash }
				delete this.maskStash[item.key]
				item.dirty.mask = true
				restored++
			}
			if (restored === 0) return this.warnThrottled('Mask Enable: no mask stored for this layer (use Mask Disable first, or set a mask with the rotary)')
			this.mirrorLiveIntoLayers()
			await this.flushLive()
		})
	}

	afterStateChange() {
		this.refreshDefinitionsIfChanged()
		this.updateVariables()
		this.checkFeedbacks()
	}

	/* ------------------------------------------------------------------ definitions */

	refreshDefinitionsIfChanged() {
		const sig = JSON.stringify([
			this.screens.map((d) => [d.id, d.Name]),
			this.auxes.map((d) => [d.id, d.Name]),
			this.sources.map((s) => [s.id, s.Name]),
			this.allLayers().map((l) => [l.id, l.name]),
		])
		if (sig === this.signature) return
		this.signature = sig
		this.updateDefinitions()
	}

	updateDefinitions() {
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
	}

	updateActions() {
		const dests = this.destChoices()
		const layers = this.layerChoices()
		const sources = this.sourceChoices()

		this.setActionDefinitions({
			arm_destination: {
				name: 'Arm / Unarm destination or aux',
				description: 'With Multi-select ON the destination is added to / removed from the selection, otherwise it replaces the selection.',
				options: [
					{ type: 'dropdown', id: 'dest', label: 'Destination / Aux', default: dests[0]?.id ?? '', choices: dests },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'arm', label: 'Arm' },
							{ id: 'unarm', label: 'Unarm' },
						],
					},
				],
				callback: async ({ options }) => {
					const { type, id } = parseKey(options.dest)
					if (options.mode === 'unarm') {
						if (this.isArmed(type, id)) await this.unarmDestination(type, id)
					} else if (options.mode === 'arm') {
						await this.armDestination(type, id)
					} else {
						await this.toggleDestination(type, id)
					}
				},
			},

			multi_select: {
				name: 'Multi-select destinations (on / off / toggle)',
				description:
					'ON: arming a destination adds it to the selection (press it again to remove it) and the layer you select is used on ALL armed screens. OFF: arming replaces the selection; turning it off keeps only the first armed destination.',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
						],
					},
				],
				callback: async ({ options }) => this.setMulti(options.mode),
			},

			unarm_all: {
				name: 'Unarm all (everything armed)',
				options: [],
				callback: async () => this.unarm(),
			},

			select_logical_layer: {
				name: 'Select layer N (auto A / B: the one that is free)',
				description:
					'Layer 1 = physical layers 1A and 1B (ids 0 and 1), layer 2 = 2A and 2B (ids 2 and 3) ... On EVERY armed screen the one that is NOT on program is selected, so what you set up appears in preview. Press it again after a transition to switch to the other one.',
				options: [{ type: 'number', id: 'n', label: 'Layer number (1, 2, 3 ...)', default: 1, min: 1, max: 64 }],
				callback: async ({ options }) => this.selectLogical(Number(options.n)),
			},
			select_layer: {
				name: 'Select layer or background (of the armed destination)',
				options: [{ type: 'dropdown', id: 'layer', label: 'Layer', default: layers[0]?.id ?? 0, choices: layers }],
				callback: async ({ options }) => this.selectLayer(Number(options.layer)),
			},

			assign_input: {
				name: 'Assign input to selected layer / background (or armed aux)',
				options: [
					{ type: 'dropdown', id: 'source', label: 'Input', default: sources[0]?.id ?? 0, choices: sources },
					{
						type: 'dropdown',
						id: 'auxTarget',
						label: 'Aux only: apply to',
						default: 'both',
						choices: [
							{ id: 'both', label: 'Preview + Program' },
							{ id: 'pvw', label: 'Preview only' },
							{ id: 'pgm', label: 'Program only' },
						],
					},
				],
				callback: async ({ options }) => this.assignInput(Number(options.source), options.auxTarget),
			},

			layer_align: {
				name: 'Align selected layer',
				description:
					'Reference "Destination" = edges of the destination. Reference "Guides" = the area between the guides (set with "Set guides") that the layer currently sits in.',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Align',
						default: 'center',
						choices: [
							{ id: 'left', label: 'Left' },
							{ id: 'right', label: 'Right' },
							{ id: 'top', label: 'Top' },
							{ id: 'bottom', label: 'Bottom' },
							{ id: 'hcenter', label: 'H Center' },
							{ id: 'vcenter', label: 'V Center' },
							{ id: 'center', label: 'Center (H + V)' },
						],
					},
					{
						type: 'dropdown',
						id: 'reference',
						label: 'Reference',
						default: 'dest',
						choices: [
							{ id: 'dest', label: 'Destination (absolute)' },
							{ id: 'guides', label: 'Guides' },
						],
					},
				],
				callback: async ({ options }) => this.alignLayer(options.mode, options.reference),
			},

			layer_fill: {
				name: 'Fill selected layer',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Fill',
						default: 'fillHV',
						choices: [
							{ id: 'fullH', label: 'Full screen Horizontal' },
							{ id: 'fullV', label: 'Full screen Vertical' },
							{ id: 'fillHV', label: 'Fill H/V (whole destination)' },
						],
					},
					{ type: 'checkbox', id: 'keepAspect', label: 'Keep aspect ratio (Full H / Full V)', default: true },
				],
				callback: async ({ options }) => this.fillLayer(options.mode, options.keepAspect),
			},

			select_param: {
				name: 'Select value to change with jog / shuttle',
				options: [{ type: 'dropdown', id: 'param', label: 'Value', default: 'size', choices: PARAM_CHOICES }],
				callback: async ({ options }) => this.selectParam(options.param),
			},

			adjust_param: {
				name: 'Adjust value (jog / shuttle rotate action)',
				description:
					'Put this on the ROTATE LEFT (Decrease) and ROTATE RIGHT (Increase) action lists of the jog wheel / shuttle ring buttons. Step is in pixels per click (mask: mask units). It accepts variables, e.g. $(custom:contourShuttleRing) for a step that grows with the ring position (the sign is ignored, the direction comes from the rotate action).',
				options: [
					{
						type: 'dropdown',
						id: 'direction',
						label: 'Direction',
						default: 'inc',
						choices: [
							{ id: 'dec', label: 'Decrease (rotate left)' },
							{ id: 'inc', label: 'Increase (rotate right)' },
						],
					},
					{ type: 'textinput', id: 'step', label: 'Step per click', default: '1', useVariables: true },
					{
						type: 'dropdown',
						id: 'param',
						label: 'Value',
						default: 'active',
						choices: [{ id: 'active', label: 'Whichever is selected (Size / H / V / Mask...)' }, ...PARAM_CHOICES],
					},
					{
						type: 'dropdown',
						id: 'anchor',
						label: 'Size: grow from',
						default: 'center',
						choices: [
							{ id: 'center', label: 'Center' },
							{ id: 'topleft', label: 'Top-left corner' },
						],
					},
				],
				callback: async ({ options }, context) => {
					const text = await context.parseVariablesInString(String(options.step))
					const parsed = Math.abs(Number(text))
					const step = Number.isFinite(parsed) ? parsed : 1
					if (step === 0) return
					await this.adjustParam(options.direction === 'dec' ? -1 : 1, step, options.param, options.anchor)
				},
			},

			clear_layer: {
				name: 'Clear selected layer (remove from preview)',
				options: [],
				callback: async () => this.clearLayer(),
			},

			mask_disable: {
				name: 'Mask Disable (remember and clear the layer mask)',
				description: 'The documented reply has no mask on/off flag, so this stores the current mask in the module and sets it to 0.',
				options: [],
				callback: async () => this.maskDisable(),
			},

			mask_enable: {
				name: 'Mask Enable (restore the remembered mask)',
				options: [],
				callback: async () => this.maskEnable(),
			},

			set_guides: {
				name: 'Set guides (armed screen destination)',
				description:
					'H guides = the lines used for HORIZONTAL alignment (H Center / Left / Right between two of them; pixel positions across the width). V guides = the lines used for VERTICAL alignment (V Center / Top / Bottom between two of them; pixel positions down the height). Comma separated pixels, empty clears.',
				options: [
					{
						type: 'dropdown',
						id: 'axis',
						label: 'Guides',
						default: 'y',
						choices: [
							{ id: 'y', label: 'V guides -> vertical alignment (V Center / Top / Bottom)' },
							{ id: 'x', label: 'H guides -> horizontal alignment (H Center / Left / Right)' },
						],
					},
					{ type: 'textinput', id: 'values', label: 'Pixel positions (e.g. 300, 1500)', default: '' },
				],
				callback: async ({ options }) => this.setGuides(options.axis, options.values),
			},

			save_preset: {
				name: 'Save preset (armed screen destination)',
				description: 'EXPERIMENTAL: the Preview/Program selector is not confirmed by the documentation I could find.',
				options: [
					{ type: 'textinput', id: 'name', label: 'Preset name', default: 'New Preset', useVariables: true },
					{
						type: 'dropdown',
						id: 'from',
						label: 'Save from',
						default: 'pvw',
						choices: [
							{ id: 'pvw', label: 'Preview' },
							{ id: 'pgm', label: 'Program' },
						],
					},
				],
				callback: async ({ options }, context) => {
					const name = await context.parseVariablesInString(options.name)
					await this.savePreset(name, options.from)
				},
			},

			raw_call: {
				name: 'Send raw JSON-RPC (for testing / discovery)',
				description: 'Result is written to the Companion log.',
				options: [
					{ type: 'textinput', id: 'method', label: 'Method', default: 'listContent' },
					{ type: 'textinput', id: 'params', label: 'Params (JSON)', default: '{"id":0}' },
				],
				callback: async ({ options }) => this.rawCall(options.method, options.params),
			},

			refresh: {
				name: 'Refresh data from Event Master',
				options: [],
				callback: async () => this.refreshAll(),
			},
		})
	}

	updateFeedbacks() {
		const dests = this.destChoices()
		const layers = this.layerChoices()

		this.setFeedbackDefinitions({
			destination_armed: {
				type: 'boolean',
				name: 'Destination / Aux is armed',
				defaultStyle: { bgcolor: ORANGE, color: WHITE },
				options: [{ type: 'dropdown', id: 'dest', label: 'Destination / Aux', default: dests[0]?.id ?? '', choices: dests }],
				callback: ({ options }) => this.armedList.some((a) => destKey(a.type, a.id) === String(options.dest)),
			},
			multi_select_on: {
				type: 'boolean',
				name: 'Multi-select mode is on',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [],
				callback: () => this.multi,
			},
			rotary_active: {
				type: 'boolean',
				name: 'Rotary step applied (short flash)',
				description: 'Lights up for a moment each time a jog / shuttle step was accepted by the module.',
				defaultStyle: { bgcolor: YELLOW, color: BLACK },
				options: [],
				callback: () => Date.now() < this.flashUntil,
			},
			param_active: {
				type: 'boolean',
				name: 'Jog / shuttle value is active',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [{ type: 'dropdown', id: 'param', label: 'Value', default: 'size', choices: PARAM_CHOICES }],
				callback: ({ options }) => this.activeParam === options.param,
			},
			layer_selected: {
				type: 'boolean',
				name: 'Layer / Background is selected',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [{ type: 'dropdown', id: 'layer', label: 'Layer', default: layers[0]?.id ?? 0, choices: layers }],
				callback: ({ options }) =>
					this.selectedLayer !== null && this.selectedLayer === Number(options.layer) && (this.selectedLogical === null || Number(options.layer) < 0),
			},
			logical_selected: {
				type: 'boolean',
				name: 'Layer N (auto A / B) is selected',
				defaultStyle: { bgcolor: GREEN, color: WHITE },
				options: [{ type: 'number', id: 'n', label: 'Layer number', default: 1, min: 1, max: 64 }],
				callback: ({ options }) => this.selectedLogical !== null && this.selectedLogical === Number(options.n),
			},
		})
	}

	updatePresets() {
		const presets = {}
		const button = (id, category, name, text, actionId, options, bgcolor = BLACK, feedbacks = []) => {
			presets[id] = {
				type: 'button',
				category,
				name,
				style: { text, size: '14', color: WHITE, bgcolor },
				steps: [{ down: [{ actionId, options }], up: [] }],
				feedbacks,
			}
		}

		// --- Arm
		for (const d of this.destChoices()) {
			button(
				`arm_${d.id}`,
				'Arm destination',
				`Arm ${d.label}`,
				d.label.replace(': ', '\\n'),
				'arm_destination',
				{ dest: d.id, mode: 'toggle' },
				BLACK,
				[{ feedbackId: 'destination_armed', options: { dest: d.id }, style: { bgcolor: ORANGE, color: WHITE } }],
			)
		}

		button('multi_select', 'Arm destination', 'Multi-select (on / off)', 'Multi\\nselect', 'multi_select', { mode: 'toggle' }, BLACK, [
			{ feedbackId: 'multi_select_on', options: {}, style: { bgcolor: YELLOW, color: BLACK } },
		])
		button('unarm_all', 'Arm destination', 'Unarm all', 'Unarm\\nall', 'unarm_all', {}, RED)

		// --- Layers + background
		// one button per logical layer: the free one of A / B is chosen on every armed screen
		const physical = this.layerChoices().filter((l) => l.id >= 0)
		const pairs = Math.max(1, Math.ceil(physical.length / 2))
		for (let n = 1; n <= pairs; n++) {
			button(`llayer_${n}`, 'Select layer', `Layer ${n} (auto A/B)`, `Layer ${n}\\n$(${this.label}:selected_ab)`, 'select_logical_layer', { n }, BLACK, [
				{ feedbackId: 'logical_selected', options: { n }, style: { bgcolor: GREEN, color: WHITE } },
			])
		}
		for (const l of this.layerChoices()) {
			const text = l.id === BG_PVW ? 'BG\\nPVW' : l.id === BG_PGM ? 'BG\\nPGM' : `${Math.floor(l.id / 2) + 1}${l.id % 2 === 0 ? 'A' : 'B'}\\n(id ${l.id})`
			const category = l.id < 0 ? 'Select layer' : 'Select layer (A/B direct)'
			button(`layer_${l.id}`, category, l.label, text, 'select_layer', { layer: l.id }, BLACK, [
				{ feedbackId: 'layer_selected', options: { layer: l.id }, style: { bgcolor: GREEN, color: WHITE } },
			])
		}


		// --- Inputs
		for (const s of this.sourceChoices()) {
			button(`src_${s.id}`, 'Assign input', `Input ${s.label}`, s.label.replace(': ', '\\n'), 'assign_input', {
				source: s.id,
				auxTarget: 'both',
			})
		}

		// --- Align / Fill (absolute, relative to the destination)
		const fills = [
			['fullH', 'Full H', 'Full screen Horizontal'],
			['fullV', 'Full V', 'Full screen Vertical'],
			['fillHV', 'Fill\\nH/V', 'Fill H/V'],
		]
		for (const [mode, text, name] of fills) {
			button(`fill_${mode}`, 'Align / Fill', name, text.includes('\\n') ? text : text.replace(' ', '\\n'), 'layer_fill', { mode, keepAspect: true }, BLUE)
		}
		const aligns = [
			['left', 'Align\\nLeft', 'Align Absolute Left'],
			['right', 'Align\\nRight', 'Align Absolute Right'],
			['top', 'Align\\nTop', 'Align Absolute Top'],
			['bottom', 'Align\\nBottom', 'Align Absolute Bottom'],
			['hcenter', 'Align\\nH Center', 'Align Absolute HCenter'],
			['vcenter', 'Align\\nV Center', 'Align Absolute VCenter'],
			['center', 'Align\\nCenter', 'Align Absolute Center'],
		]
		for (const [mode, text, name] of aligns) {
			button(`align_${mode}`, 'Align / Fill', name, text, 'layer_align', { mode, reference: 'dest' }, BLUE)
		}

		// --- Align to guides
		const guideAligns = [
			['hcenter', 'Guides\\nH Center', 'Align HCenter between guides'],
			['vcenter', 'Guides\\nV Center', 'Align VCenter between guides'],
			['center', 'Guides\\nCenter', 'Align Center between guides'],
		]
		for (const [mode, text, name] of guideAligns) {
			button(`galign_${mode}`, 'Align to guides', name, text, 'layer_align', { mode, reference: 'guides' }, PURPLE)
		}
		button('guides_y', 'Align to guides', 'Set V guides (vertical alignment)', 'Set V\\nguides', 'set_guides', { axis: 'y', values: '' }, PURPLE)
		button('guides_x', 'Align to guides', 'Set H guides (horizontal alignment)', 'Set H\\nguides', 'set_guides', { axis: 'x', values: '' }, PURPLE)

		// --- Shuttle (ShuttlePRO) : value selection buttons
		for (const [param, text] of [
			['size', 'Size'],
			['vpos', 'V\\nPosition'],
			['hpos', 'H\\nPosition'],
		]) {
			button(`param_${param}`, 'Shuttle', `Select ${PARAM_LABELS[param]}`, text, 'select_param', { param }, PURPLE, [
				{ feedbackId: 'param_active', options: { param }, style: { bgcolor: GREEN, color: WHITE } },
			])
		}
		button('mask_enable', 'Shuttle', 'Mask Enable', 'Mask\\nEnable', 'mask_enable', {}, PURPLE)
		button('clear_layer', 'Layers', 'Clear layer', 'Clear\\nlayer', 'clear_layer', {}, RED)
		button('mask_disable', 'Shuttle', 'Mask Disable', 'Mask\\nDisable', 'mask_disable', {}, PURPLE)
		for (const [param, text] of [
			['mask_left', 'Mask\\nLeft'],
			['mask_right', 'Mask\\nRight'],
			['mask_top', 'Mask\\nTop'],
			['mask_bottom', 'Mask\\nBottom'],
		]) {
			button(`param_${param}`, 'Shuttle', `Select ${PARAM_LABELS[param]}`, text, 'select_param', { param }, PURPLE, [
				{ feedbackId: 'param_active', options: { param }, style: { bgcolor: GREEN, color: WHITE } },
			])
		}

		// --- Shuttle (ShuttlePRO) : rotary buttons (drag onto the jog / shuttle positions of the surface)
		const rotary = (id, name, text, step) => {
			presets[id] = {
				type: 'button',
				category: 'Shuttle rotary',
				name,
				options: { rotaryActions: true },
				style: { text, size: '14', color: WHITE, bgcolor: BLACK },
				steps: [
					{
						down: [],
						up: [],
						rotate_left: [{ actionId: 'adjust_param', options: { direction: 'dec', step, param: 'active', anchor: 'center' } }],
						rotate_right: [{ actionId: 'adjust_param', options: { direction: 'inc', step, param: 'active', anchor: 'center' } }],
					},
				],
				feedbacks: [{ feedbackId: 'rotary_active', options: {}, style: { bgcolor: YELLOW, color: BLACK } }],
			}
		}
		rotary('rot_jog', 'Jog wheel (fixed step)', `Jog\\n$(${this.label}:active_param)`, '1')
		rotary('rot_ring_stop', 'Shuttle ring: one step per stop', 'Ring\\nper stop', '1')
		rotary('rot_ring_freq', 'Shuttle ring: frequency proportional', 'Ring\\nfrequency', '1')

		// --- Save
		button('save_pvw', 'Save', 'Save from PVW', 'Save\\nfrom PVW', 'save_preset', { name: 'New Preset', from: 'pvw' }, RED)
		button('save_pgm', 'Save', 'Save from PGM', 'Save\\nfrom PGM', 'save_preset', { name: 'New Preset', from: 'pgm' }, RED)

		this.setPresetDefinitions(presets)
	}

	updateVariables() {
		const screen = this.armedScreens[0] ?? null // the first armed screen feeds the single-value variables
		const layer = this.layers.find((l) => l.id === this.selectedLayer)
		const dest = screen ? this.findDest('screen', screen.id) : null
		const g = screen ? (this.guides[screen.id] ?? { x: [], y: [] }) : { x: [], y: [] }

		let layerName = layer ? layer.name : ''
		let source = ''
		if (screen && layer) source = this.sourceName(layer.src)
		if (screen && this.selectedLayer === BG_PVW) {
			layerName = 'Background PVW'
			source = this.sourceName(this.bg.pvw)
		}
		if (screen && this.selectedLayer === BG_PGM) {
			layerName = 'Background PGM'
			source = this.sourceName(this.bg.pgm)
		}
		if (!screen && this.armedAuxes.length > 0) source = this.sourceName(this.auxSrc)

		const types = new Set(this.armedList.map((a) => a.type))
		this.setVariableValues({
			armed_destination: this.armedList.length > 0 ? this.armedList.map((a) => a.name).join(', ') : 'None',
			armed_type: types.size > 1 ? 'Mixed' : types.has('screen') ? 'Screen' : types.has('aux') ? 'Aux' : '',
			armed_count: this.armedList.length,
			multi_select: this.multi ? 'On' : 'Off',
			selected_ab: this.selectedLayer !== null && this.selectedLayer >= 0 ? this.armedScreens.map((s) => { const id = this.selectedFor(s.id); return id === null ? '' : `${s.name} ${Math.floor(id / 2) + 1}${id % 2 === 0 ? 'A' : 'B'}` }).filter(Boolean).join(' | ') : '',
			selected_layer: layerName,
			selected_layer_source: source,
			layer_list: this.layers.map((l) => `${l.id}: ${l.name}`).join(', '),
			layer_x: layer?.rect?.x ?? '',
			layer_y: layer?.rect?.y ?? '',
			layer_w: layer?.rect?.w ?? '',
			layer_h: layer?.rect?.h ?? '',
			dest_w: dest?.HSize ?? '',
			dest_h: dest?.VSize ?? '',
			guides_x: (g.x ?? []).join(', '),
			guides_y: (g.y ?? []).join(', '),
			active_param: this.activeParam ? PARAM_LABELS[this.activeParam] : 'None',
		})
	}
}

runEntrypoint(BarcoEventMasterInstance, [])
