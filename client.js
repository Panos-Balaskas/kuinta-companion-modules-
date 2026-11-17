/**
 * Minimal JSON-RPC 2.0 client for the Barco Event Master "Toolset" API.
 * The processor exposes it over plain HTTP on port 9999.
 * (With a host/client setup, always talk to the host unit.)
 */
export class EventMasterClient {
	constructor(host, port = 9999, timeoutMs = 3000, authMode = 'none', authValue = '') {
		this.authMode = authMode
		this.authValue = authValue
		this.url = `http://${host}:${port}`
		this.timeoutMs = timeoutMs
		this.seq = 0
	}

	/** Sends one JSON-RPC call and returns `result.response` (or `result`). Throws on any failure. */
	async call(method, params = {}) {
		// multi-operator mode: write calls need the operator index or the super user password
		const WRITES = ['recallUserKey', 'savePreset', 'armUnarmDestination', 'activatePreset', 'changeContent', 'changeAuxContent', 'clearLayers']
		if (WRITES.includes(method) && this.authValue !== '' && this.authValue !== undefined) {
			if (this.authMode === 'operator') params = { ...params, operatorId: Number(this.authValue) }
			if (this.authMode === 'super_user') params = { ...params, password: String(this.authValue) }
		}
		this.lastRequest = { method, params } // for diagnostics
		const body = { jsonrpc: '2.0', method, params, id: String(++this.seq) }

		const res = await fetch(this.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		})
		if (!res.ok) throw new Error(`HTTP ${res.status}`)

		const json = await res.json()
		if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`)

		const result = json.result
		// Event Master reports its own status: 0 = success, anything else = error
		if (result && typeof result === 'object' && result.success !== undefined && result.success !== 0) {
			throw new Error(`${method}: Event Master returned error code ${result.success}`)
		}
		return result && typeof result === 'object' && 'response' in result ? result.response : result
	}

	/** -> { screens: [...], auxes: [...] } */
	async listDestinations() {
		let r = await this.call('listDestinations', { type: 0 })
		this.lastRawDestinations = r
		let obj = Array.isArray(r) ? (r[0] ?? {}) : (r ?? {})
		let screens = obj.ScreenDestination ?? []
		let auxes = obj.AuxDestination ?? []
		if (screens.length === 0 && auxes.length === 0) {
			// retry without params in case this firmware dislikes `type`
			r = await this.call('listDestinations', {})
			this.lastRawDestinations = r
			obj = Array.isArray(r) ? (r[0] ?? {}) : (r ?? {})
			screens = obj.ScreenDestination ?? []
			auxes = obj.AuxDestination ?? []
		}
		return { screens, auxes }
	}

	/** -> [{ id, Name, ... }] input sources (type 0 = Input, 1 = Background) */
	async listSources(type = 0) {
		let r = await this.call('listSources', { type })
		if (!Array.isArray(r) || r.length === 0) r = await this.call('listSources', {})
		this.lastRawSources = r
		return Array.isArray(r) ? r : []
	}

	/** Content (layers) of a Screen Destination */
	listContent(destId) {
		return this.call('listContent', { id: destId })
	}

	/** Route a source to ONE layer of a Screen Destination (partial update: only that layer is sent) */
	changeContent(destId, layerId, srcIdx, activatePreview = false) {
		const layer = { id: layerId, LastSrcIdx: srcIdx }
		if (activatePreview) layer.PvwMode = 1 // put a layer that is not in preview into preview
		return this.call('changeContent', {
			id: destId,
			Layers: [layer],
		})
	}

	/** Removes layers from the preview of a screen destination (same call as the official module's "Clear Layers"). */
	clearLayers(destId, layerIds) {
		// Barco JSON-RPC document: { screenId, Layers: [{ id }] } (the document says it applies to custom mode)
		return this.call('clearLayers', { screenId: destId, Layers: layerIds.map((id) => ({ id })) })
	}

	/** Fallback: takes a layer out of preview with changeContent. */
	removeFromPreview(destId, layerId) {
		return this.call('changeContent', { id: destId, Layers: [{ id: layerId, PvwMode: 0 }] })
	}

	/** Move/resize one layer's window (preview). r = { x, y, w, h } */
	changeWindow(destId, layerId, r) {
		return this.call('changeContent', {
			id: destId,
			Layers: [{ id: layerId, Window: { HPos: r.x, VPos: r.y, HSize: r.w, VSize: r.h } }],
		})
	}

	/**
	 * Writes a layer's Window or Mask in one of several candidate formats (see layerops.js).
	 * window target {x,y,w,h}; mask target {top,left,right,bottom}
	 */
	changeLayerGeometry(destId, layerId, kind, target, format, pgm, extras) {
		let layer
		if (kind === 'window') {
			const w = { HPos: target.x, VPos: target.y, HSize: target.w, VSize: target.h }
			if (format === 'object') layer = { id: layerId, Window: w }
			else if (format === 'array') layer = { id: layerId, Window: [w, pgm ?? w] }
			else layer = { id: layerId, ...w }
		} else {
			const m = { id: 0, Top: target.top, Left: target.left, Right: target.right, Bottom: target.bottom }
			if (format === 'object') layer = { id: layerId, Mask: m }
			else layer = { id: layerId, Mask: [m, pgm ?? m] }
		}
		if (extras) layer = { ...layer, ...(typeof extras === 'function' ? extras(format) : extras) } // Source + Mask echoed unchanged, in the SAME shape as the Window (see main.js echoExtras)
		return this.call('changeContent', { id: destId, Layers: [layer] })
	}

	/** Writes ONLY the given window fields (HPos / VPos / HSize / VSize), leaving the others untouched. */
	changeWindowFields(destId, layerId, fields, format, pgm, extras) {
		let layer
		if (format === 'array') layer = { id: layerId, Window: [fields, pgm ?? fields] }
		else if (format === 'flat') layer = { id: layerId, ...fields }
		else layer = { id: layerId, Window: fields }
		if (extras) layer = { ...layer, ...(typeof extras === 'function' ? extras(format) : extras) }
		return this.call('changeContent', { id: destId, Layers: [layer] })
	}

	/** Background of a Screen Destination. bgId: 0 = Program background, 1 = Preview background */
	changeBackground(destId, bgId, srcIdx) {
		return this.call('changeContent', {
			id: destId,
			BGLyr: [{ id: bgId, LastBGSourceIndex: srcIdx }],
		})
	}

	/**
	 * savePreset is documented with presetName + ScreenDestination only.
	 * `type` (0 = from preview, 1 = from program) is a GUESS modelled on activatePreset: verify on a real unit.
	 */
	/**
	 * Arms / unarms destinations on the processor (the same "arm" as in the Event Master UI).
	 * Documented: { arm: 1 | 0, ScreenDestination: [{id}], AuxDestination: [{id}] }
	 */
	armUnarmDestination(screenIds, auxIds, arm) {
		return this.call('armUnarmDestination', {
			arm: arm ? 1 : 0,
			ScreenDestination: screenIds.map((id) => ({ id })),
			AuxDestination: auxIds.map((id) => ({ id })),
		})
	}

	/**
	 * savePreset as documented: { presetName, ScreenDestination: [{id}], AuxDestination: [{id}], saveFromProgram: 1 }.
	 * Without saveFromProgram the preset is saved from PREVIEW; without destinations it uses the armed ones.
	 */
	presetCandidates(name, screenIds, auxIds, fromProgram) {
		const base = { presetName: name }
		if (fromProgram) base.saveFromProgram = 1
		const out = []
		if (screenIds.length > 0 || auxIds.length > 0) {
			out.push({
				key: 'explicit',
				params: { ...base, ScreenDestination: screenIds.map((id) => ({ id })), AuxDestination: auxIds.map((id) => ({ id })) },
			})
		}
		out.push({ key: 'armed', params: { ...base } })
		return out
	}

	savePresetParams(params) {
		return this.call('savePreset', params)
	}

	async listPresets() {
		let r
		try {
			r = await this.call('listPresets', { ScreenDest: -1, AuxDest: -1 })
		} catch {
			r = await this.call('listPresets', {})
		}
		return Array.isArray(r) ? r : (r?.Presets ?? r?.Preset ?? [])
	}

	/** User keys: the method name differs between sources (listUserKeys / listUserKey), so try both. */
	async listUserKeys() {
		let lastError
		for (const method of ['listUserKeys', 'listUserKey']) {
			try {
				const r = await this.call(method, {})
				const arr = Array.isArray(r) ? r : (r?.UserKeys ?? r?.UserKey ?? [])
				return Array.isArray(arr) ? arr : []
			} catch (e) {
				lastError = e
			}
		}
		throw lastError
	}

	/**
	 * recallUserKey params as documented: { id | userkeyName, ScreenDestination: [indexes], Layer: [layer indexes] }
	 * (whether the arrays hold plain numbers or {id} objects is not 100% confirmed: verify on a real unit).
	 */
	recallUserKey(idOrName, destId, layerId) {
		const key = typeof idOrName === 'string' ? { userkeyName: idOrName } : { id: idOrName }
		return this.call('recallUserKey', { ...key, ScreenDestination: [destId], Layer: [layerId] })
	}

	/** Content of an Aux Destination */
	listAuxContent(auxId) {
		return this.call('listAuxContent', { id: auxId })
	}

	/** Route a source to an Aux Destination. Pass `undefined` to leave pvw or pgm untouched. */
	changeAuxContent(auxId, name, pvwSrcIdx, pgmSrcIdx) {
		const params = { id: auxId }
		if (name) params.Name = name
		if (pvwSrcIdx !== undefined) params.PvwLastSrcIndex = pvwSrcIdx
		if (pgmSrcIdx !== undefined) params.PgmLastSrcIndex = pgmSrcIdx
		return this.call('changeAuxContent', params)
	}
}
