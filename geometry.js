/**
 * Pure helpers for window position / size maths. No Companion or network code here.
 * A rect is { x, y, w, h } in destination pixels (x = HPos, y = VPos, w = HSize, h = VSize).
 */

/**
 * Reads a layer's window rectangle from a listContent layer.
 * Firmware differs: older replies have HPos/VPos/HSize/VSize on the layer itself,
 * newer ones have `Window` as an array [pgm, pvw] (or a single object).
 * We prefer the PREVIEW entry (index 1) because changeContent edits preview.
 */
export function rectOf(layer) {
	if (!layer) return null
	const w = layer.Window
	let r
	if (Array.isArray(w)) {
		// a layer that is not in preview may report an empty preview window: then use the program one
		const empty = (e) => !e || !(Number(e.HSize) > 0 && Number(e.VSize) > 0)
		// OBSERVED on a real unit: the PREVIEW entry is index 0 and the program one index 1 (what the Toolset shows in preview is Window[0])
		r = !empty(w[0]) ? w[0] : !empty(w[1]) ? w[1] : (w[0] ?? w[1])
	}
	else if (w && typeof w === 'object') r = w
	else r = layer
	if (!r) return null
	const x = Number(r.HPos)
	const y = Number(r.VPos)
	const width = Number(r.HSize)
	const height = Number(r.VSize)
	if (![x, y, width, height].every(Number.isFinite)) return null
	return { x, y, w: width, h: height }
}

/** "300, 1500" -> [300, 1500] (sorted, unique, numbers only) */
export function parseGuideList(text) {
	const nums = String(text ?? '')
		.split(/[\s,;]+/)
		.filter((s) => s !== '')
		.map(Number)
		.filter(Number.isFinite)
	return [...new Set(nums)].sort((a, b) => a - b)
}

/**
 * Splits [0, size] at the guides and returns the region that contains `center`.
 * With no guides the region is the whole destination.
 */
export function regionFor(center, size, guides = []) {
	const inner = guides.filter((g) => g > 0 && g < size)
	const bounds = [0, ...inner, size]
	let idx = bounds.length - 2
	for (let i = 0; i < bounds.length - 1; i++) {
		if (center < bounds[i + 1]) {
			idx = i
			break
		}
	}
	if (center < 0) idx = 0
	return { start: bounds[idx], end: bounds[idx + 1] }
}

/**
 * Aligns a rect inside the destination (reference 'dest') or inside the
 * region between guides that the window currently sits in (reference 'guides').
 * guides = { x: [...X positions of vertical lines], y: [...Y positions of horizontal lines] }
 */
export function alignRect(rect, dest, guides, mode, reference = 'dest') {
	const gx = reference === 'guides' ? (guides?.x ?? []) : []
	const gy = reference === 'guides' ? (guides?.y ?? []) : []
	const xr = regionFor(rect.x + rect.w / 2, dest.w, gx)
	const yr = regionFor(rect.y + rect.h / 2, dest.h, gy)
	const next = { ...rect }

	if (mode === 'left') next.x = xr.start
	if (mode === 'right') next.x = xr.end - rect.w
	if (mode === 'top') next.y = yr.start
	if (mode === 'bottom') next.y = yr.end - rect.h
	if (mode === 'hcenter' || mode === 'center') next.x = (xr.start + xr.end) / 2 - rect.w / 2
	if (mode === 'vcenter' || mode === 'center') next.y = (yr.start + yr.end) / 2 - rect.h / 2

	return roundRect(next)
}

/**
 * fullH  : width = destination width, height follows the current aspect (if keepAspect), centered vertically
 * fullV  : height = destination height, width follows the current aspect (if keepAspect), centered horizontally
 * fillHV : exactly the whole destination (stretches)
 */
export function fillRect(rect, dest, mode, keepAspect = true) {
	const next = { ...rect }
	const aspect = rect.w > 0 && rect.h > 0 ? rect.w / rect.h : null

	if (mode === 'fillHV') {
		return roundRect({ x: 0, y: 0, w: dest.w, h: dest.h })
	}
	if (mode === 'fullH') {
		next.x = 0
		next.w = dest.w
		if (keepAspect && aspect) {
			next.h = dest.w / aspect
			next.y = (dest.h - next.h) / 2
		}
	}
	if (mode === 'fullV') {
		next.y = 0
		next.h = dest.h
		if (keepAspect && aspect) {
			next.w = dest.h * aspect
			next.x = (dest.w - next.w) / 2
		}
	}
	return roundRect(next)
}

export function roundRect(r) {
	return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }
}

/**
 * Reads a layer's mask. Documented reply: Mask = [{id, Top, Left, Right, Bottom}, {...}] ([pgm, pvw]).
 * Prefers the preview entry (index 1).
 */
export function maskOf(layer) {
	if (!layer) return null
	const m = layer.Mask
	let r
	if (Array.isArray(m)) r = m[0] ?? m[1]
	else if (m && typeof m === 'object') r = m
	if (!r) return null
	const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
	return { top: n(r.Top), left: n(r.Left), right: n(r.Right), bottom: n(r.Bottom) }
}

export const PARAMS = ['size', 'hpos', 'vpos', 'mask_left', 'mask_right', 'mask_top', 'mask_bottom']

/**
 * Applies one rotary step to a live state { rect, mask, aspect }. Mutates it.
 * Returns which part changed: 'window' | 'mask' | null.
 *  size  : uniform scale (width +delta px, height follows the aspect), anchored at the 'center' or the 'topleft'
 *  hpos / vpos : move by delta px
 *  mask_* : delta in mask units, never below 0
 */
export function applyDelta(state, param, delta, anchor = 'center') {
	const r = state.rect
	if (param === 'hpos') {
		r.x = Math.round(r.x + delta)
		return 'window'
	}
	if (param === 'vpos') {
		r.y = Math.round(r.y + delta)
		return 'window'
	}
	if (param === 'size') {
		const aspect = state.aspect > 0 ? state.aspect : r.h > 0 ? r.w / r.h : 1
		const w = Math.max(1, Math.round(r.w + delta))
		const h = Math.max(1, Math.round(w / aspect))
		if (anchor === 'center') {
			r.x = Math.round(r.x - (w - r.w) / 2)
			r.y = Math.round(r.y - (h - r.h) / 2)
		}
		r.w = w
		r.h = h
		return 'window'
	}
	const edge = { mask_left: 'left', mask_right: 'right', mask_top: 'top', mask_bottom: 'bottom' }[param]
	if (edge) {
		state.mask[edge] = Math.max(0, state.mask[edge] + delta)
		return 'mask'
	}
	return null
}
