// Export a comp with its comp references as real Lottie precomps.
//
// Cavalry's Lottie writer inlines every composition reference as one shape layer, and in
// doing so loses nested references' timing (they export as a frozen frame) and writes
// every copy out in full. Here each referenced comp is exported on its own (single-level
// exports are fine), added once as a precomp asset, and every inlined reference is
// swapped for a precomp layer (ty 0) timed from the scene: start = the reference's
// timeOffset, time remap from its timeRemapping (% of the comp's length).
//
// Also checks every layer against the scene: the writer gets positions wrong around pivots
// (text, flames, sprigs), so anchors come from the scene and positions are corrected to put
// each anchor where Cavalry draws the pivot (see repairPositions).

import { exportComp, compLayers } from './cavalryExport.js'

const isAnimated = (p) => p && Array.isArray(p.k) && p.k.length && typeof p.k[0] === 'object' && 't' in p.k[0]

// mn is the scene id with the layer's ind appended for inlined references
// (compositionReference#88 + 2 -> "compositionReference#882"); match the longest prefix.
function sceneId(mn, ids) {
	if (!mn) return null
	if (ids.has(mn)) return mn
	for (let s = mn.slice(0, -1); /#\d+$/.test(s); s = s.slice(0, -1)) if (ids.has(s)) return s
	return null
}

const compOf = (ref) => String(api.getInConnection(ref, 'composition') || '').replace(/\.id$/, '')

function compSize(comp) {
	const r = api.get(comp, 'resolution')
	return [r.x, r.y]
}

// Add (dx, dy) to a 2D/3D value or to every key of an animated one.
function shift(prop, dx, dy) {
	const add = (v) => {
		const out = (Array.isArray(v) ? v : [v]).slice()
		out[0] = (out[0] || 0) + dx
		out[1] = (out[1] || 0) + dy
		return out
	}
	if (!prop) return { a: 0, k: [dx, dy, 0] }
	if (!isAnimated(prop)) return Object.assign({}, prop, { k: add(prop.k) })
	return Object.assign({}, prop, {
		k: prop.k.map((kf) => Object.assign({}, kf, kf.s ? { s: add(kf.s) } : {}, kf.e ? { e: add(kf.e) } : {})),
	})
}

// Position may be split into x/y.
function shiftPosition(p, dx, dy) {
	if (p && p.s) {
		const one = (q, d) => (isAnimated(q) ? Object.assign({}, q, { k: q.k.map((kf) => Object.assign({}, kf, { s: [kf.s[0] + d] })) }) : Object.assign({}, q, { k: (Array.isArray(q.k) ? q.k[0] : q.k) + d }))
		return Object.assign({}, p, { x: one(p.x, dx), y: one(p.y, dy) })
	}
	return shift(p, dx, dy)
}

// Shift every vertex of the masks (mask paths are in the layer's own space).
function shiftMasks(masks, dx, dy) {
	const sh = (s) => Object.assign({}, s, { v: s.v.map((p) => [p[0] + dx, p[1] + dy]) })
	return masks.map((m) => {
		const pt = m.pt
		if (!pt) return m
		const k = isAnimated(pt) ? pt.k.map((kf) => Object.assign({}, kf, { s: kf.s.map(sh) })) : sh(pt.k)
		return Object.assign({}, m, { pt: Object.assign({}, pt, { k }) })
	})
}

// Cavalry keyframe handles (relative frames/values) -> Lottie o/i on the segment from a to b.
function easeBetween(a, b) {
	const da = api.get(a, 'data'),
		db = api.get(b, 'data')
	const ta = api.get(a, 'frame'),
		tb = api.get(b, 'frame')
	if (da.interpolation === 2) return { h: 1 }
	if (da.interpolation === 1 || !da.rightBez || !db.leftBez) return { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
	const dt = tb - ta || 1,
		dv = db.numValue - da.numValue
	const ny = (v, fb) => (Math.abs(dv) < 1e-9 ? fb : v / dv)
	return {
		o: { x: [da.rightBez.x / dt], y: [ny(da.rightBez.y, da.rightBez.x / dt)] },
		i: { x: [1 + db.leftBez.x / dt], y: [1 + ny(db.leftBez.y, db.leftBez.x / dt)] },
	}
}

// timeRemapping is % of the referenced comp's length (100% = its end frame); Lottie tm is seconds.
// Its keys are in the parent's time, like every other layer key in Lottie.
function timeRemap(ref, comp, fps) {
	if ((api.getAnimatedAttributes(ref) || []).indexOf('timeRemapping') < 0) {
		const v = api.get(ref, 'timeRemapping')
		return v ? { a: 0, k: toSeconds(v) } : null
	}
	const ids = api.getKeyframeIdsForAttribute(ref, 'timeRemapping')
	const keys = ids.map((id, j) => {
		const kf = { t: api.get(id, 'frame'), s: [toSeconds(api.get(id, 'data').numValue)] }
		if (j < ids.length - 1) Object.assign(kf, easeBetween(id, ids[j + 1]))
		return kf
	})
	return keys.length === 1 ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys }
	function toSeconds(pct) {
		const start = api.get(comp, 'startFrame'),
			end = api.get(comp, 'endFrame')
		return (start + (pct / 100) * (end - start)) / fps
	}
}

// Value of a Lottie property at time t (bezier eases solved per component).
export function valueAt(prop, t) {
	if (!prop) return null
	if (!isAnimated(prop)) return Array.isArray(prop.k) ? prop.k : [prop.k]
	const k = prop.k
	if (t <= k[0].t) return k[0].s
	for (let j = 0; j < k.length - 1; j++) {
		const a = k[j],
			b = k[j + 1]
		if (t >= b.t) continue
		if (a.h === 1 || !b.s) return a.s
		const u = (t - a.t) / (b.t - a.t)
		return a.s.map((v, d) => {
			const c = (q, f) => (q == null ? f : Array.isArray(q) ? (q[d] != null ? q[d] : q[0]) : q)
			const ox = c(a.o && a.o.x, 0), oy = c(a.o && a.o.y, 0), ix = c(a.i && a.i.x, 1), iy = c(a.i && a.i.y, 1)
			return v + (b.s[d] - v) * ease(ox, oy, ix, iy, u)
		})
	}
	return k[k.length - 1].s
}

function ease(ox, oy, ix, iy, x) {
	const bz = (p1, p2, t) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
	let lo = 0, hi = 1, t = x
	for (let i = 0; i < 30; i++) {
		t = (lo + hi) / 2
		if (bz(ox, ix, t) < x) lo = t
		else hi = t
	}
	return bz(oy, iy, t)
}

// A layer's own transform at t as an affine map: p + R·S·(x − a).
function layerMatrix(ks, t) {
	const p = ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0]
	const a = valueAt(ks.a, t) || [0, 0],
		s = valueAt(ks.s, t) || [100, 100],
		r = (((valueAt(ks.r, t) || [0])[0] || 0) * Math.PI) / 180
	const c = Math.cos(r), sn = Math.sin(r), sx = s[0] / 100, sy = s[1] / 100
	// [m00 m01 m10 m11 tx ty]
	const m = [c * sx, -sn * sy, sn * sx, c * sy]
	return [m[0], m[1], m[2], m[3], p[0] - (m[0] * a[0] + m[1] * a[1]), p[1] - (m[2] * a[0] + m[3] * a[1])]
}
const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[0] * B[4] + A[1] * B[5] + A[4], A[2] * B[4] + A[3] * B[5] + A[5]]
function invertApply(M, [x, y]) {
	const det = M[0] * M[3] - M[1] * M[2]
	if (Math.abs(det) < 1e-9) return null // a parent scaled to zero: no position is visible
	const dx = x - M[4], dy = y - M[5]
	return [(M[3] * dx - M[1] * dy) / det, (-M[2] * dx + M[0] * dy) / det]
}
const positionAt = (ks, t) => (ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0])

// Cavalry's writer gets positions wrong around pivots in more than one way (shifted by
// R·S·pivot at whatever frame the comp last showed; not shifted, with the anchor's x sign
// flipped, when the transform is connected). Rather than model each, take every anchor
// from the scene's pivot and move each position until the anchor lands where Cavalry draws
// the pivot, parents first.
//   anchorFor(L) -> [x, y] | null      scene pivot in the layer's Lottie space
//   pivotAt(L)   -> {frame: [x, y]} | null   scene world pivot in Lottie comp space
// Returns the layers whose needed correction changes over time (bake those).
export function repairPositions(layers, frames, anchorFor, pivotAt) {
	const byInd = new Map(layers.map((L) => [L.ind, L]))
	const done = new Set()
	const varying = []
	let fixed = 0
	const parentMatrix = (L, t) => {
		let M = [1, 0, 0, 1, 0, 0]
		for (let q = byInd.get(L.parent); q; q = byInd.get(q.parent)) M = mul(layerMatrix(q.ks, t), M)
		return M
	}
	const visit = (L) => {
		if (done.has(L)) return
		done.add(L)
		const up = byInd.get(L.parent)
		if (up) visit(up)
		if (!L.ks) return
		const a = anchorFor(L)
		if (a && !isAnimated(L.ks.a)) {
			const old = valueAt(L.ks.a, 0) || [0, 0, 0]
			L.ks.a = Object.assign({}, L.ks.a || { a: 0 }, { k: [a[0], a[1], old[2] || 0] })
		}
		const world = pivotAt(L)
		if (!world) return
		const deltas = frames
			.filter((t) => world[t])
			.map((t) => {
				const local = invertApply(parentMatrix(L, t), world[t])
				const p = positionAt(L.ks, t)
				return local && [local[0] - p[0], local[1] - p[1]]
			})
			.filter(Boolean)
		if (!deltas.length) return
		if (deltas.some((d) => Math.hypot(d[0] - deltas[0][0], d[1] - deltas[0][1]) > 0.25)) return varying.push(L)
		if (Math.hypot(deltas[0][0], deltas[0][1]) < 0.01) return
		L.ks.p = shiftPosition(L.ks.p, deltas[0][0], deltas[0][1])
		fixed++
	}
	layers.forEach(visit)
	return { fixed, varying, parentMatrix }
}

// Position keys, one per frame, that put the anchor on the sampled world pivot.
export function bakePosition(L, world, parentMatrix) {
	const xs = [], ys = []
	Object.keys(world)
		.map(Number)
		.sort((a, b) => a - b)
		.forEach((t) => {
			const local = invertApply(parentMatrix(L, t), world[t])
			if (!local) return
			const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
			xs.push(Object.assign({ t, s: [local[0]] }, lin))
			ys.push(Object.assign({ t, s: [local[1]] }, lin))
		})
	L.ks.p = { s: true, x: { a: 1, k: xs }, y: { a: 1, k: ys } }
}

// ---------- masks ----------
// Cavalry's writer drops clipping masks on groups (and their mask shapes). A Lottie mask on a
// parent layer wouldn't clip its children anyway (parenting only passes the transform), so
// each mask is rebuilt on every drawing layer under the masked one, in that layer's space.

// Cavalry mask mode (0 union, 1 subtract, 2 intersect = clip) -> Lottie mode for mask i.
const maskMode = (mode, i) => (mode === 1 ? 's' : i === 0 || mode === 0 ? 'a' : 'i')

// One Lottie shape from a contour of world points: {v, i, o, c} in the layer's space.
function localShape(contour, M) {
	const v = [], ii = [], oo = []
	for (const p of contour.points) {
		const q = invertApply(M, p.position)
		if (!q) return null
		const a = invertApply(M, p.inHandle), b = invertApply(M, p.outHandle)
		v.push(q)
		ii.push([a[0] - q[0], a[1] - q[1]])
		oo.push([b[0] - q[0], b[1] - q[1]])
	}
	return { i: ii, o: oo, v, c: !!contour.isClosed }
}

const sameShape = (a, b) =>
	a.v.length === b.v.length && ['v', 'i', 'o'].every((f) => a[f].every((p, k) => Math.abs(p[0] - b[f][k][0]) < 0.01 && Math.abs(p[1] - b[f][k][1]) < 0.01))

// masks: [{mode, paths: {frame: [contours in Lottie comp space]}}] for one masked layer;
// targets: the drawing layers it must clip. Appends Lottie masks to each target.
export function applyMasks(masks, targets, parentMatrix) {
	let n = 0
	for (const L of targets) {
		const M = (t) => mul(parentMatrix(L, t), layerMatrix(L.ks, t))
		const out = L.masksProperties ? L.masksProperties.slice() : []
		masks.forEach((m) => {
			const frames = Object.keys(m.paths).map(Number).sort((a, b) => a - b)
			const contours = m.paths[frames[0]].length
			for (let c = 0; c < contours; c++) {
				const keys = []
				for (const t of frames) {
					const sh = m.paths[t][c] && localShape(m.paths[t][c], M(t))
					if (sh) keys.push({ t, s: [sh] })
				}
				if (!keys.length) continue
				const still = keys.every((k) => sameShape(k.s[0], keys[0].s[0]))
				const pt = still ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys.map((k, j) => (j < keys.length - 1 ? Object.assign(k, { o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }) : k)) }
				out.push({ inv: false, mode: maskMode(m.mode, out.length), pt, o: { a: 0, k: 100 }, x: { a: 0, k: 0 }, nm: 'Mask' })
				n++
			}
		})
		if (out.length) {
			L.masksProperties = out
			L.hasMask = true
		}
	}
	return n
}

// World pivot of scene layers at `frames`, in Lottie comp space (top-left, y down).
// Opens the comp to evaluate it; the caller puts the user's comp and frame back.
function samplePivots(comp, ids, frames, maskIds) {
	const [w, h] = compSize(comp)
	const toLottie = (p) => [p.x + w / 2, h / 2 - p.y]
	api.setActiveComp(comp)
	if (api.getActiveComp() !== comp) throw new Error('Could not open ' + api.getNiceName(comp) + ' to check its layers')
	const out = {}
	for (const f of frames) {
		api.setFrame(f)
		for (const id of ids) {
			try {
				;(out[id] = out[id] || {})[f] = toLottie(api.getPivotPosition(id, true))
			} catch (e) {}
		}
		for (const id of maskIds || []) {
			try {
				const contours = api.getEditablePath(id, true).map((c) => ({
					isClosed: c.isClosed,
					// points without handles carry no inHandle/outHandle
					points: c.points.map((p) => ({ position: toLottie(p.position), inHandle: toLottie(p.inHandle || p.position), outHandle: toLottie(p.outHandle || p.position) })),
				}))
				;(out[id] = out[id] || {})[f] = contours
			} catch (e) {}
		}
	}
	return out
}

// Clipping masks on a scene layer: [{id, mode}] (enabled ones only).
function sceneMasks(id) {
	return api
		.getInConnectedAttributes(id)
		.filter((a) => /^masks\.\d+\.id$/.test(a))
		.map((a) => {
			const i = a.split('.')[1]
			let on = true
			try {
				on = api.get(id, 'masks.' + i + '.enabled') !== false
			} catch (e) {}
			return on && { id: String(api.getInConnection(id, a)).replace(/\.id$/, ''), mode: api.get(id, 'masks.' + i + '.mode') }
		})
		.filter(Boolean)
}

// Cavalry writes some static values as an animated property with one key, which stops
// lottie-web drawing the layer at all; store those as static.
export function staticSingleKeys(node) {
	let n = 0
	const walk = (o) => {
		if (Array.isArray(o)) return o.forEach(walk)
		if (!o || typeof o !== 'object') return
		if (o.a === 1 && Array.isArray(o.k) && o.k.length === 1 && o.k[0] && o.k[0].s !== undefined) {
			const v = o.k[0].s
			o.a = 0
			o.k = Array.isArray(v) && v.length === 1 ? v[0] : v // [50] -> 50, [path] -> path
			n++
			return
		}
		for (const k in o) walk(o[k])
	}
	walk(node)
	return n
}

// Guide layers (and everything under them) aren't rendered by Cavalry, but its writer exports them.
function isGuide(id) {
	for (let q = id; q; q = api.getParent(q)) {
		try {
			if (api.get(q, 'guideLayer')) return true
		} catch (e) {}
	}
	return false
}

function dropGuides(layers, sceneOf) {
	const gone = new Set(layers.filter((L) => sceneOf.get(L) && isGuide(sceneOf.get(L))).map((L) => L.ind))
	let grew = true
	while (grew) {
		grew = false
		for (const L of layers) if (!gone.has(L.ind) && gone.has(L.parent)) (gone.add(L.ind), (grew = true))
	}
	return layers.filter((L) => !gone.has(L.ind))
}

// -> { json, dirs, warnings, precomps, refs, pivots (positions corrected), baked (positions baked) }
export function exportWithPrecomps(compId, opts = {}) {
	const warnings = []
	const assets = []
	const dirs = [] // each comp's export folder, for its images/
	const cache = {}
	let pivots = 0,
		baked = 0,
		maskCount = 0,
		refs = 0,
		next = 0
	const userComp = api.getActiveComp(),
		userFrame = api.getFrame()

	function build(comp) {
		const out = exportComp(comp, opts)
		dirs.push(out.dir)
		const exported = out.json
		const ids = new Set(compLayers(comp))
		const fps = exported.fr
		const sceneOf = new Map()
		exported.layers = exported.layers.map((L) => {
			const id = sceneId(L.mn, ids)
			if (!id) return L
			sceneOf.set(L, id)
			if (api.getLayerType(id) !== 'compositionReference') return L
			const inner = compOf(id)
			if (!inner) return L
			refs++
			if (!cache[inner]) {
				const assetId = 'comp_' + next++
				cache[inner] = assetId // set before recursing, so a cycle ends here
				const built = build(inner)
				assets.push({ id: assetId, nm: api.getNiceName(inner), fr: built.fr, layers: built.layers })
				// ponytail: image assets from different comps that share an id or file name clash; prefix them per comp if that turns up
				for (const a of built.assets || []) if (!assets.some((b) => b.id === a.id)) assets.push(a)
			}
			const [w, h] = compSize(inner)
			const out = {}
			for (const k in L) if (k !== 'shapes' && k !== 'ty') out[k] = L[k]
			out.ty = 0
			out.refId = cache[inner]
			out.w = w
			out.h = h
			// the inlined shapes sat around the comp's centre; precomp space starts top-left
			out.ks = Object.assign({}, L.ks, { a: shift(L.ks && L.ks.a, w / 2, h / 2) })
			if (L.masksProperties) out.masksProperties = shiftMasks(L.masksProperties, w / 2, h / 2)
			out.st = api.get(id, 'timeOffset') || 0
			out.sr = 1
			const tm = timeRemap(id, inner, fps)
			if (tm) out.tm = tm
			sceneOf.set(out, id)
			return out
		})
		// Cavalry's end frame is inclusive, Lottie's op exclusive: layers that run to the comp's
		// last frame would vanish on it (a one-frame flash each time a precomp loops)
		const last = api.get(comp, 'endFrame')
		for (const L of exported.layers) if (L.op === last) L.op = last + 1
		exported.layers = dropGuides(exported.layers, sceneOf)
		staticSingleKeys(exported.layers)
		repair(comp, exported, sceneOf)
		return exported
	}

	// Check every layer's anchor against the scene and correct or bake its position.
	function repair(comp, exported, sceneOf) {
		const start = api.get(comp, 'startFrame'),
			end = api.get(comp, 'endFrame')
		const frames = [start, Math.round((start + end) / 2), end]
		const time = api.get(comp, 'time') || 0
		const ids = [...new Set(sceneOf.values())]
		const world = samplePivots(comp, ids, frames)
		const anchorFor = (L) => {
			const id = sceneOf.get(L)
			const pv = id && api.get(id, 'pivot')
			if (!pv || (api.getAnimatedAttributes(id) || []).some((x) => x.indexOf('pivot') === 0)) return null
			if (L.ty === 0) return [pv.x + L.w / 2, L.h / 2 - pv.y]
			return [pv.x, -pv.y]
		}
		const res = repairPositions(exported.layers, frames, anchorFor, (L) => world[sceneOf.get(L)] || null)
		pivots += res.fixed
		if (res.varying.length) {
			const all = []
			for (let f = start; f <= end; f++) all.push(f)
			const vids = res.varying.map((L) => sceneOf.get(L))
			const full = samplePivots(comp, vids, all)
			res.varying.forEach((L) => bakePosition(L, full[sceneOf.get(L)], res.parentMatrix))
			baked += res.varying.length
		}
		// after positions are final: masks the writer dropped, sample their shapes every frame, rebuild on the drawing layers
		const masked = exported.layers.filter((L) => sceneOf.get(L) && !L.masksProperties).map((L) => [L, sceneMasks(sceneOf.get(L))]).filter((x) => x[1].length)
		if (masked.length) {
			const every = []
			for (let f = start; f <= end; f++) every.push(f)
			const paths = samplePivots(comp, [], every, [].concat(...masked.map((x) => x[1].map((m) => m.id))))
			const kids = (L) => exported.layers.filter((q) => q.parent === L.ind)
			const drawing = (L) => L.ty !== 4 ? L.ty !== 3 : /"ty":"(sh|rc|el|sr)"/.test(JSON.stringify(L.shapes || []))
			const under = (L) => [L].concat(...kids(L).map(under))
			for (const [L, ms] of masked) {
				const withPaths = ms.map((m) => ({ mode: m.mode, paths: paths[m.id] || {} })).filter((m) => Object.keys(m.paths).length)
				maskCount += applyMasks(withPaths, under(L).filter(drawing), res.parentMatrix)
			}
		}
		api.setFrame(time) // leave the comp showing the frame it was on
	}

	let json
	try {
		json = build(compId)
	} finally {
		api.setActiveComp(userComp)
		api.setFrame(userFrame)
	}
	json.assets = (json.assets || []).concat(assets)
	return { json, dirs, warnings, precomps: assets.length, refs, pivots, baked, masks: maskCount }
}
