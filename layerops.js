import { maskOf, rectOf } from './geometry.js'

const FORMATS = {
	window: ['object', 'array', 'flat'],
	mask: ['object', 'array'],
}

const close = (a, b) => Math.abs(a - b) <= 0.5

function sameValues(kind, now, target) {
	if (!now) return false
	if (kind === 'window') return close(now.x, target.x) && close(now.y, target.y) && close(now.w, target.w) && close(now.h, target.h)
	return close(now.top, target.top) && close(now.left, target.left) && close(now.right, target.right) && close(now.bottom, target.bottom)
}

/**
 * The reply format of listContent differs between firmware versions, and the documentation does not show how
 * Window / Mask must be WRITTEN. So the first write tries several formats and keeps the one that is confirmed
 * by reading the layer back. Once a format is known (`verify: false`) it is simply reused, one request per write.
 *
 * target: window -> { x, y, w, h }   mask -> { top, left, right, bottom }
 * pgm   : the current program entry (already in API shape), used by the "array" format
 */
export async function writeLayer({ client, destId, layerId, kind, target, pgm, extras, startFormat = 'object', verify = true }) {
	if (!verify) {
		await client.changeLayerGeometry(destId, layerId, kind, target, startFormat, pgm, extras)
		return { ok: true, format: startFormat }
	}
	const order = [startFormat, ...FORMATS[kind].filter((f) => f !== startFormat)]
	for (const format of order) {
		await client.changeLayerGeometry(destId, layerId, kind, target, format, pgm, extras)
		const content = await client.listContent(destId)
		const layers = Array.isArray(content) ? content : (content?.Layers ?? [])
		const layer = layers.find((l) => l?.id === layerId)
		const now = kind === 'window' ? rectOf(layer) : maskOf(layer)
		if (sameValues(kind, now, target)) return { ok: true, format }
	}
	return { ok: false, format: null }
}
