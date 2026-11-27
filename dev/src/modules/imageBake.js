// Bake an imageShader's fill into a real image, so a Lottie export can show it.
//
// Cavalry's Lottie writer drops an imageShader fill completely: the shape bakes
// as a flat `fl` of its material colour and the document gets no image asset at
// all. The shader's pixels do carry real alpha, so an image of them, laid over
// each copy, is what the comp actually looks like — and a transparent source
// stays transparent.
//
// The image cannot be the source file, and it cannot be rendered in a comp of
// its own. A shader's scale, offset and tiling resolve differently in a
// throwaway comp than in the comp it actually sits in — measured: the same
// asset on the same shape draws 2.8x larger in a fresh comp than inside the
// card. So the capture is taken IN CONTEXT: hide the background, zero the
// shape's material fill so only the shader's own pixels are left, render the
// comp at 1:1, and restore. The comp is periodic (a duplicator repeats one
// cell), so one lattice cell cropped out of that capture is exactly what a
// single copy draws.
//
// Everything the capture touches is restored, and every layer it creates is
// deleted.

import { cropPng, decodePng } from './png.js'
import { fromBase64, base64 } from './zip.js'

const SHAPE_TYPES = { basicShape: 1, editableShape: 1, polyShape: 1, textShape: 1 }

// Utility nodes carry no pixels of their own. Hiding one that feeds a duplicator
// (a subMesh, a valueBlend, a falloff) disables the duplicator entirely, so the
// capture comes back fully transparent — measured. They are never hidden.
const UTILITY_TYPES = {
	subMesh: 1, valueBlend: 1, value: 1, falloff: 1, rangeFalloff: 1, random: 1, noise: 1,
	oscillator: 1, visibilityCurve: 1, math: 1, frame: 1, step: 1, stagger: 1, javaScript: 1,
	autoAnimate: 1, animationCurve: 1, particleEmitter: 1, particleShape: 1, imageShader: 1,
	gradientShader: 1, colorArray: 1, valueArray: 1, shapeArray: 1, shaderArray: 1
}

// The imageShader filling a shape's colour slot, or null.
function imageShaderOf(shape) {
	let conns = []
	try { conns = api.getInConnectedAttributes(shape) || [] } catch (e) { return null }
	for (const attr of conns) {
		// The path is `material.colorShaders.0.shader`, so the shader segment is
		// never at position 0 — match it anywhere in the path.
		if (String(attr).indexOf('colorShaders') < 0) continue
		const src = String(api.getInConnection(shape, attr) || '').split('.')[0]
		if (!src) continue
		if (api.getLayerType(src) === 'imageShader') return { shader: src, slot: String(attr) }
	}
	return null
}

// Every shape with an imageShader fill in a comp, and the duplicator repeating
// it. Composition references are followed, because the artwork and its shader
// usually live in the referenced comp, not the shell the user exports.
// -> [{ shape, shader, slot, host, comp }]
export function findImageFillShapes(compId) {
	const out = []
	const seen = {}
	const walk = (ids, compId) => {
		for (const id of ids || []) {
			if (seen[id]) continue
			seen[id] = 1
			let type = ''
			try { type = api.getLayerType(id) } catch (e) { continue }
			if (type === 'compositionReference') {
				let inner = ''
				try { inner = String(api.getInConnection(id, 'composition') || '').replace(/\.id$/, '') } catch (e) { inner = '' }
				if (inner && !seen[inner]) {
					seen[inner] = 1
					try { walk(api.getChildren(inner), inner) } catch (e) {}
				}
				continue
			}
			if (SHAPE_TYPES[type]) {
				const hit = imageShaderOf(id)
				if (hit) {
					const host = duplicatorOf(id)
					if (host) out.push({ shape: id, shader: hit.shader, slot: hit.slot, host: host, comp: compId })
				}
			}
			if (type === 'group' || type === 'duplicator' || type === 'subMesh' || type === 'compNode' || type === 'compositionReference') {
				try { walk(api.getChildren(id), compId) } catch (e) {}
			}
		}
	}
	try { walk(api.getChildren(compId), compId) } catch (e) {}
	return out
}

// The duplicator repeating a shape: the nearest ancestor of that type.
function duplicatorOf(shapeId) {
	let id = shapeId
	for (let depth = 0; depth < 10; depth++) {
		let parent = null
		try { parent = api.getParent(id) } catch (e) { return null }
		if (!parent) return null
		let type = ''
		try { type = api.getLayerType(parent) } catch (e) { return null }
		if (type === 'duplicator') return parent
		id = parent
	}
	return null
}

// How many copies the duplicator makes, as {x, y}.
// A wrapped distribution stack (e.g. sortDistribution over gridDistribution)
// puts the grid count on `generator.input.count` rather than `generator.count`.
export function copyGridOf(host) {
	let count = null
	try { count = api.get(host, 'generator.count') } catch (e) {}
	if (!count || typeof count.x !== 'number') {
		try { count = api.get(host, 'generator.input.count') } catch (e) {}
	}
	if (!count || typeof count.x !== 'number') return null
	return { x: Math.max(1, Math.round(count.x)), y: Math.max(1, Math.round(count.y)) }
}

// The assetArray feeding an imageShader's `image` slot, or null when the shader
// points directly at a single asset.
// -> { node, entries: [{ index, assetId, path, name }] } | null
export function assetArrayOf(shader) {
	let src = ''
	try { src = String(api.getInConnection(shader, 'image') || '').split('.')[0] } catch (e) { return null }
	if (!src) return null
	let type = ''
	try { type = api.getLayerType(src) } catch (e) { return null }
	if (type !== 'assetArray') return null
	const entries = []
	for (let i = 0; i < 256; i++) {
		let conn = ''
		try { conn = String(api.getInConnection(src, 'array.' + i) || '') } catch (e) { break }
		if (!conn) break
		const assetId = conn.split('.')[0]
		let path = ''
		let name = ''
		try { path = api.getAssetFilePath(assetId) || '' } catch (e) {}
		try { name = api.getNiceName(assetId) || '' } catch (e) {}
		entries.push({ index: i, assetId: assetId, path: path, name: name })
	}
	if (!entries.length) return null
	return { node: src, entries: entries }
}

// Read a PNG file's width and height from its IHDR chunk without decoding pixels.
// -> { w, h } | null
export function pngDimensionsOf(file) {
	let b64 = ''
	try { b64 = api.encodeBinary(file) || '' } catch (e) { return null }
	if (b64.length < 32) return null
	const bytes = fromBase64(b64.slice(0, 32))
	if (!bytes || bytes.length < 24) return null
	if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null
	const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0
	const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0
	return w > 0 && h > 0 ? { w: w, h: h } : null
}

// Which 0-based index `shapeId` occupies in `host`'s `shapes` list, or -1.
export function hostShapeSlotOf(host, shapeId) {
	for (let i = 0; i < 64; i++) {
		let conn = ''
		try { conn = String(api.getInConnection(host, 'shapes.' + i) || '') } catch (e) { break }
		if (!conn) break
		if (conn.split('.')[0] === shapeId) return i
	}
	return -1
}

// Build a multi-image fill job for a shape whose imageShader is driven by an
// assetArray. Each entry in the array becomes its own Lottie image asset,
// assigned across copies in order (cycling modulo the array length) unless
// measured per-copy `arrayIndex` / `shapeId` data is supplied.
function bakeAssetArray(shapeInfo, arr, startIndex) {
	// A comp-local shader (no duplicator of its own) draws exactly one copy of its
	// artwork, so the array's first image is that copy's fill.
	const grid = (shapeInfo.host && copyGridOf(shapeInfo.host)) || { x: 1, y: 1 }
	if (!grid) {
		console.log('[image-fill] ' + shapeInfo.shape + ': could not read copy grid for assetArray; fill left flat')
		return { job: null, nextIndex: startIndex }
	}
	const assets = []
	let idx = startIndex
	for (const entry of arr.entries) {
		if (!entry.path || !api.filePathExists(entry.path)) continue
		const dim = pngDimensionsOf(entry.path)
		if (!dim) continue
		const extMatch = String(entry.path).match(/\.([a-z0-9]+)$/i)
		const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
		assets.push({
			assetId: 'img' + idx,
			assetW: dim.w,
			assetH: dim.h,
			assetP: 'img' + idx + '.' + ext,
			assetFile: entry.path
		})
		idx++
	}
	if (!assets.length) {
		console.log('[image-fill] ' + shapeInfo.shape + ': assetArray ' + arr.node + ' has no readable PNG entries; fill left flat')
		return { job: null, nextIndex: startIndex }
	}
	let reverse = false
	try { reverse = Boolean(api.get(arr.node, 'reverse')) } catch (e) {}
	return {
		job: {
			shape: shapeInfo.shape,
			host: shapeInfo.host,
			assetArrayNode: arr.node,
			assetArrayReverse: reverse,
			shapeSlot: hostShapeSlotOf(shapeInfo.host, shapeInfo.shape),
			assets: assets,
			copyCount: grid.x * grid.y,
			allowUnderCount: true,
			spansPitch: false
		},
		nextIndex: idx
	}
}

// Every layer on the path from a host up to the comp, plus the host's subtree:
// what has to stay visible for the shader fills to draw.
function keepFor(compId, hosts) {
	const keep = {}
	const add = (id) => { keep[id] = 1 }
	const subtree = (id) => {
		add(id)
		let kids = []
		try { kids = api.getChildren(id) || [] } catch (e) {}
		for (const k of kids) subtree(k)
	}
	for (const h of hosts) {
		subtree(h)
		let id = h
		for (let depth = 0; depth < 24; depth++) {
			let parent = null
			try { parent = api.getParent(id) } catch (e) { break }
			if (!parent || parent === compId) break
			add(parent)
			id = parent
		}
	}
	return keep
}

// Measure the copy lattice from a rendered capture, in pixels.
//
// This is the only trustworthy source of cell geometry: `getBoundingBox` on a
// duplicator depends on evaluation state (measured: the same duplicator reports
// 1985 / 4734 / 11428 px wide in three states on one comp), which inflated the
// cell by 5.7x. The capture already has the lattice drawn at true comp scale, so
// the pitch and origin are measured from the transparent gutters between copies:
// their centres are exactly one pitch apart, and the first gutter plus a pitch
// is the true cell origin.
//
// -> { pitchX, pitchY, cx, cy, width, height } in PNG pixels, or null.
export function latticeOf(file) {
	let img = null
	try {
		const b64 = api.encodeBinary(file)
		if (!b64) return null
		img = decodePng(fromBase64(b64))
	} catch (e) {
		return null
	}
	if (!img) return null
	const w = img.w
	const h = img.h
	const col = new Array(w).fill(0)
	const row = new Array(h).fill(0)
	let minX = w, maxX = -1, minY = h, maxY = -1
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (img.rgba[(y * w + x) * 4 + 3] <= 24) continue
			col[x]++
			row[y]++
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}
	if (maxX < 0 || maxY < 0) return null

	// Gutters: runs of empty columns/rows. Copies are separated by a clear strip,
	// so the gaps give both the pitch (spacing of the centres) and the phase.
	const gutters = (prof) => {
		const out = []
		let run = -1
		for (let i = 0; i < prof.length; i++) {
			if (prof[i] === 0) {
				if (run < 0) run = i
			} else if (run >= 0) {
				if (i - run >= 3) out.push([run, i - 1])
				run = -1
			}
		}
		if (run >= 0 && prof.length - run >= 3) out.push([run, prof.length - 1])
		return out
	}
	// Median spacing between consecutive gutter centres — robust to the odd
	// merged gutter where two copies touch. Frame-edge gutters (starting at 0
	// or ending at limit - 1) are margins rather than inter-copy gutters, so
	// they are excluded whenever at least two interior gutters exist; otherwise
	// wide side margins skew the pitch wider than the true cell (measured: a
	// 3-column grid with 177 px margins gave diffs [318.5, 266, 319] -> 319 px
	// instead of the true 266 px, offsetting the mango inside its crop).
	const pitchOf = (gaps, limit) => {
		const interior = gaps.filter((g) => g[0] > 0 && g[1] < limit - 1)
		const use = interior.length >= 2 ? interior : gaps
		const c = use.map((g) => (g[0] + g[1]) / 2)
		const d = []
		for (let i = 1; i < c.length; i++) {
			const v = c[i] - c[i - 1]
			if (v >= 20) d.push(v)
		}
		if (!d.length) return 0
		d.sort((a, b) => a - b)
		return Math.round(d[Math.floor(d.length / 2)])
	}
	const gx = gutters(col)
	const gy = gutters(row)
	const pitchX = pitchOf(gx, w)
	const pitchY = pitchOf(gy, h)
	// A cell spans one pitch from the MIDPOINT of one gutter to the midpoint of
	// the next — NOT from `gaps[i][1] + 1`. A gutter is the transparent strip
	// between two copies' artwork, which includes each copy's own padding inside
	// its cell; starting at `gaps[i][1] + 1` puts the artwork flush with the top-
	// left of the cropped PNG instead of centred in its cell (measured: shifted
	// every mango up-left by 16 px). Interior gutters (not clipped by the frame
	// edge) are tried first so an edge-truncated gutter cannot skew the midpoint.
	const pickWindow = (prof, gaps, p, limit) => {
		const edge = Math.max(2, Math.round(p * 0.08))
		let bestAt = -1
		let bestScore = -1e9
		const consider = (rawAt) => {
			const at = Math.round(rawAt)
			if (at < 0 || at + p > limit) return
			let inner = 0
			let rim = 0
			for (let k = 0; k < p; k++) {
				const v = prof[at + k]
				if (k < edge || k >= p - edge) rim += v
				else inner += v
			}
			if (inner <= 0) return
			const score = inner - 3 * rim
			if (score > bestScore) {
				bestScore = score
				bestAt = at
			}
		}
		for (let i = 0; i < gaps.length; i++) {
			if (gaps[i][0] > 0 && gaps[i][1] < limit - 1) {
				const mid = (gaps[i][0] + gaps[i][1]) / 2
				consider(mid)
				consider(mid - p)
			}
		}
		if (bestAt < 0) {
			for (let i = 0; i < gaps.length; i++) {
				const mid = (gaps[i][0] + gaps[i][1]) / 2
				consider(mid)
				consider(mid - p)
			}
		}
		if (bestAt < 0) consider(Math.max(0, Math.round((limit - p) / 2)))
		return bestAt
	}
	const bestX = pickWindow(col, gx, pitchX, w)
	const bestY = pickWindow(row, gy, pitchY, h)
	let x0 = bestX
	let y0 = bestY
	if (x0 < 0) x0 = Math.max(0, Math.round((minX + maxX - pitchX) / 2))
	if (y0 < 0) y0 = Math.max(0, Math.round((minY + maxY - pitchY) / 2))
	const cx = x0 + pitchX / 2
	const cy = y0 + pitchY / 2
	return {
		pitchX: pitchX,
		pitchY: pitchY,
		cx: cx,
		cy: cy,
		width: maxX - minX + 1,
		height: maxY - minY + 1
	}
}

// Capture the comp with only the imageShader fills drawn, at 1:1 comp pixels.
// -> { file, w, h, cells: [{ shape, host, box: {cx, cy, w, h} }] }
export function captureShaderOnly(compId, shapes, atFrame) {
	const restore = []
	const hidden = []
	let file = null
	const prevComp = (() => {
		try { return api.getActiveComp() } catch (e) { return null }
	})()
	const prevFrame = (() => {
		try { return api.getFrame() } catch (e) { return 0 }
	})()
	const prevBg = (() => {
		try { return api.get(compId, 'backgroundColor') } catch (e) { return null }
	})()
	try {
		// The vector fill under each shader is the shape's material colour. Zeroing
		// it leaves the shader's own pixels and its alpha; the writer exports the
		// fill as a normal `fl`, so this changes nothing in the export itself.
		for (const s of shapes) {
			let a = null
			try { a = api.get(s.shape, 'material.materialColor') } catch (e) {}
			if (!a) continue
			restore.push([s.shape, 'material.materialColor', a])
			try { api.set(s.shape, { 'material.materialColor.a': 0 }) } catch (e) {}
		}
		// Everything the shader fill does not depend on — text, the backdrop, other
		// artwork — would otherwise be baked into the cell image. Hide it, and put
		// every layer's own visibility back afterwards. The walk is over the WHOLE
		// tree, not the comp's direct children: the artwork that must go (the card
		// text, the Share reference) sits under the same top-level group the
		// duplicators do, so hiding only top-level children leaves it drawn.
		const hosts = shapes.map((x) => x.host || x.shape)
		const keep = keepFor(compId, hosts)
		const hideTree = (id) => {
			let type = ''
			try { type = api.getLayerType(id) } catch (e) { type = '' }
			// Utility nodes draw nothing, and hiding one that feeds a duplicator
			// switches the duplicator off — the capture then renders empty.
			if (UTILITY_TYPES[type]) return
			if (!keep[id]) {
				let was = null
				try { was = api.get(id, 'hidden') } catch (e) {}
				hidden.push([id, was === true])
				try { api.set(id, { hidden: true }) } catch (e) {}
				return
			}
			let kids = []
			try { kids = api.getChildren(id) || [] } catch (e) {}
			for (const k of kids) hideTree(k)
		}
		for (const id of api.getChildren(compId) || []) hideTree(id)
		// Any opaque backdrop would fill the transparency the cell needs.
		const res = (() => {
			try { return api.get(compId, 'resolution') } catch (e) { return null }
		})()
		try {
			api.set(compId, { backgroundColor: { r: 0, g: 0, b: 0, a: 0 } })
		} catch (e) {}

		const dir = api.getTempFolder() + '/lottie-tools-image-cell'
		if (!api.isDirectory(dir)) api.makeFolder(dir)
		file = dir + '/shader-' + new Date().getTime() + '.png'

		// setActiveComp restores the target comp's OWN playhead, discarding any
		// frame set before the switch — measured: the comp rendered at frame 258
		// after `setFrame(0)` then `setActiveComp`. So the frame is set AFTER the
		// switch, from the caller's request.
		api.setActiveComp(compId)
		const frame = typeof atFrame === 'number' ? atFrame : api.getFrame()
		try { api.setFrame(frame) } catch (e) {}
		// renderPNGFrame can return before the comp is redrawn (measured), so the
		// second render to the same path is what leaves the settled image on disk.
		api.renderPNGFrame(file, 100)
		api.renderPNGFrame(file, 100)
		if (!api.filePathExists(file)) throw new Error('the shader capture wrote no file')

		const w = res ? Math.round(res.x) : 0
		const h = res ? Math.round(res.y) : 0
		// Measure each lattice from the capture's own pixels. getBoundingBox on a
		// duplicator is context-dependent — measured on this comp it reports
		// 1985 / 4734 / 11428 px wide in three different evaluation states, so a
		// geometry read gives a cell 5.7x too large. The capture is the one place
		// the lattice is already drawn at true comp scale.
		const lat = latticeOf(file)
		const cells = shapes.map(function (s) {
			const grid = copyGridOf(s.host)
			if (!grid) return null
			if (!lat) return null
			const cellW = grid.x > 1 ? lat.pitchX : lat.width
			const cellH = grid.y > 1 ? lat.pitchY : lat.height
			if (!(cellW > 1) || !(cellH > 1)) return null
			return {
				shape: s.shape,
				host: s.host,
				box: { cx: lat.cx, cy: lat.cy, w: cellW, h: cellH }
			}
		}).filter(Boolean)
		return { file: file, w: w, h: h, cells: cells, frame: frame, lattice: lat }
	} finally {
		for (const r of restore) {
			try { api.set(r[0], { 'material.materialColor.a': r[2].a == null ? 255 : r[2].a }) } catch (e) {}
		}
		for (const h of hidden) {
			try { api.set(h[0], { hidden: h[1] }) } catch (e) {}
		}
		if (prevBg) {
			try { api.set(compId, { backgroundColor: prevBg }) } catch (e) {}
		}
		if (prevComp) {
			try { if (api.layerExists(prevComp)) api.setActiveComp(prevComp) } catch (e) {}
		}
		try { api.setFrame(prevFrame) } catch (e) {}
	}
}

// Crop one lattice cell out of the capture.
//
// The comp is periodic, so any window one pitch wide, centred on the lattice,
// is the same picture as any copy draws. The crop runs in plain JS: the capture
// is read back with `api.encodeBinary`, cut with `cropPng`, and written back
// with `api.writeEncodedToBinaryFile`. A shell tool would be simpler but
// `api.runProcess` does not exist in the script context this runs in, and
// Cavalry has no image-crop call of its own.
function cropCell(capture, box) {
	const out = String(capture.file).replace(/\.png$/i, '') + '-cell-' + Math.round(box.w) + 'x' + Math.round(box.h) + '.png'
	const x = Math.max(0, Math.round(box.cx - box.w / 2))
	const y = Math.max(0, Math.round(box.cy - box.h / 2))
	const w = Math.max(1, Math.round(box.w))
	const h = Math.max(1, Math.round(box.h))
	let bytes = null
	try {
		const b64 = api.encodeBinary(capture.file)
		if (!b64) return null
		bytes = fromBase64(b64)
	} catch (e) {
		return null
	}
	const cell = cropPng(bytes, x, y, w, h)
	if (!cell) return null
	try {
		if (!api.writeEncodedToBinaryFile(out, base64(cell.bytes))) return null
	} catch (e) {
		return null
	}
	return api.filePathExists(out) ? out : null
}

// Key describing an imageShader's visual output for reuse across duplicators
// that share the exact same source asset and shader transform settings.
// Returns null if any attribute cannot be read so we fall back to capturing.
function shaderSignature(s) {
	try {
		const img = String(api.getInConnection(s.shader, 'image') || '').split('.')[0]
		if (!img) return null
		const scaleMode = api.get(s.shader, 'scaleMode')
		const scale = api.get(s.shader, 'scale')
		const offset = api.get(s.shader, 'offset')
		const dims = api.get(s.shape, 'generator.dimensions')
		const round = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : '')
		return [
			s.comp,
			img,
			scaleMode,
			scale ? round(scale.x) + ',' + round(scale.y) : '',
			offset ? round(offset.x) + ',' + round(offset.y) : '',
			dims ? round(dims.x) + ',' + round(dims.y) : ''
		].join('|')
	} catch (e) {
		return null
	}
}

// All shapes with an imageShader fill in THIS comp, regardless of what repeats
// them.
//
// A comp that a duplicator instances through a composition reference is drawn as
// ONE card inside its own comp and repeated by the duplicator, so nothing inside
// that comp is "under a duplicator" and the parent-chain rule finds nothing. What
// the comp needs is one image of the shader in the card's own coordinates; every
// instance then shows it.
//
// Composition references are NOT followed: each referenced comp is exported as
// its own asset, and its layers only exist in that asset, so a capture taken here
// would have nowhere to land. -> [{ shape, shader, slot, comp }]
export function findShaderFillShapes(compId) {
	const out = []
	const seen = {}
	const walk = (ids, comp) => {
		for (const id of ids || []) {
			if (seen[id]) continue
			seen[id] = 1
			let type = ''
			try { type = api.getLayerType(id) } catch (e) { continue }
			if (SHAPE_TYPES[type]) {
				const hit = imageShaderOf(id)
				// A shape repeated by a duplicator in the SAME comp is handled by the
				// per-copy path (findImageFillShapes), which bakes its lattice. Only
				// shapes with no duplicator above them need an image of their own.
				if (hit && !duplicatorOf(id)) out.push({ shape: id, shader: hit.shader, slot: hit.slot, comp: comp })
			}
			if (type === 'group' || type === 'duplicator' || type === 'subMesh' || type === 'compNode') {
				try { walk(api.getChildren(id), comp) } catch (e) {}
			}
		}
	}
	try { walk(api.getChildren(compId), compId) } catch (e) {}
	return out
}

// The opaque bounds of a rendered PNG in pixels, or null when nothing drew.
function opaqueBounds(file) {
	let img = null
	try {
		const b64 = api.encodeBinary(file)
		if (!b64) return null
		img = decodePng(fromBase64(b64))
	} catch (e) { return null }
	if (!img) return null
	let minX = img.w, maxX = -1, minY = img.h, maxY = -1
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			if (img.rgba[(y * img.w + x) * 4 + 3] <= 24) continue
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}
	if (maxX < 0 || maxY < 0) return null
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

// Bake one image per imageShader fill of a comp, positioned in that comp's own
// space. The result is placed by imageFills.placeCompImages as a normal Lottie
// image layer, so a comp the exporter turns into a precomp asset carries its
// shader pixels inside the asset and every instance of it shows them.
//
// -> [{ shape, assetId, assetW, assetH, assetP, assetFile, assetB64, px, py }]
//    `px`/`py` are the crop's centre in Lottie coordinates (y down, comp top-left).
export function bakeCompImageFills(compId, shift) {
	shift = shift || 0
	const shapes = findShaderFillShapes(compId)
	const out = []
	if (!shapes.length) return out
	const here = (() => { try { return api.getFrame() } catch (e) { return 0 } })()
	let i = 0
	shapes.forEach(function (s) {
		const arr = assetArrayOf(s.shader)
		if (arr) {
			const job = bakeAssetArray(s, arr, i)
			if (job.job) {
				job.job.absolute = true
				out.push(job.job)
			}
			i = job.nextIndex
			return
		}
		// The shape may be scaled to nothing at the playhead the export starts on,
		// so try the current frame, then the earliest frames of the comp.
		let capture = null
		const tryFrames = [here, 180 - shift, 150 - shift, 120 - shift, 60 - shift, 0 - shift]
		const tried = {}
		for (const f of tryFrames) {
			if (tried[f]) continue
			tried[f] = 1
			try { api.setFrame(f) } catch (e) {}
			let got = null
			try {
				got = captureShaderOnly(s.comp, [{ shape: s.shape, host: null, shader: s.shader }], f)
			} catch (e) {
				console.log('[image-fill] could not capture ' + s.shape + ' at ' + f + ': ' + (e && e.message))
				continue
			}
			if (got && got.file) {
				const box = opaqueBounds(got.file)
				if (box) {
					capture = { file: got.file, box: box }
					break
				}
			}
		}
		try { api.setFrame(here) } catch (e) {}
		if (!capture) {
			console.log('[image-fill] ' + s.shape + ': no frame draws its shader; fill left flat')
			return
		}
		const file = cropCell({ file: capture.file }, {
			cx: capture.box.x + capture.box.w / 2,
			cy: capture.box.y + capture.box.h / 2,
			w: capture.box.w,
			h: capture.box.h
		})
		if (!file) {
			console.log('[image-fill] ' + s.shape + ': could not crop the shader; fill left flat')
			return
		}
		let b64 = ''
		try { b64 = api.encodeBinary(file) } catch (e) { b64 = '' }
		if (!b64) {
			console.log('[image-fill] ' + s.shape + ': the cropped shader could not be read back')
			return
		}
		const w = Math.max(1, Math.round(capture.box.w))
		const h = Math.max(1, Math.round(capture.box.h))
		// The capture is a comp render, so its pixel rows already run top-down like
		// Lottie's y axis: the crop's centre needs no flip. (Measured on the grey
		// card: Cavalry y -5.79 in a 456-high comp exports as ks.p.y 233.8, which is
		// exactly its pixel row.)
		let color = null
		try {
			const mc = api.get(s.shape, 'material.materialColor')
			if (mc) color = [mc.r / 255, mc.g / 255, mc.b / 255]
		} catch (e) { color = null }
		out.push({
			shape: s.shape,
			assetId: 'imgc' + i,
			assetW: w,
			assetH: h,
			assetP: 'imgc' + i + '.png',
			assetFile: file,
			assetB64: b64,
			absolute: true,
			px: capture.box.x + capture.box.w / 2,
			py: capture.box.y + capture.box.h / 2,
			color: color,
			copyCount: 1
		})
		i++
	})
	return out
}

// Bake every imageShader fill reachable from a comp.
//
// -> [{ shape, assetId, assetW, assetH, assetP, assetFile, assetB64, copyCount, cellW }]
//    `assetFile` is the cropped cell PNG in the temp folder; the caller copies
//    it next to the export so the image packer finds it, the way it finds any
//    other image a comp references.
export function bakeImageFills(compId, shift) {
	shift = shift || 0
	const shapes = findImageFillShapes(compId)
	const out = []
	if (!shapes.length) return out
	// One capture PER SHAPE, not per comp. Two duplicators in one comp draw two
	// different lattices into the same image, so a coverage profile measured from
	// a shared capture mixes both pitches and the crop lands between copies
	// (measured: a cell cropped across two half-mangoes). Capturing one shape at
	// a time keeps exactly one lattice on screen. When two shapes in the same
	// comp use the exact same source image, shader settings and shape dimensions,
	// reuse the first baked cell image instead of capturing and writing a second.
	let i = 0
	const bySig = {}
	shapes.forEach(function (s) {
		const arr = assetArrayOf(s.shader)
		if (arr) {
			const res = bakeAssetArray(s, arr, i)
			if (res.job) out.push(res.job)
			i = res.nextIndex
			return
		}
		const sig = shaderSignature(s)
		if (sig && bySig[sig]) {
			const prev = bySig[sig]
			const grid = copyGridOf(s.host)
			const copyCount = grid ? grid.x * grid.y : 1
			out.push({
				shape: s.shape,
				assetId: prev.assetId,
				assetW: prev.assetW,
				assetH: prev.assetH,
				assetP: prev.assetP,
				assetFile: prev.assetFile,
				assetB64: prev.assetB64,
				copyCount: copyCount,
				cellW: prev.cellW,
				spansPitch: !!(grid && (grid.x > 1 || grid.y > 1))
			})
			return
		}
		// The rig can hide a duplicator's copies completely at the playhead the
		// export starts on (measured: an 18-copy grid is culled from frame 120 to
		// the end). A cell can only be cropped from a frame where copies DRAW, so
		// try the current frame, then the earliest frames of the comp.
		let capture = null
		const tryFrames = []
		const here = (() => { try { return api.getFrame() } catch (e) { return 0 } })()
		// `here` is already a read frame; 180/150/120/60/0 are authored labels, so
		// they are converted to reads with the comp's time-base shift. Settled
		// mid-early frames come before 120/60/0 because a spring-scaled grid can
		// still be at 0 or mid-overshoot in the earliest frames.
		tryFrames.push(here, 180 - shift, 150 - shift, 120 - shift, 60 - shift, 0 - shift)
		const seen = {}
		for (const f of tryFrames) {
			if (seen[f]) continue
			seen[f] = 1
			try { api.setFrame(f) } catch (e) {}
			let got = null
			try {
				got = captureShaderOnly(s.comp, [s], f)
			} catch (e) {
				console.log('[image-fill] could not capture ' + s.shape + ' at ' + f + ': ' + (e && e.message))
				continue
			}
			// cells only exist when the lattice was found, i.e. copies were drawn
			if (got && got.cells.length) {
				capture = got
				break
			}
		}
		try { api.setFrame(here) } catch (e) {}
		if (!capture) {
			console.log('[image-fill] ' + s.shape + ': no frame in this comp draws its copies; fill left flat')
			return
		}
		const before = out.length
		i = bakeCells(capture, out, i)
		if (sig && out.length > before) bySig[sig] = out[before]
	})
	return out
}

function bakeCells(capture, out, i) {
	capture.cells.forEach(function (cell) {
		const grid = copyGridOf(cell.host)
		const copyCount = grid ? grid.x * grid.y : 1
		const file = cropCell(capture, cell.box)
		if (!file) {
			console.log('[image-fill] ' + cell.shape + ': could not crop the cell; image left flat')
			return
		}
		let b64 = ''
		try { b64 = api.encodeBinary(file) } catch (e) { b64 = '' }
		if (!b64) {
			console.log('[image-fill] ' + cell.shape + ': the cropped cell could not be read back')
			return
		}
		const w = Math.max(1, Math.round(cell.box.w))
		const h = Math.max(1, Math.round(cell.box.h))
		out.push({
			shape: cell.shape,
			assetId: 'img' + i,
			assetW: w,
			assetH: h,
			assetP: 'img' + i + '.png',
			assetFile: file,
			assetB64: b64,
			copyCount: copyCount,
			cellW: w,
			spansPitch: !!(grid && (grid.x > 1 || grid.y > 1))
		})
		i++
	})
	return i
}
