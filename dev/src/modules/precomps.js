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

const isImageAsset = (a) => a && !a.layers && typeof a.p === 'string' && a.p.indexOf('data:') !== 0

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

// A scene attribute's keyframes as a Lottie property, values through `map`.
function sceneKeys(id, attr, map) {
	const ids = api.getKeyframeIdsForAttribute(id, attr)
	const keys = ids.map((k, j) => {
		const kf = { t: api.get(k, 'frame'), s: [map(api.get(k, 'data').numValue)] }
		if (j < ids.length - 1) Object.assign(kf, easeBetween(k, ids[j + 1]))
		return kf
	})
	return keys.length === 1 ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys }
}

// Static rotation and scale straight from the scene: the writer sometimes loses them
// (three of five identical comp references came out unrotated). Animated or driven
// ones stay as written; positions are corrected afterwards against the scene.
function sceneRotationScale(L, id) {
	if (!L.ks) return false
	const anim = api.getAnimatedAttributes(id) || []
	const conn = api.getInConnectedAttributes(id) || []
	const free = (a) => !anim.some((x) => x.indexOf(a) === 0) && !conn.some((x) => x.indexOf(a) === 0)
	let changed = false
	try {
		if (free('rotation') && !isAnimated(L.ks.r)) {
			const r = -api.get(id, 'rotation').z
			if (Math.abs(((valueAt(L.ks.r, 0) || [0])[0] || 0) - r) > 1e-4) (L.ks.r = { a: 0, k: r }), (changed = true)
		}
		if (free('scale') && !isAnimated(L.ks.s)) {
			const sc = api.get(id, 'scale')
			const want = [sc.x * 100, sc.y * 100, 100]
			const cur = valueAt(L.ks.s, 0) || [100, 100]
			if (Math.abs(cur[0] - want[0]) > 1e-4 || Math.abs(cur[1] - want[1]) > 1e-4) (L.ks.s = { a: 0, k: want }), (changed = true)
		}
	} catch (e) {}
	return changed
}

// The writer always exports skew as 0. Cavalry's transform is R·S·K (skew first), K the
// shear [[1, skew.x], [skew.y, 1]] in y-up space (measured: skew is a shear factor, not an
// angle). lottie-web's is R·K·S with K = [[1, −tan sk], [0, 1]] (axis 0) in y-down space.
// Any 2×2 splits that way, so rotation, scale and skew are rebuilt together: exactly for
// vertical skew, both at once and non-uniform scale. Keyed or driven ones are sampled every
// frame of `range` ([comp, from, to]); the optimiser fits keys to them again.
export function lottieRSK(rotDeg, sx, sy, kx, ky) {
	const th = (rotDeg * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th)
	// Cavalry linear part, y up
	const RS = [c * sx, -sn * sy, sn * sx, c * sy]
	const A = [RS[0] + RS[1] * ky, RS[0] * kx + RS[1], RS[2] + RS[3] * ky, RS[2] * kx + RS[3]]
	// to y down: flip y on both sides
	const L = [A[0], -A[1], -A[2], A[3]]
	const r = Math.atan2(L[2], L[0]), lc = Math.cos(r), ls = Math.sin(r)
	const x2 = lc * L[1] + ls * L[3], y2 = -ls * L[1] + lc * L[3] // second column, unrotated
	const lsx = Math.hypot(L[0], L[2])
	return { r: (r * 180) / Math.PI, s: [lsx * 100, y2 * 100], sk: (Math.atan(-x2 / (y2 || 1e-12)) * 180) / Math.PI }
}

function sceneSkew(L, id, range) {
	if (!L.ks || !api.hasAttribute(id, 'skew')) return false
	const keyedOrDriven = (a) => (api.getAnimatedAttributes(id) || []).some((x) => x.indexOf(a) === 0) || drivenAttr(id, a)
	const skew = api.get(id, 'skew') || {}
	const moving = keyedOrDriven('skew')
	if (!moving && Math.abs(skew.x || 0) < 1e-6 && Math.abs(skew.y || 0) < 1e-6) return false
	const at = () => {
		const sk = api.get(id, 'skew') || {}, sc = api.get(id, 'scale') || {}
		return lottieRSK((api.get(id, 'rotation') || {}).z || 0, sc.x != null ? sc.x : 1, sc.y != null ? sc.y : 1, sk.x || 0, sk.y || 0)
	}
	L.ks.sa = { a: 0, k: 0 }
	// horizontal skew under uniform scale commutes with it: keep the scene's keys and eases
	const sc0 = api.get(id, 'scale') || {}
	const uniform = !keyedOrDriven('scale') && Math.abs((sc0.x || 1) - (sc0.y || 1)) < 1e-9
	const deg = (v) => (Math.atan(v) * 180) / Math.PI
	if (uniform && !keyedOrDriven('skew.y') && Math.abs(skew.y || 0) < 1e-6 && !drivenAttr(id, 'skew')) {
		const keyed = (api.getAnimatedAttributes(id) || []).indexOf('skew.x') >= 0
		L.ks.sk = keyed ? sceneKeys(id, 'skew.x', deg) : { a: 0, k: deg(skew.x) }
		return true
	}
	if (!moving && !keyedOrDriven('rotation') && !keyedOrDriven('scale')) {
		const v = at()
		L.ks.r = { a: 0, k: v.r }
		L.ks.s = { a: 0, k: [v.s[0], v.s[1], 100] }
		L.ks.sk = { a: 0, k: v.sk }
		return true
	}
	if (!range) return false
	const [comp, from, to] = range
	api.setActiveComp(comp)
	const vals = []
	for (let f = from; f <= to; f++) {
		api.setFrame(f)
		const v = at()
		// keep rotation continuous (atan2 wraps at ±180)
		if (vals.length) while (v.r - vals[vals.length - 1].r > 180) v.r -= 360
		if (vals.length) while (v.r - vals[vals.length - 1].r < -180) v.r += 360
		vals.push(v)
	}
	L.ks.r = frameKeys(vals, from, (v) => [v.r])
	L.ks.s = frameKeys(vals, from, (v) => [v.s[0], v.s[1], 100])
	L.ks.sk = frameKeys(vals, from, (v) => [v.sk])
	for (const f of ['r', 'sk']) if (!L.ks[f].a) L.ks[f] = { a: 0, k: L.ks[f].k[0] }
	return true
}

// Cavalry fills with Even Odd by default (fillRule 0); the writer writes no rule, so Lottie
// uses nonzero, and shapes cut by overlapping contours (a star made of a square and four
// rounded rects) fill solid.
function sceneFillRule(L, id) {
	if (!L.shapes || !api.hasAttribute(id, 'fillRule') || api.get(id, 'fillRule') !== 0) return
	const walk = (items) => items.forEach((it) => (it.ty === 'fl' || it.ty === 'gf' ? (it.r = 2) : it.ty === 'gr' && walk(it.it || [])))
	walk(L.shapes)
}

// Lottie properties a scene attribute was written to, on one exported layer.
function lottieProps(L, attr) {
	const ks = L.ks || {}
	const first = (ty) => {
		const walk = (items) => {
			for (const it of items || []) {
				if (it.ty === ty) return it
				if (it.ty === 'gr') {
					const r = walk(it.it)
					if (r) return r
				}
			}
		}
		return walk(L.shapes)
	}
	const sub = (ty, f) => {
		const it = first(ty)
		return it && it[f] ? [it[f]] : []
	}
	switch (attr) {
		case 'opacity':
			return ks.o ? [ks.o] : []
		case 'position.x':
			return ks.p && ks.p.s ? [ks.p.x] : ks.p ? [ks.p] : []
		case 'position.y':
			return ks.p && ks.p.s ? [ks.p.y] : ks.p ? [ks.p] : []
		case 'rotation.z':
			return ks.r ? [ks.r] : []
		case 'scale.x':
		case 'scale.y':
			return ks.s ? [ks.s] : []
		case 'stroke.width':
			return sub('st', 'w')
		case 'stroke.alpha':
			return sub('st', 'o')
		case 'material.alpha':
			return sub('fl', 'o')
		case 'stroke.trimStart':
			return sub('tm', 's')
		case 'stroke.trimEnd':
			return sub('tm', 'e')
		case 'stroke.trimTravel':
			return sub('tm', 'o')
		case 'generator.cornerRadius':
			return sub('rc', 'r')
		case 'inputPath':
			return sub('sh', 'ks')
		default:
			return []
	}
}

// The writer drops hold (step) interpolation: a value Cavalry holds and then snaps
// (the dreidel lines' stroke width) fades across the gap instead. Hold the Lottie key
// wherever the scene key is a hold.
// The writer clamps eases to 0–1, so an overshooting one loses its overshoot (a corner
// radius that dips past its end value and settles back went straight there, and the
// star cut from those corners no longer met them). Where a 1-D Lottie property carries the
// scene attribute's keys, each segment takes the scene's ease.
function sceneEases(L, id) {
	let n = 0
	for (const attr of api.getAnimatedAttributes(id) || []) {
		const ids = api.getKeyframeIdsForAttribute(id, attr)
		for (const p of lottieProps(L, attr).filter(isAnimated)) {
			if (p.k.length !== ids.length || p.k.some((kf, j) => kf.t !== api.get(ids[j], 'frame') || (kf.s && kf.s.length !== 1))) continue
			p.k.forEach((kf, j) => {
				if (j === p.k.length - 1 || kf.h === 1) return
				const e = easeBetween(ids[j], ids[j + 1])
				if (e.h) return
				kf.o = e.o
				kf.i = e.i
				n++
			})
		}
	}
	return n
}

function sceneHolds(L, id) {
	let n = 0
	for (const attr of api.getAnimatedAttributes(id) || []) {
		const props = lottieProps(L, attr).filter(isAnimated)
		if (!props.length) continue
		const holds = new Set(
			api
				.getKeyframeIdsForAttribute(id, attr)
				.filter((k) => (api.get(k, 'data') || {}).interpolation === 2)
				.map((k) => api.get(k, 'frame'))
		)
		if (!holds.size) continue
		for (const p of props)
			p.k.forEach((kf, j) => {
				if (j === p.k.length - 1 || kf.h === 1 || !holds.has(Math.round(kf.t))) return
				kf.h = 1
				delete kf.i
				delete kf.o
				n++
			})
	}
	return n
}

// The writer bakes many keyframed transforms to one key per frame (flame scale: ~490 keys
// where the scene has a handful). Use the scene's own keys and eases instead, but only
// when they reproduce the writer's bake on every frame; magic easing, drivers and
// anything else that doesn't match keeps the bake. Position offsets are fixed later by
// the pivot repair, so position is compared after removing a constant offset.
function sourceOf(id, attr) {
	const conn = api.getInConnectedAttributes(id) || []
	if (conn.indexOf(attr) < 0) return (api.getAnimatedAttributes(id) || []).indexOf(attr) >= 0 ? [id, attr] : null
	const src = String(api.getInConnection(id, attr) || '')
	const dot = src.indexOf('.')
	if (dot < 0) return null
	const sid = src.slice(0, dot), sattr = src.slice(dot + 1)
	return (api.getAnimatedAttributes(sid) || []).indexOf(sattr) >= 0 ? [sid, sattr] : null
}

function matchesBake(fresh, baked, from, to, tol, offset) {
	if (!isAnimated(baked) || baked.k.length < 4) return false // not a bake worth replacing
	let d0 = null
	for (let t = from; t <= to; t++) {
		const a = valueAt(fresh, t), b = valueAt(baked, t)
		if (!a || !b) return false
		for (let i = 0; i < Math.min(a.length, b.length, 2); i++) {
			let d = a[i] - b[i]
			if (offset) {
				if (d0 === null) d0 = []
				if (d0[i] === undefined) d0[i] = d
				d -= d0[i]
			}
			if (Math.abs(d) > tol) return false
		}
	}
	return true
}

function sceneTransformKeys(L, id) {
	if (!L.ks) return 0
	const ks = L.ks
	const range = (p) => [p.k[0].t, p.k[p.k.length - 1].t]
	let n = 0
	const r = sourceOf(id, 'rotation.z')
	if (r && isAnimated(ks.r)) {
		const fresh = sceneKeys(r[0], r[1], (v) => -v)
		const [a, b] = range(ks.r)
		if (matchesBake(fresh, ks.r, a, b, 0.05)) (ks.r = fresh), n++
	}
	const sx = sourceOf(id, 'scale.x'), sy = sourceOf(id, 'scale.y')
	if ((sx || sy) && isAnimated(ks.s)) {
		const X = sx ? sceneKeys(sx[0], sx[1], (v) => v * 100) : { a: 0, k: api.get(id, 'scale').x * 100 }
		const Y = sy ? sceneKeys(sy[0], sy[1], (v) => v * 100) : { a: 0, k: api.get(id, 'scale').y * 100 }
		const fresh = combine2(X, Y)
		const [a, b] = range(ks.s)
		if (fresh && matchesBake(fresh, ks.s, a, b, 0.05)) (ks.s = fresh), n++
	}
	if (ks.p && ks.p.s) {
		for (const [axis, sign] of [['x', 1], ['y', -1]]) {
			const src = sourceOf(id, 'position.' + axis)
			if (!src || !isAnimated(ks.p[axis])) continue
			const fresh = sceneKeys(src[0], src[1], (v) => sign * v)
			const [a, b] = range(ks.p[axis])
			if (!matchesBake(fresh, ks.p[axis], a, b, 0.05, true)) continue
			// keep the bake's absolute placement: shift the scene keys by the constant offset
			const off = valueAt(ks.p[axis], a)[0] - valueAt(fresh, a)[0]
			ks.p[axis] = isAnimated(fresh) ? Object.assign({}, fresh, { k: fresh.k.map((kf) => Object.assign({}, kf, { s: [kf.s[0] + off] })) }) : { a: 0, k: fresh.k + off }
			n++
		}
	}
	return n
}

// Two 1D properties as one 2D Lottie property; null if their keys aren't at the same frames.
function combine2(X, Y) {
	const ax = isAnimated(X), ay = isAnimated(Y)
	if (!ax && !ay) return { a: 0, k: [asNum(X), asNum(Y), 100] }
	const times = (ax ? X : Y).k.map((k) => k.t)
	if (ax && ay && (X.k.length !== Y.k.length || X.k.some((k, j) => k.t !== Y.k[j].t))) return null
	const at = (P, j) => (isAnimated(P) ? P.k[j] : { s: [asNum(P)] })
	return {
		a: 1,
		k: times.map((t, j) => {
			const x = at(X, j), y = at(Y, j)
			const kf = { t, s: [x.s[0], y.s[0], 100] }
			if (j < times.length - 1) {
				if (x.h === 1 || y.h === 1) kf.h = 1
				else {
					const e = (q, f, d) => (q[f] ? q[f][d][0] : f === 'o' ? 0 : 1)
					kf.o = { x: [e(x, 'o', 'x'), e(y, 'o', 'x'), 0], y: [e(x, 'o', 'y'), e(y, 'o', 'y'), 0] }
					kf.i = { x: [e(x, 'i', 'x'), e(y, 'i', 'x'), 1], y: [e(x, 'i', 'y'), e(y, 'i', 'y'), 1] }
				}
			}
			return kf
		}),
	}
}
const asNum = (P) => (Array.isArray(P.k) ? P.k[0] : P.k)

// The writer drops opacity on groups (static 100 or its animation): take it from the scene.
// Driven opacity is sampled every frame of `range` ([comp, from, to]).
function sceneOpacity(L, id, range) {
	if (!L.ks) return false
	const animated = (api.getAnimatedAttributes(id) || []).indexOf('opacity') >= 0
	if (animated) {
		L.ks.o = sceneKeys(id, 'opacity', (v) => v)
		return true
	}
	if (drivenAttr(id, 'opacity')) {
		if (!range) return false
		const o = frameKeys(sampleAttr(range[0], id, 'opacity', range[1], range[2]), range[1], (v) => [v])
		L.ks.o = o.a ? o : { a: 0, k: o.k[0] }
		return true
	}
	let v
	try {
		v = api.get(id, 'opacity')
	} catch (e) {
		return false
	}
	if (typeof v !== 'number') return false
	const cur = (valueAt(L.ks.o, 0) || [100])[0]
	if (isAnimated(L.ks.o) || Math.abs(cur - v) < 1e-6) return false
	L.ks.o = { a: 0, k: v }
	return true
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

// A layer's own transform at t as an affine map: p + R·K·S·(x − a), K the skew (as lottie-web).
// ponytail: skew axis (sa) assumed 0, which is all sceneSkew writes.
export function layerMatrix(ks, t) {
	const p = ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0]
	const a = valueAt(ks.a, t) || [0, 0],
		s = valueAt(ks.s, t) || [100, 100],
		r = (((valueAt(ks.r, t) || [0])[0] || 0) * Math.PI) / 180,
		k = Math.tan((((valueAt(ks.sk, t) || [0])[0] || 0) * Math.PI) / 180)
	const c = Math.cos(r), sn = Math.sin(r), sx = s[0] / 100, sy = s[1] / 100
	// [m00 m01 m10 m11 tx ty]
	const m = [c * sx, (-c * k - sn) * sy, sn * sx, (c - sn * k) * sy]
	return [m[0], m[1], m[2], m[3], p[0] - (m[0] * a[0] + m[1] * a[1]), p[1] - (m[2] * a[0] + m[3] * a[1])]
}
// lottie-web clips a matted layer to its path bounds (strokes excluded) plus 10%, so a
// straight stroked line (zero height) vanishes under any matte, and strokes near the bounds
// are cut. An invisible rect over the stroked bounds keeps them in.
// Animated group transforms count at each of their keys (and halfway between, for turns).
export function padMatteBounds(L) {
	let b = null, sw = 0
	const grow = (M, x, y) => {
		const q = [M[0] * x + M[1] * y + M[4], M[2] * x + M[3] * y + M[5]]
		b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])] : [q[0], q[1], q[0], q[1]]
	}
	const values = (p) => (!p ? [] : isAnimated(p) ? p.k.map((k) => k.s).filter((v) => v !== undefined) : [p.k])
	const walk = (items, M, t) => {
		const tr = items.find((x) => x.ty === 'tr')
		if (tr) M = mul(M, layerMatrix(tr, t))
		for (const it of items) {
			if (it.ty === 'gr') walk(it.it || [], M, t)
			else if (it.ty === 'sh') {
				for (const v of values(it.ks))
					for (const sh of Array.isArray(v) ? v : [v]) if (sh && sh.v) sh.v.forEach((q, i) => (grow(M, q[0], q[1]), grow(M, q[0] + sh.i[i][0], q[1] + sh.i[i][1]), grow(M, q[0] + sh.o[i][0], q[1] + sh.o[i][1])))
			} else if (it.ty === 'rc' || it.ty === 'el') for (const c of values(it.p)) for (const s of values(it.s)) grow(M, c[0] - s[0] / 2, c[1] - s[1] / 2), grow(M, c[0] + s[0] / 2, c[1] + s[1] / 2)
			else if (it.ty === 'st' || it.ty === 'gs') sw = Math.max(sw, ...values(it.w).map((w) => (Array.isArray(w) ? w[0] : w) * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]))))
		}
	}
	const keyTimes = new Set([0])
	const collect = (items) => {
		for (const it of items || []) {
			if (it.ty === 'gr') collect(it.it)
			if (it.ty !== 'tr') continue
			for (const f of ['p', 'a', 's', 'r', 'sk']) if (isAnimated(it[f])) it[f].k.forEach((kf, j, k) => (keyTimes.add(kf.t), k[j + 1] && keyTimes.add((kf.t + k[j + 1].t) / 2)))
		}
	}
	collect(L.shapes)
	// lottie-web measures each frame: pad if any is thin, over all of them
	let all = null, thin = false
	for (const t of keyTimes) {
		b = null
		walk(L.shapes || [], [1, 0, 0, 1, 0, 0], t)
		if (!b) continue
		thin = thin || Math.min(b[2] - b[0], b[3] - b[1]) < 5 * sw // the 10% margin covers a stroke's half width once each side is 5 widths long
		all = all ? [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])] : b
	}
	b = all
	if (!b || !sw || !thin) return false
	const still = (k) => ({ a: 0, k })
	L.shapes.push({
		ty: 'gr',
		nm: 'Matte bounds',
		it: [
			{ ty: 'rc', d: 1, p: still([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), s: still([b[2] - b[0] + 2 * sw, b[3] - b[1] + 2 * sw]), r: still(0) },
			{ ty: 'fl', c: still([0, 0, 0, 1]), o: still(0), r: 1 },
			{ ty: 'tr', p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) },
		],
	})
	return true
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

// A driven (connected) attribute's value at every frame of [from, to]: Cavalry only
// evaluates it at the current frame. Opens the comp; the caller restores comp and frame.
function sampleAttr(comp, id, attr, from, to) {
	api.setActiveComp(comp)
	const out = []
	for (let f = from; f <= to; f++) {
		api.setFrame(f)
		out.push(api.get(id, attr))
	}
	return out
}

// Per-frame values as a Lottie property (linear between frames; holdJumps snaps jumps).
function frameKeys(vals, from, map) {
	const k = vals.map((v, j) => {
		const kf = { t: from + j, s: map(v) }
		if (j < vals.length - 1) Object.assign(kf, { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } })
		return kf
	})
	return k.every((kf) => JSON.stringify(kf.s) === JSON.stringify(k[0].s)) ? { a: 0, k: k[0].s } : { a: 1, k }
}
const drivenAttr = (id, attr) => (api.getInConnectedAttributes(id) || []).some((a) => a === attr || a.indexOf(attr + '.') === 0)

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

// Track mattes Cavalry's writer drops become Lottie track mattes (planMattes /
// buildTrackMattes). Not masks: a mask lives in the clipped layer's space, so under an
// animated parent it has to be resampled every frame, and players blending the two
// between frames let the layer show past the matte. A matte layer sits in comp space,
// like Cavalry's matte.
const MATTE_TT = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 1, 5: 2 } // Cavalry matteMode -> Lottie tt

function matteConns(id) {
	if (!api.hasAttribute(id, 'matteMode')) return [] // filters, behaviours: Cavalry logs an error for missing attributes
	let mode = 0
	try {
		mode = api.get(id, 'matteMode')
	} catch (e) {}
	return api
		.getInConnectedAttributes(id)
		.filter((a) => /^trackMattes\.\d+\.id$/.test(a))
		.map((a) => {
			let on = true
			try {
				on = api.get(id, 'trackMattes.' + a.split('.')[1] + '.enabled') !== false
			} catch (e) {}
			return on && { id: String(api.getInConnection(id, a)).replace(/\.id$/, ''), mode }
		})
		.filter(Boolean)
}

// Track mattes in a comp: [{target, sources, tt}], plus the hidden
// sources (and hidden ancestors) to show while Cavalry's writer exports them.
export function planMattes(comp, warn) {
	const jobs = [], unhide = new Set()
	for (const id of compLayers(comp)) {
		const ms = matteConns(id)
		if (!ms.length) continue
		// Cavalry draws a group's children unmatted (tested: hidden, visible, inverted, nested)
		if (api.getLayerType(id) === 'group') {
			if (warn) warn('The track matte on group ' + api.getNiceName(id) + ' does nothing in Cavalry, so it isn’t exported')
			continue
		}
		jobs.push({ target: id, sources: ms.map((m) => m.id), tt: MATTE_TT[ms[0].mode] || 1 })
		for (const m of ms)
			for (let q = m.id, g = 0; q && q !== comp && g < 64; q = api.getParent(q), g++) {
				try {
					if (api.get(q, 'hidden')) unhide.add(q)
				} catch (e) {}
			}
	}
	return { jobs, unhide: [...unhide] }
}

// The shapes a mask or matte source draws: itself unless it's a group, plus its
// descendants (hidden ones skipped; the source itself is usually hidden).
function sourceShapes(id) {
	const out = api.getLayerType(id) === 'group' ? [] : [id]
	for (const k of api.getChildren(id)) {
		let hidden = false
		try {
			hidden = !!api.get(k, 'hidden')
		} catch (e) {}
		if (!hidden) out.push(...sourceShapes(k))
	}
	return out
}

// ---------- fill filters ----------
// Cavalry's writer drops filters. A Fill filter becomes After Effects' Fill effect, written
// the way bodymovin writes it (players read Color and Opacity by index). A filter on a
// group draws over the group's render; Lottie effects on a parent don't reach its children,
// so it goes on every drawing layer under the filtered one (same as masks).

// Fill filters on a scene layer, in order: [fill id].
function sceneFills(id) {
	return (api.getInConnectedAttributes(id) || [])
		.filter((a) => /^filters\.\d+$/.test(a))
		.map((a) => String(api.getInConnection(id, a)).replace(/\.id$/, ''))
		.filter((f) => api.getLayerType(f) === 'fill')
}

// fillColor as Lottie [r, g, b, 1] (0..1) and its alpha as 0..1; animated when keyed.
// Channels keyed at the same frames with the same eases keep the scene's keys; otherwise
// one key per frame over [from, to]. A driven fillColor arrives already sampled per frame.
export function fillProps(channels, from, to) {
	const at = (t) => channels.map((P) => (valueAt(P, t) || [0])[0])
	const anim = channels.filter(isAnimated)
	if (!anim.length) {
		const v = at(0)
		return { color: { a: 0, k: [v[0], v[1], v[2], 1] }, opacity: { a: 0, k: v[3] } }
	}
	const ease = (kf) => JSON.stringify([kf.h, kf.o, kf.i])
	const ref = anim[0].k
	const shared = anim.every((P) => P.k.length === ref.length && P.k.every((kf, j) => kf.t === ref[j].t && ease(kf) === ease(ref[j])))
	const frames = shared ? ref : []
	if (!shared) for (let t = from; t <= to; t++) frames.push({ t, o: { x: [0], y: [0] }, i: { x: [1], y: [1] } })
	const keys = (pick) =>
		frames.map((f, j) => {
			const kf = { t: f.t, s: pick(at(f.t)) }
			if (j < frames.length - 1) for (const k of ['h', 'o', 'i']) if (f[k] !== undefined) kf[k] = f[k]
			return kf
		})
	const prop = (pick, i) => (channels.slice(...i).some(isAnimated) ? { a: 1, k: keys(pick) } : { a: 0, k: pick(at(0)) })
	const opacity = prop((v) => [v[3]], [3, 4])
	if (!opacity.a) opacity.k = opacity.k[0] // sliders hold a plain number
	return { color: prop((v) => [v[0], v[1], v[2], 1], [0, 3]), opacity }
}

// L and every layer parented under it that draws something (not nulls, not empty shape layers).
function drawingUnder(layers, L) {
	const drawing = (q) => (q.ty !== 4 ? q.ty !== 3 : /"ty":"(sh|rc|el|sr)"/.test(JSON.stringify(q.shapes || [])))
	const under = (q) => [q].concat(...layers.filter((c) => c.parent === q.ind).map(under))
	return under(L).filter(drawing)
}

function fillEffect(color, opacity) {
	const p = (ty, nm, n, v) => ({ ty, nm, mn: 'ADBE Fill-000' + n, ix: 0, v })
	const ef = [
		p(10, 'Fill Mask', 1, { a: 0, k: 0 }),
		p(7, 'All Masks', 7, { a: 0, k: 0 }),
		p(2, 'Color', 2, color),
		p(7, 'Invert', 6, { a: 0, k: 0 }),
		p(0, 'Horizontal Feather', 3, { a: 0, k: 0 }),
		p(0, 'Vertical Feather', 4, { a: 0, k: 0 }),
		p(0, 'Opacity', 5, opacity),
	]
	ef.forEach((e, i) => (e.ix = i + 1))
	return { ty: 21, nm: 'Fill', np: 9, mn: 'ADBE Fill', ix: 1, en: 1, ef }
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

// Cavalry children inherit their parents' opacity; Lottie children don't (parenting only
// passes the transform). Fold each layer's ancestors' opacity into its own: a constant
// factor when they're static, otherwise one key per frame over [from, to].
export function inheritOpacity(layers, from, to) {
	const byInd = new Map(layers.map((L) => [L.ind, L]))
	const opacity = (L) => (L.ks && L.ks.o) || { a: 0, k: 100 }
	const hasHold = (p) => isAnimated(p) && p.k.some((k) => k.h === 1)
	let n = 0
	for (const L of layers) {
		const chain = []
		for (let q = byInd.get(L.parent); q; q = byInd.get(q.parent)) {
			const o = opacity(q)
			if (isAnimated(o) || (valueAt(o, 0) || [100])[0] !== 100) chain.push(o)
		}
		if (!chain.length) continue
		const own = opacity(L)
		const all = [own].concat(chain)
		const at = (t) => all.reduce((v, o) => (v * (valueAt(o, t) || [100])[0]) / 100, 100)
		if (!all.some(isAnimated)) L.ks.o = { a: 0, k: at(0) }
		else {
			const step = all.some(hasHold)
			const keys = []
			for (let t = from; t <= to; t++) {
				const kf = { t, s: [at(t)] }
				if (t < to) Object.assign(kf, step ? { h: 1 } : { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } })
				keys.push(kf)
			}
			L.ks.o = { a: 1, k: keys }
		}
		n++
	}
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
		trackMattes = 0,
		fills = 0,
		refs = 0,
		next = 0
	const userComp = api.getActiveComp(),
		userFrame = api.getFrame()

	function build(comp) {
		const plan = planMattes(comp, (w) => warnings.push(w))
		const shown = []
		let out
		try {
			// Cavalry's writer skips hidden layers, and matte sources are usually hidden
			for (const q of plan.unhide) {
				api.set(q, { hidden: false })
				shown.push(q)
			}
			out = exportComp(comp, opts)
		} finally {
			for (const q of shown) api.set(q, { hidden: true })
		}
		dirs.push(out.dir)
		const exported = out.json
		// every comp exports to its own folder, and images in two of them can share an id or
		// a name: point each at its folder and give it an id of its own, before layers are copied
		const tag = next++
		for (const a of exported.assets || []) {
			if (!isImageAsset(a)) continue
			const id = a.id + '_' + tag
			for (const L of exported.layers) if (L.ty === 2 && L.refId === a.id) L.refId = id
			a.id = id
			a.u = out.dir + '/' + (a.u || '')
		}
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
		// Cavalry hides a group's children outside the group's in/out frames; Lottie parenting
		// passes only the transform, so each layer is clipped to its scene ancestors' frames
		for (const L of exported.layers) {
			const id = sceneOf.get(L)
			if (!id) continue
			let from = -Infinity, to = Infinity
			for (let p = api.getParent(id), guard = 0; p && ids.has(p) && guard < 64; p = api.getParent(p), guard++) {
				const i = api.getInFrame(p), o = api.getOutFrame(p)
				if (i >= 0) from = Math.max(from, i) // footage reports -1
				if (o >= 0) to = Math.min(to, o + 1) // inclusive -> exclusive
			}
			if (from > L.ip) L.ip = from
			if (to < L.op) L.op = Math.max(to, L.ip)
		}
		exported.layers = dropGuides(exported.layers, sceneOf)
		staticSingleKeys(exported.layers)
		for (const L of exported.layers) {
			const id = sceneOf.get(L)
			if (!id) continue
			sceneTransformKeys(L, id)
			sceneRotationScale(L, id)
			sceneSkew(L, id, [comp, api.get(comp, 'startFrame'), last])
			if (L.ty !== 0) sceneOpacity(L, id, [comp, api.get(comp, 'startFrame'), last])
			sceneEases(L, id)
			sceneHolds(L, id)
		}
		inheritOpacity(exported.layers, api.get(comp, 'startFrame'), last)
		repair(comp, exported, sceneOf)
		addFills(comp, exported, sceneOf) // before mattes, so matte copies carry them
		for (const L of exported.layers) if (sceneOf.get(L)) sceneFillRule(L, sceneOf.get(L))
		buildTrackMattes(comp, exported, sceneOf, plan)
		return exported
	}

	// Each matte becomes a precomp of its source's layers (their outside parents copied as
	// nulls, so they stay put), referenced by a matte layer (td) directly above every
	// drawing layer it clips, which takes the matte type (tt). Several mattes on one layer
	// share one precomp: their union (Cavalry sets one matte mode per layer, not per matte).
	function buildTrackMattes(comp, exported, sceneOf, plan) {
		if (!plan.jobs.length) return
		const layers = exported.layers
		const [w, h] = compSize(comp)
		const byInd = new Map(layers.map((L) => [L.ind, L]))
		const within = (id, src) => {
			for (let q = id, g = 0; q && g < 64; q = api.getParent(q), g++) if (q === src) return true
			return false
		}
		let ind = Math.max(0, ...layers.map((L) => L.ind || 0)) + 1
		const used = new Set(), assetFor = new Map()
		for (const job of plan.jobs) {
			const key = job.sources.slice().sort().join('+')
			if (!assetFor.has(key)) {
				const own = layers.filter((L) => sceneOf.get(L) && job.sources.some((src) => within(sceneOf.get(L), src)))
				if (!own.length) {
					warnings.push('A track matte on ' + api.getNiceName(job.target) + ' in ' + api.getNiceName(comp) + ' had nothing to export; it shows unmatted')
					assetFor.set(key, null)
					continue
				}
				own.forEach((L) => used.add(L))
				const copy = own.map((L) => JSON.parse(JSON.stringify(L)))
				const have = new Set(copy.map((L) => L.ind))
				for (let i = 0; i < copy.length; i++) {
					const P = copy[i].parent != null && !have.has(copy[i].parent) && byInd.get(copy[i].parent)
					if (!P) continue
					copy.push({ ty: 3, ind: P.ind, parent: P.parent, ip: P.ip, op: P.op, st: P.st || 0, sr: 1, ks: JSON.parse(JSON.stringify(P.ks || {})) })
					have.add(P.ind)
				}
				const id = 'matte_' + next++
				assets.push({ id, nm: 'Matte', fr: exported.fr, layers: copy })
				assetFor.set(key, id)
			}
			const refId = assetFor.get(key)
			if (!refId) continue
			for (const T of layers.filter((L) => sceneOf.get(L) === job.target))
				for (const D of drawingUnder(layers, T)) {
					if (D.tt || used.has(D)) continue
					layers.splice(layers.indexOf(D), 0, { ty: 0, ind: ind++, nm: 'Matte', refId, td: 1, ip: D.ip, op: D.op, st: 0, sr: 1, w, h, ks: {} })
					D.tt = job.tt
					padMatteBounds(D)
					trackMattes++
				}
		}
		// sources that were hidden were only exported for their mattes
		const hiddenSrc = (L) => plan.unhide.some((q) => within(sceneOf.get(L), q))
		exported.layers = layers.filter((L) => !used.has(L) || !hiddenSrc(L) || layers.some((q) => q.parent === L.ind && !used.has(q)))
	}

	function addFills(comp, exported, sceneOf) {
		const from = api.get(comp, 'startFrame'), to = api.get(comp, 'endFrame')
		const byInd = new Map(exported.layers.map((L) => [L.ind, L]))
		const depth = (L) => (byInd.has(L.parent) ? 1 + depth(byInd.get(L.parent)) : 0)
		// deepest first: a layer's own fill runs before its group's, as in Cavalry
		for (const L of exported.layers.slice().sort((a, b) => depth(b) - depth(a))) {
			const id = sceneOf.get(L)
			if (!id) continue
			for (const f of sceneFills(id)) {
				const anim = api.getAnimatedAttributes(f) || []
				const still = api.get(f, 'fillColor')
				const driven = drivenAttr(f, 'fillColor') && sampleAttr(comp, f, 'fillColor', from, to)
				const channels = ['r', 'g', 'b', 'a'].map((c) =>
					driven ? frameKeys(driven, from, (v) => [v[c] / 255]) : anim.indexOf('fillColor.' + c) >= 0 ? sceneKeys(f, 'fillColor.' + c, (v) => v / 255) : { a: 0, k: still[c] / 255 },
				)
				const { color, opacity } = fillProps(channels, from, to)
				if (api.get(f, 'blendMode') !== 3) warnings.push('The Fill filter on ' + api.getNiceName(id) + ' uses a blend mode Lottie’s Fill effect lacks; it exports as Normal')
				for (const D of drawingUnder(exported.layers, L)) {
					D.ef = (D.ef || []).concat(JSON.parse(JSON.stringify(fillEffect(color, opacity))))
					fills++
				}
			}
		}
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
		const masked = exported.layers
			.filter((L) => sceneOf.get(L) && !L.masksProperties)
			.map((L) => [L, sceneMasks(sceneOf.get(L))])
			.filter((x) => x[1].length)
		if (masked.length) {
			const every = []
			for (let f = start; f <= end; f++) every.push(f)
			const shapesOf = new Map()
			for (const [, ms] of masked) for (const m of ms) if (!shapesOf.has(m.id)) shapesOf.set(m.id, sourceShapes(m.id))
			const sampled = samplePivots(comp, [], every, [...new Set([].concat(...shapesOf.values()))])
			// a source's contours at each frame: all its shapes' contours together
			const paths = {}
			for (const [src, shapes] of shapesOf) {
				const byFrame = {}
				for (const f of every) {
					const cs = [].concat(...shapes.map((sh) => (sampled[sh] && sampled[sh][f]) || []))
					if (cs.length) byFrame[f] = cs
				}
				paths[src] = byFrame
			}
			for (const [L, ms] of masked) {
				const withPaths = ms.map((m) => ({ mode: m.mode, paths: paths[m.id] || {} })).filter((m) => Object.keys(m.paths).length)
				maskCount += applyMasks(withPaths, drawingUnder(exported.layers, L), res.parentMatrix)
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
	return { json, dirs, warnings, precomps: assets.length, refs, pivots, baked, masks: maskCount, trackMattes, fills }
}
