// Lottie JSON optimisation passes. Pure functions over the parsed JSON — no `api.` calls,
// so they run (and are tested) in Node as well as in Cavalry.
//
// Each pass mutates the json it is given and returns the number of things it changed.
// `optimise` clones the input, runs the selected passes in catalogue order and reports
// the bytes each one saved.

// ---------- walking ----------

import { fitEase, fitMotionPath, easeAt, LINEAR, simplifyPath } from './fit.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// An animatable property is {a, k}; animated when a === 1 and k is a list of keyframes.
const isProp = (v) => isObj(v) && 'k' in v && ('a' in v || 'ix' in v)
const isAnimated = (p) =>
	Array.isArray(p.k) && p.k.length > 0 && isObj(p.k[0]) && 't' in p.k[0]

// Visit every animatable property under `node`. fn(prop, key, owner)
export function forEachProp(node, fn, key, owner) {
	if (Array.isArray(node)) {
		for (const v of node) forEachProp(v, fn, key, node)
		return
	}
	if (!isObj(node)) return
	if (isProp(node)) {
		fn(node, key, owner)
		// keyframe values can hold nested props only in exotic files; stop here
		return
	}
	for (const k in node) forEachProp(node[k], fn, k, node)
}

// Every layer list in the file: the root and each precomp asset.
export function layerLists(json) {
	const lists = []
	if (Array.isArray(json.layers)) lists.push(json.layers)
	for (const a of json.assets || []) if (Array.isArray(a.layers)) lists.push(a.layers)
	return lists
}

// Every shape-item list (layer.shapes and nested group .it).
function shapeLists(layer, out = []) {
	const walk = (items) => {
		if (!Array.isArray(items)) return
		out.push(items)
		for (const it of items) if (it && it.ty === 'gr') walk(it.it)
	}
	walk(layer.shapes)
	return out
}

const hasExpressions = (json) => JSON.stringify(json).indexOf('"x":"') >= 0

// ---------- value helpers ----------

const EPS = 1e-9

function deepEqual(a, b) {
	if (a === b) return true
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < EPS
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a)
		if (ka.length !== Object.keys(b).length) return false
		return ka.every((k) => deepEqual(a[k], b[k]))
	}
	return false
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])
const component = (v, i) => {
	const a = asArray(v)
	return a[i] != null ? a[i] : a[0]
}

// A segment eases linearly when every component's tangents lie on the diagonal.
function isLinearSegment(kf, dims) {
	if (kf.h === 1) return false
	if (!kf.o || !kf.i) return true // last-key style / missing tangents read as linear
	for (let d = 0; d < dims; d++) {
		if (Math.abs(component(kf.o.x, d) - component(kf.o.y, d)) > EPS) return false
		if (Math.abs(component(kf.i.x, d) - component(kf.i.y, d)) > EPS) return false
	}
	return true
}

const hasSpatial = (kf) =>
	(kf.to && kf.to.some((v) => Math.abs(v) > EPS)) ||
	(kf.ti && kf.ti.some((v) => Math.abs(v) > EPS))

// ---------- passes ----------

// 2. Animated property whose keys all hold one value -> static.
export function collapseStatic(json) {
	let n = 0
	forEachProp(json, (p) => {
		if (!isAnimated(p) || p.x) return
		const first = p.k[0].s
		// text documents (s is an object) stay keyframed; a spatial curve can leave and return
		if (first === undefined || isObj(first) || p.k.some(hasSpatial)) return
		if (!p.k.every((kf) => kf.s === undefined || deepEqual(kf.s, first))) return
		// Shape keyframes wrap the path in a one-element array.
		p.k = Array.isArray(first) && first.length === 1 ? first[0] : first
		p.a = 0
		n++
	})
	return n
}

// 3. Drop keys that change nothing: interior keys of a constant run, and interior keys
// lying exactly on a linear segment between their neighbours (scalars/vectors only).
export function removeRedundantKeys(json) {
	let n = 0
	forEachProp(json, (p) => {
		if (!isAnimated(p) || p.k.length < 3) return
		const k = p.k
		const keep = [k[0]]
		for (let j = 1; j < k.length - 1; j++) {
			const prev = keep[keep.length - 1]
			const cur = k[j]
			const next = k[j + 1]
			if (cur.s === undefined || prev.s === undefined || next.s === undefined) {
				keep.push(cur)
				continue
			}
			const flat = deepEqual(prev.s, cur.s) && deepEqual(cur.s, next.s)
			if (flat && !hasSpatial(prev) && !hasSpatial(cur)) {
				n++
				continue
			}
			if (onLine(prev, cur, next)) {
				n++
				continue
			}
			keep.push(cur)
		}
		keep.push(k[k.length - 1])
		p.k = keep
	})
	return n
}

function onLine(prev, cur, next) {
	const a = prev.s,
		b = cur.s,
		c = next.s
	if (!Array.isArray(a) || !a.every((v) => typeof v === 'number')) return false
	if (b.length !== a.length || c.length !== a.length) return false
	if (hasSpatial(prev) || hasSpatial(cur)) return false
	if (!isLinearSegment(prev, a.length) || !isLinearSegment(cur, a.length)) return false
	const span = next.t - prev.t
	if (span <= 0) return false
	const u = (cur.t - prev.t) / span
	return a.every((v, d) => Math.abs(v + (c[d] - v) * u - b[d]) < 1e-6)
}

// 4. Keys outside a layer's visible time range, keeping one on each side.
export function trimToLayerRange(json) {
	let n = 0
	for (const layers of layerLists(json)) {
		// a parent's transform is still read while its children are visible
		const parents = new Set(layers.map((L) => L.parent).filter((v) => v != null))
		for (const L of layers) {
			if (L.ip == null || L.op == null || L.tm || parents.has(L.ind)) continue
			// layer keyframes are in the parent comp's time, like ip/op (st only shifts a precomp's contents)
			const from = L.ip,
				to = L.op
			const trim = (p) => {
				if (!isAnimated(p)) return
				const k = p.k
				let lo = 0,
					hi = k.length - 1
				while (lo + 1 < k.length && k[lo + 1].t <= from) lo++
				while (hi - 1 >= 0 && k[hi - 1].t >= to) hi--
				if (lo === 0 && hi === k.length - 1) return
				n += k.length - (hi - lo + 1)
				p.k = k.slice(lo, hi + 1)
				// one key left means one value for the whole visible range; players treat a
				// single-key animated property inconsistently, so store it as static
				if (p.k.length === 1 && p.k[0].s !== undefined && !isObj(p.k[0].s)) {
					const v = p.k[0].s
					p.k = Array.isArray(v) && v.length === 1 ? v[0] : v
					p.a = 0
				}
			}
			forEachProp(L.ks, trim)
			forEachProp(L.shapes, trim)
			forEachProp(L.masksProperties, trim)
			forEachProp(L.ef, trim)
		}
	}
	return n
}

// Layers other layers point at (parents, matte sources) must stay.
function referencedIndices(layers) {
	const keep = new Set()
	layers.forEach((L, i) => {
		if (L.parent != null) keep.add(L.parent)
		if (L.tp != null) keep.add(L.tp)
		if (L.tt && i > 0 && layers[i - 1].ind != null) keep.add(layers[i - 1].ind) // matte above
	})
	return keep
}

// 5. Hidden layers and shape items.
export function removeHidden(json) {
	let n = 0
	for (const layers of layerLists(json)) {
		const keep = referencedIndices(layers)
		for (let i = layers.length - 1; i >= 0; i--) {
			const L = layers[i]
			if (L.hd === true && !L.td && !keep.has(L.ind)) {
				layers.splice(i, 1)
				n++
			}
		}
		for (const L of layers)
			for (const items of shapeLists(L))
				for (let i = items.length - 1; i >= 0; i--)
					if (items[i] && items[i].hd === true) {
						items.splice(i, 1)
						n++
					}
	}
	return n
}

// 6. Layers that can never be seen: empty time range, or static opacity 0.
export function removeDeadLayers(json) {
	let n = 0
	for (const layers of layerLists(json)) {
		const keep = referencedIndices(layers)
		for (let i = layers.length - 1; i >= 0; i--) {
			const L = layers[i]
			if (L.td || keep.has(L.ind)) continue
			const o = L.ks && L.ks.o
			const invisible = o && !isAnimated(o) && !o.x && Number(asArray(o.k)[0]) === 0
			const empty = L.ip != null && L.op != null && L.op <= L.ip
			if (invisible || empty) {
				layers.splice(i, 1)
				n++
			}
		}
	}
	return n
}

// 7. Assets nothing references (followed through precomps from the root).
export function removeUnusedAssets(json) {
	if (!Array.isArray(json.assets)) return 0
	const byId = new Map(json.assets.map((a) => [a.id, a]))
	const used = new Set()
	const visit = (layers) => {
		for (const L of layers || []) {
			if (L.refId == null || used.has(L.refId)) continue
			used.add(L.refId)
			const a = byId.get(L.refId)
			if (a && a.layers) visit(a.layers)
		}
	}
	visit(json.layers)
	const before = json.assets.length
	json.assets = json.assets.filter((a) => used.has(a.id))
	return before - json.assets.length
}

// 8. Identical assets (precomps by content, images by source) merged into one.
export function dedupeAssets(json) {
	if (!Array.isArray(json.assets)) return 0
	const seen = new Map()
	const remap = new Map()
	for (const a of json.assets) {
		const { id, nm, ...rest } = a
		const key = JSON.stringify(rest)
		if (seen.has(key)) remap.set(id, seen.get(key))
		else seen.set(key, id)
	}
	if (!remap.size) return 0
	// Remapping can make two precomps identical in turn; one round is enough in practice.
	// ponytail: single round; loop until stable if nested duplicate precomps show up.
	for (const layers of layerLists(json))
		for (const L of layers) if (remap.has(L.refId)) L.refId = remap.get(L.refId)
	json.assets = json.assets.filter((a) => !remap.has(a.id))
	return remap.size
}

// 9. Static scalar values stored as one-element arrays.
export function unwrapScalars(json) {
	let n = 0
	forEachProp(json, (p) => {
		if (isAnimated(p)) return
		if (Array.isArray(p.k) && p.k.length === 1 && typeof p.k[0] === 'number') {
			p.k = p.k[0]
			n++
		}
	})
	return n
}

// 10. Keyframe fields no player reads: tangents on hold keys and on the last key,
// and legacy `e` end values (every modern player reads the next key's `s`).
export function trimKeyframeFields(json) {
	let n = 0
	forEachProp(json, (p) => {
		if (!isAnimated(p)) return
		const k = p.k
		k.forEach((kf, j) => {
			const last = j === k.length - 1
			if (kf.h === 1 || last) {
				for (const f of ['i', 'o', 'to', 'ti']) if (f in kf) (delete kf[f], n++)
			}
			if ('e' in kf && (!last ? k[j + 1].s !== undefined : true)) {
				delete kf.e
				n++
			}
			if (last && kf.h === 1) (delete kf.h, n++)
			// a linear segment written with the shortest tangents (0 and 1), same shape kept
			if (!last && kf.i && kf.o && isLinearSegment(kf, 4)) {
				const to = (v, n01) => (Array.isArray(v) ? v.map(() => n01) : n01)
				const o = { x: to(kf.o.x, 0), y: to(kf.o.y, 0) },
					i = { x: to(kf.i.x, 1), y: to(kf.i.y, 1) }
				if (JSON.stringify(o) !== JSON.stringify(kf.o) || JSON.stringify(i) !== JSON.stringify(kf.i)) {
					kf.o = o
					kf.i = i
					n++
				}
			}
		})
	})
	return n
}

// Fields equal to what every player assumes when they are missing: zero skew (and its
// axis), auto-orient off, empty names/match names, an empty glyph list.
// Transform values every player fills in when missing (checked in lottie-web, lottie-
// android, lottie-ios and ThorVG source). A shape group's opacity stays: lottie-web's
// canvas renderer reads it without a fallback.
function dropDefaultTransform(t, keepOpacity) {
	let n = 0
	const is = (p, d) => p && !isAnimated(p) && !p.x && asArray(p.k).every((v, i) => Math.abs(v - (d[i] != null ? d[i] : d[d.length - 1])) < EPS)
	const drop = (k, d) => is(t[k], d) && (delete t[k], n++)
	if (t.p && t.p.s) {
		if (is(t.p.x, [0]) && is(t.p.y, [0]) && (!t.p.z || is(t.p.z, [0]))) (delete t.p, n++)
	} else drop('p', [0])
	drop('a', [0])
	drop('s', [100])
	drop('r', [0])
	if (!keepOpacity) drop('o', [100])
	return n
}

export function removeDefaults(json) {
	let n = 0
	const zero = (p) => p && !isAnimated(p) && !p.x && Number(asArray(p.k)[0]) === 0
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk)
		if (!isObj(node)) return
		if (node.ty === 'tr') n += dropDefaultTransform(node, true)
		else if (typeof node.ty === 'number' && isObj(node.ks)) n += dropDefaultTransform(node.ks, false)
		if (zero(node.sk) && (!node.sa || zero(node.sa))) {
			delete node.sk
			delete node.sa
			n++
		}
		if (node.ao === 0) (delete node.ao, n++)
		for (const k of ['nm', 'mn']) if (node[k] === '') (delete node[k], n++)
		for (const k in node) if (!isProp(node[k])) walk(node[k])
	}
	walk(json.layers)
	for (const a of json.assets || []) walk(a.layers)
	if (Array.isArray(json.chars) && !json.chars.length) (delete json.chars, n++)
	return n
}

const isIdentity = (ks) => {
	if (!ks) return true
	const val = (p, d) => (p ? (!isAnimated(p) && !p.x ? asArray(p.k) : null) : asArray(d))
	const same = (v, ref) => v && ref.every((r, i) => Math.abs((v[i] != null ? v[i] : r) - r) < EPS)
	let pos
	if (ks.p && ks.p.s) pos = [val(ks.p.x, 0), val(ks.p.y, 0)].every((v) => same(v, [0]))
	else pos = same(val(ks.p, [0, 0, 0]), [0, 0, 0])
	return (
		pos &&
		same(val(ks.a, [0, 0, 0]), [0, 0, 0]) &&
		same(val(ks.s, [100, 100, 100]), [100, 100, 100]) &&
		same(val(ks.r, [0]), [0]) &&
		same(val(ks.sk, [0]), [0]) &&
		!ks.rx && !ks.ry && !ks.rz && !ks.or
	)
}

// Null layers whose transform is the identity (Cavalry wraps every comp in one) add
// nothing: their children are re-parented to the null's own parent and the null goes.
export function removeIdentityNulls(json) {
	let n = 0
	for (const layers of layerLists(json)) {
		for (let i = layers.length - 1; i >= 0; i--) {
			const L = layers[i]
			if (L.ty !== 3 || L.ind == null || !isIdentity(L.ks)) continue
			if (layers.some((o) => o.tp === L.ind)) continue
			const up = layers.find((o) => o.ind === L.parent)
			if (L.parent != null && !up) continue // dangling parent: leave it alone
			for (const o of layers) {
				if (o.parent !== L.ind) continue
				if (L.parent != null) o.parent = L.parent
				else delete o.parent
			}
			layers.splice(i, 1)
			n++
		}
	}
	return n
}

// A layer that draws something (shape geometry, precomp, solid, image, text).
const drawsSomething = (L) => L.ty !== 4 ? L.ty !== 3 : /"ty":"(sh|rc|el|sr)"/.test(JSON.stringify(L.shapes || []))

// Apply fn to a property's value(s): the static value, or every key's s/e.
function mapValues(p, fn) {
	if (!p) return p
	if (!isAnimated(p)) return Object.assign({}, p, { k: fn(asArray(p.k)) })
	return Object.assign({}, p, { k: p.k.map((kf) => Object.assign({}, kf, kf.s ? { s: fn(kf.s) } : {}, kf.e ? { e: fn(kf.e) } : {})) })
}
const staticOf = (p, d) => (p && !isAnimated(p) ? asArray(p.k) : p ? null : d)

// Parent layers that draw nothing and never move (Cavalry exports every group as one)
// are folded into their children: the child gets the combined transform and the parent
// goes. Exact when the parent's scale is uniform or the child doesn't rotate; skipped
// otherwise, and for anything animated in the parent, skew, 3D and auto-orient.
export function foldStaticParents(json) {
	let n = 0
	for (const layers of layerLists(json)) {
		let changed = true
		while (changed) {
			changed = false
			for (let i = layers.length - 1; i >= 0; i--) {
				const P = layers[i]
				if (P.ind == null || drawsSomething(P) || P.td || P.tt || P.ddd === 1 || layers.some((o) => o.tp === P.ind)) continue
				const ks = P.ks || {}
				if (JSON.stringify(ks).indexOf('"x":"') >= 0) continue // expressions
				const pp = ks.p && ks.p.s ? [staticOf(ks.p.x, [0]), staticOf(ks.p.y, [0])] : [staticOf(ks.p, [0, 0])]
				if (pp.some((v) => !v)) continue
				const pos = ks.p && ks.p.s ? [pp[0][0], pp[1][0]] : pp[0]
				const a = staticOf(ks.a, [0, 0]), sc = staticOf(ks.s, [100, 100]), rr = staticOf(ks.r, [0]), sk = staticOf(ks.sk, [0])
				if (!a || !sc || !rr || !sk || Math.abs(sk[0]) > EPS || ks.rx || ks.ry || ks.rz || ks.or) continue
				const kids = layers.filter((o) => o.parent === P.ind)
				const rad = (rr[0] * Math.PI) / 180, c = Math.cos(rad), sn = Math.sin(rad)
				const sx = (sc[0] != null ? sc[0] : 100) / 100, sy = (sc[1] != null ? sc[1] : sx * 100) / 100
				const uniform = Math.abs(sx - sy) < EPS
				const map = (q) => {
					const X = (q[0] - (a[0] || 0)) * sx, Y = ((q[1] || 0) - (a[1] || 0)) * sy
					return [pos[0] + c * X - sn * Y, (pos[1] || 0) + sn * X + c * Y]
				}
				const ok = kids.every((C) => {
					const k = C.ks || {}
					if (C.ao === 1 || C.ddd === 1 || (k.sk && (isAnimated(k.sk) || Math.abs(asArray(k.sk.k)[0] || 0) > EPS))) return false
					const rotates = k.r && (isAnimated(k.r) || Math.abs(asArray(k.r.k)[0] || 0) > EPS)
					if (!uniform && rotates) return false
					if (k.p && k.p.s && (isAnimated(k.p.x) || isAnimated(k.p.y)) && Math.abs(rr[0]) > EPS) return false
					return !JSON.stringify(k).includes('"x":"')
				})
				if (!ok) continue
				for (const C of kids) {
					const k = (C.ks = C.ks || {})
					if (k.p && k.p.s) {
						if (Math.abs(rr[0]) < EPS) {
							k.p.x = mapValues(k.p.x, (v) => [pos[0] + (v[0] - (a[0] || 0)) * sx])
							k.p.y = mapValues(k.p.y, (v) => [(pos[1] || 0) + (v[0] - (a[1] || 0)) * sy])
						} else {
							const q = map([asArray(k.p.x.k)[0], asArray(k.p.y.k)[0]])
							k.p.x = { a: 0, k: q[0] }
							k.p.y = { a: 0, k: q[1] }
						}
					} else {
						const lin = (v) => [c * v[0] * sx - sn * (v[1] || 0) * sy, sn * v[0] * sx + c * (v[1] || 0) * sy]
						k.p = mapValues(k.p || { a: 0, k: [0, 0, 0] }, (v) => map(v).concat(v.length > 2 ? [v[2]] : []))
						if (isAnimated(k.p)) k.p.k.forEach((kf) => ['to', 'ti'].forEach((f) => kf[f] && (kf[f] = lin(kf[f]).concat(kf[f].length > 2 ? [kf[f][2]] : []))))
					}
					k.r = mapValues(k.r || { a: 0, k: 0 }, (v) => [v[0] + rr[0]])
					k.s = mapValues(k.s || { a: 0, k: [100, 100, 100] }, (v) => [v[0] * sx, (v[1] != null ? v[1] : v[0]) * sy].concat(v.length > 2 ? [v[2]] : []))
					if (P.parent != null) C.parent = P.parent
					else delete C.parent
				}
				layers.splice(i, 1)
				n++
				changed = true
			}
		}
	}
	return n
}

// A shape group's transform item is the identity (and it isn't faded).
function identityTr(tr) {
	if (!tr) return true
	const is = (p, d) => !p || (!isAnimated(p) && !p.x && asArray(p.k).every((v, i) => Math.abs(v - (d[i] != null ? d[i] : d[0])) < EPS))
	return is(tr.p, [0, 0]) && is(tr.a, [0, 0]) && is(tr.s, [100, 100]) && is(tr.r, [0]) && is(tr.o, [100]) && is(tr.sk, [0]) && !tr.rx && !tr.ry && !tr.rz
}

// Cavalry wraps every path in groups inside groups, each with a full transform. A group
// that is the only item at its level (besides an identity transform) and whose own
// transform is the identity can give its items to the level above: fills, strokes and
// modifiers still apply to exactly the same paths, in the same order, so nothing drawn
// or animated changes.
export function flattenShapeGroups(json) {
	let n = 0
	// top: the layer's own shape list, which has no transform item to take a group's over
	const flatten = (items, top) => {
		if (!Array.isArray(items)) return items
		for (const it of items) if (it && it.ty === 'gr') it.it = flatten(it.it, false)
		for (;;) {
			const rest = items.filter((it) => it.ty !== 'tr')
			const ownTr = items.find((it) => it.ty === 'tr')
			if (rest.length !== 1 || rest[0].ty !== 'gr') return items
			const g = rest[0]
			if (g.hd || (g.bm && g.bm !== 0) || !Array.isArray(g.it)) return items
			const inner = g.it.find((it) => it.ty === 'tr')
			// an identity inner group adds nothing, whatever this level's transform is
			if (identityTr(inner)) items = g.it.filter((it) => it.ty !== 'tr').concat(ownTr ? [ownTr] : [])
			else if (!top && identityTr(ownTr)) items = g.it.slice() // the inner transform replaces this level's identity one
			else return items
			n++
		}
	}
	for (const layers of layerLists(json)) for (const L of layers) if (Array.isArray(L.shapes)) L.shapes = flatten(L.shapes, true)
	return n
}

// Names that expressions look up ("thisComp.layer('Name')", effect('Slider'), ...).
function namesUsedByExpressions(json) {
	const names = new Set()
	const scan = (node) => {
		if (Array.isArray(node)) return node.forEach(scan)
		if (!isObj(node)) return
		for (const k in node) {
			const v = node[k]
			if (k === 'x' && typeof v === 'string') {
				const re = /(['"])((?:\\.|(?!\1).)*)\1/g
				let m
				while ((m = re.exec(v))) names.add(m[2])
			} else scan(v)
		}
	}
	scan(json)
	return names
}

// 11. Metadata. opts: {names, matchNames, markers, keepNames: [..]}
export function stripMeta(json, opts = {}) {
	let n = 0
	const keepNames = new Set([...(opts.keepNames || []), ...namesUsedByExpressions(json)])
	const drop = new Set(['ln', 'cl'])
	if (opts.matchNames) drop.add('mn')
	const walk = (node, inEffects) => {
		if (Array.isArray(node)) return node.forEach((v) => walk(v, inEffects))
		if (!isObj(node)) return
		for (const k of Object.keys(node)) {
			if (drop.has(k) && !(k === 'mn' && inEffects && opts.keepEffectMatchNames)) {
				delete node[k]
				n++
			} else if (k === 'nm' && opts.names && typeof node.nm === 'string' && !keepNames.has(node.nm)) {
				delete node.nm
				n++
			} else walk(node[k], inEffects || k === 'ef')
		}
	}
	walk(json, false)
	if ('meta' in json) (delete json.meta, n++)
	if (opts.markers && Array.isArray(json.markers)) (delete json.markers, n++)
	return n
}

// ---------- lossy passes ----------

// What a property measures, from its key and the shape item that holds it; picks the
// tolerance and the decimals.
function category(key, owner) {
	const ty = owner && owner.ty
	if (key === 'tm' && typeof ty === 'number') return 'time' // a layer's time remap, in seconds
	switch (key) {
		case 'c':
		case 'g':
			return 'color'
		case 'o':
			return ty === 'tm' ? 'angle' : 'opacity'
		case 'r':
			return ty === 'rc' ? 'px' : 'angle'
		case 'sk':
		case 'sa':
			return 'angle'
		case 's':
			if (ty === 'rc' || ty === 'el' || ty === 'gf' || ty === 'gs') return 'px' // sizes, gradient start
			if (ty === 'tm') return 'opacity'
			return 'scale'
		case 'e':
			return ty === 'tm' ? 'opacity' : 'px'
		default:
			return 'px'
	}
}

// ---------- accuracy on screen ----------
// Lossy passes work to `accuracy`: the most any point may move, in output pixels (comp
// pixels × `display`, the size the animation plays at). Each layer's own units come from
// how big it is drawn: its scale and its parents' and precomps' (the largest over time),
// and for angles and scales its size. The error budget is shared so the passes' errors
// can't add up past accuracy: moving shapes 25%, keyframe and path fitting 70%, rounding 5% (rounding saves little, and edges show it first).
export const BUDGET = { rigid: 0.25, fit: 0.7, round: 0.05 }

function maxScale(p) {
	if (!p) return 1
	const vals = isAnimated(p) ? p.k.map((k) => k.s).filter((v) => v !== undefined) : [p.k]
	let m = 0
	for (const v of vals) {
		const a = asArray(v)
		m = Math.max(m, Math.abs(a[0] != null ? a[0] : 100), Math.abs(a[1] != null ? a[1] : a[0] != null ? a[0] : 100))
	}
	return Math.max(m / 100, 1e-3)
}

const first = (p) => (!p ? null : isAnimated(p) ? p.k[0].s : p.k)

// How far a layer's content reaches from its anchor, in the layer's own pixels.
function layerRadius(L, json, assets) {
	const a = asArray(first(L.ks && L.ks.a))
	const ax = a[0] || 0, ay = a[1] || 0
	let r = 0
	const box = (w, h) => [[0, 0], [w, 0], [0, h], [w, h]].forEach((c) => (r = Math.max(r, Math.hypot(c[0] - ax, c[1] - ay))))
	if (L.ty === 4) {
		// a group's anchor lands within `base` of the layer anchor; its content is scaled by k.
		// Rotation is bounded, not applied, so this can only overestimate.
		const walk = (items, base, k, gx, gy) => {
			const at = (q) => (r = Math.max(r, base + k * Math.hypot(q[0] - gx, q[1] - gy)))
			for (const it of items || []) {
				if (!it) continue
				if (it.ty === 'gr') {
					const tr = (it.it || []).find((x) => x && x.ty === 'tr') || {}
					const p = asArray(first(tr.p)), ga = asArray(first(tr.a))
					walk(it.it, base + k * Math.hypot((p[0] || 0) - gx, (p[1] || 0) - gy), k * maxScale(tr.s), ga[0] || 0, ga[1] || 0)
				} else if (it.ty === 'sh') {
					for (const sh of asArray(first(it.ks))) if (sh && sh.v) sh.v.forEach(at)
				} else if (it.ty === 'rc' || it.ty === 'el') {
					const c = asArray(first(it.p)), sz = asArray(first(it.s))
					at([(c[0] || 0) + (sz[0] || 0) / 2, (c[1] || 0) + (sz[1] || 0) / 2])
					at([(c[0] || 0) - (sz[0] || 0) / 2, (c[1] || 0) - (sz[1] || 0) / 2])
				} else if (it.ty === 'sr') {
					const c = asArray(first(it.p))
					r = Math.max(r, base + k * (Math.hypot((c[0] || 0) - gx, (c[1] || 0) - gy) + (asArray(first(it.or))[0] || 0)))
				}
			}
		}
		walk(L.shapes, 0, 1, ax, ay)
	} else if (L.ty === 0 && L.w) box(L.w, L.h)
	else if (L.ty === 1) box(L.sw || 0, L.sh || 0)
	else if (L.ty === 2 && assets[L.refId]) box(assets[L.refId].w || 0, assets[L.refId].h || 0)
	return r > EPS ? r : Math.hypot(json.w || 1000, json.h || 1000) / 2
}

// Map layer -> { scale, parent, radius }: world scale of the layer's content and of the
// space its transform sits in, both × display.
function layerContexts(json, display) {
	const assets = {}
	for (const a of json.assets || []) assets[a.id] = a
	const assetScale = {}
	const ctx = new Map()
	const visit = (layers, outer) => {
		const byInd = new Map(layers.map((L) => [L.ind, L]))
		const memo = new Map()
		const world = (L, depth) => {
			if (memo.has(L)) return memo.get(L)
			const par = L.parent != null && depth < 64 ? byInd.get(L.parent) : null
			const w = (par ? world(par, depth + 1) : outer) * maxScale(L.ks && L.ks.s)
			memo.set(L, w)
			return w
		}
		// a parent's size includes its children's: turning or scaling it moves them too
		const kids = new Map()
		for (const L of layers) if (L.parent != null && byInd.has(L.parent)) kids.set(L.parent, (kids.get(L.parent) || []).concat([L]))
		const reach = new Map()
		const radius = (L, depth) => {
			if (reach.has(L)) return reach.get(L)
			let r = L.ty === 3 ? 0 : layerRadius(L, json, assets)
			const a = asArray(first(L.ks && L.ks.a))
			for (const c of depth < 64 ? kids.get(L.ind) || [] : []) {
				const cp = c.ks && c.ks.p
				const p = cp && cp.s ? [asArray(first(cp.x))[0], asArray(first(cp.y))[0]] : asArray(first(cp)) // split x/y position
				r = Math.max(r, Math.hypot((p[0] || 0) - (a[0] || 0), (p[1] || 0) - (a[1] || 0)) + radius(c, depth + 1) * maxScale(c.ks && c.ks.s))
			}
			if (r < EPS) r = layerRadius(L, json, assets)
			reach.set(L, r)
			return r
		}
		for (const L of layers) {
			const par = L.parent != null ? byInd.get(L.parent) : null
			const scale = world(L, 0)
			ctx.set(L, { scale: scale * display, parent: (par ? world(par, 1) : outer) * display, radius: radius(L, 0) })
			if (L.ty === 0 && L.refId != null) assetScale[L.refId] = Math.max(assetScale[L.refId] || 0, scale)
		}
	}
	// precomps can nest: repeat until every asset's scale (the largest use) settles
	for (let pass = 0; pass < 8; pass++) {
		const before = JSON.stringify(assetScale)
		visit(json.layers || [], 1)
		for (const a of json.assets || []) if (Array.isArray(a.layers)) visit(a.layers, assetScale[a.id] || 1)
		if (JSON.stringify(assetScale) === before) break
	}
	return ctx
}

// Tolerance per kind of value, in the property's own units, for the space `base` scales.
// opts.tolerance (per kind, in property units) overrides the screen-space value.
function toleranceFor(opts, json, c, base, share) {
	const acc = (opts.accuracy != null ? opts.accuracy : 0.25) * share
	const fixed = opts.tolerance || {}
	const deg = (rad) => (rad * 180) / Math.PI
	return (kind) => {
		if (fixed[kind] != null) return fixed[kind]
		switch (kind) {
			case 'px':
				return acc / base
			case 'angle':
				return Math.min(5 * share, deg(acc / (c.radius * c.scale)))
			case 'scale':
				return Math.min(5 * share, (100 * acc) / (c.radius * base))
			// flat colour and opacity don't shift edges, so rounding takes a bigger share
			case 'opacity':
				return 2 * acc * Math.max(1, 0.2 / share) // 0.5% at ¼ px for fitting
			case 'color':
				return 0.016 * acc * Math.max(1, 0.2 / share)
			// how far a time error moves things depends on the precomp's motion, which isn't
			// known here: round only, never fit (see simplifyKeys)
			case 'time':
				return 2e-5
		}
		return acc / base
	}
}

// Every property, with a tolerance function for its layer and space and the group-scale
// multiplier it sits under. fn(prop, key, owner, tol, layer)
function forEachLayerProp(json, opts, share, fn) {
	const ctx = layerContexts(json, opts.display || 1)
	for (const layers of layerLists(json))
		for (const L of layers) {
			const c = ctx.get(L)
			const own = toleranceFor(opts, json, c, c.parent, share)
			const inner = (mult) => toleranceFor(opts, json, c, c.scale * mult, share)
			// an anchor sits in the space its transform scales, unlike the rest of the transform
			if (L.ks) forEachProp(L.ks, (p, key, owner) => fn(p, key, owner, key === 'a' ? inner(1) : own, L), 'ks', L)
			for (const k in L) {
				if (k === 'ks' || k === 'shapes') continue
				forEachProp(L[k], (p, key, owner) => fn(p, key, owner, inner(1), L), k, L)
			}
			const walk = (items, mult) => {
				if (!Array.isArray(items)) return
				const tol = inner(mult)
				for (const it of items) {
					if (it && it.ty === 'gr') {
						const tr = (it.it || []).find((x) => x && x.ty === 'tr')
						const m = mult * maxScale(tr && tr.s)
						if (tr) forEachProp(tr, (p, key, owner) => fn(p, key, owner, key === 'a' ? inner(m) : tol, L), 'tr', it.it)
						walk((it.it || []).filter((x) => x !== tr), m)
						for (const k in it) if (k !== 'it') forEachProp(it[k], (p, key, owner) => fn(p, key, owner, tol, L), k, it)
					} else forEachProp(it, (p, key, owner) => fn(p, key, owner, tol, L), undefined, items)
				}
			}
			walk(L.shapes, 1)
		}
}

// Decimals whose rounding (at most half a unit of the last place) stays within tol.
const decimalsFor = (tol) => Math.min(5, Math.max(0, Math.ceil(-Math.log10(2 * tol))))

// A keyframe value as a flat list of numbers (shapes: every vertex and tangent).
function flatten(s) {
	if (typeof s === 'number') return [s]
	if (!Array.isArray(s)) return null
	if (s.length && isObj(s[0])) {
		const out = []
		for (const sh of s) {
			if (!sh.v) return null
			for (const f of ['v', 'i', 'o']) for (const pt of sh[f]) out.push(pt[0], pt[1])
			out.push(sh.c ? 1 : 0)
		}
		return out
	}
	return s.every((v) => typeof v === 'number') ? s : null
}

// Smallest one-frame change that counts as a jump, per kind of value.
const JUMP = { px: 2, scale: 2, angle: 2, opacity: 5, color: 0.05 }

// Cavalry and After Effects show whole frames; Lottie players draw in-between frames on
// fast displays. A value that jumps from one frame to the next (a baked path wrapping
// round, a layer snapping into place) then slides instead. Hold the key before each
// one-frame jump. opts.all holds every one-frame key, so playback steps exactly like
// Cavalry's frames.
export function holdJumps(json, opts = {}) {
	let n = 0
	forEachProp(json, (p, key, owner) => {
		if (!isAnimated(p) || p.k.length < 2) return
		const k = p.k
		const vals = k.map((kf) => (kf.s === undefined ? null : flatten(kf.s)))
		const rate = (i) => {
			if (!vals[i] || !vals[i + 1] || k[i].h === 1 || vals[i].length !== vals[i + 1].length) return null
			let d = 0
			for (let x = 0; x < vals[i].length; x++) d = Math.max(d, Math.abs(vals[i + 1][x] - vals[i][x]))
			return d / Math.max(k[i + 1].t - k[i].t, 1e-9)
		}
		const rates = k.slice(0, -1).map((_, i) => rate(i))
		const min = JUMP[category(key, owner)]
		for (let i = 0; i < k.length - 1; i++) {
			if (k[i + 1].t - k[i].t > 1 + EPS || rates[i] == null || k[i].h === 1) continue
			const around = [rates[i - 1], rates[i + 1]].filter((v) => v != null)
			const jump = rates[i] > min && rates[i] > 5 * Math.max(0, ...around)
			if (!opts.all && !jump) continue
			if (!opts.all && !(rates[i] > 0)) continue
			k[i].h = 1
			delete k[i].i
			delete k[i].o
			n++
		}
	})
	return n
}

// Keyframe fitting: replaces runs of frame-by-frame (baked) or linear keys with as few
// keys as possible, each segment eased with a fitted bezier, staying within tolerance of
// every original key (and every frame of a long linear segment). All of a value's parts
// share one ease, as players interpolate them: a path morphing along straight lines (any
// vertices, one ease) fits as well as a number. Positions moving along a curve get a
// motion path (`to`/`ti`). Authored eased keys, holds and existing motion paths stay.
export function simplifyKeys(json, opts = {}) {
	let n = 0
	forEachLayerProp(json, opts, BUDGET.fit, (p, key, owner, tolFor, L) => {
		if (!isAnimated(p) || p.k.length < 3 || p.x) return
		const k = p.k
		const vals = k.map((kf) => (kf.s === undefined ? null : flatten(kf.s)))
		if (vals.some((v) => !v || v.length !== vals[0].length)) return
		const shape = Array.isArray(k[0].s) && isObj(k[0].s[0])
		const dims = Array.isArray(k[0].s) && !shape ? k[0].s.length : 1
		const kind = category(key, owner)
		if (kind === 'time') return
		const tol = tolFor(kind)
		const motionPath = key === 'p' && !shape && (dims === 2 || (dims === 3 && vals.every((v) => Math.abs(v[2] - vals[0][2]) < EPS)))
		const fittable = (j) => k[j].h !== 1 && !hasSpatial(k[j]) && (k[j + 1].t - k[j].t <= 1 + EPS || isLinearSegment(k[j], dims))

		// the original's value part-way (u) through segment j, with its own ease
		const between = (j, u) => {
			const kf = k[j]
			const lin = isLinearSegment(kf, dims)
			return vals[j].map((v, d) => {
				const c = shape ? 0 : d % dims
				const y = lin ? u : easeAt({ x1: component(kf.o.x, c), y1: component(kf.o.y, c), x2: component(kf.i.x, c), y2: component(kf.i.y, c) }, u)
				return v + (vals[j + 1][d] - v) * y
			})
		}
		// samples (time, value) of the original between keys a and b
		const samples = (a, b) => {
			const ts = [], vs = []
			for (let j = a; j <= b; j++) {
				ts.push(k[j].t)
				vs.push(vals[j])
				const gap = j < b ? k[j + 1].t - k[j].t : 0
				// every half frame, so a curve can't swing out between the keys (players draw
				// in-between frames, and time-remapped precomps land between them too)
				const m = j < b ? Math.max(1, Math.min(64, Math.ceil(2 * gap) - 1)) : 0
				for (let q = 1; q <= m; q++) {
					const u = q / (m + 1)
					ts.push(k[j].t + gap * u)
					vs.push(between(j, u))
				}
			}
			return { ts, vs }
		}
		const fitSpan = (a, b) => {
			const { ts, vs } = samples(a, b)
			const A = vals[a], B = vals[b], t0 = k[a].t, span = k[b].t - t0
			const us = ts.map((t) => (t - t0) / span)
			const D = B.map((v, d) => v - A[d])
			const dd = D.reduce((m, v) => m + v * v, 0)
			const along = (e) => {
				let worst = 0
				for (let j = 0; j < vs.length; j++) {
					const y = easeAt(e, us[j])
					for (let d = 0; d < D.length; d++) worst = Math.max(worst, Math.abs(A[d] + D[d] * y - vs[j][d]))
				}
				return worst
			}
			if (dd < EPS) return along(LINEAR) <= tol ? { ease: LINEAR } : null
			const ps = vs.map((v) => v.reduce((m, x, d) => m + (x - A[d]) * D[d], 0) / dd)
			// a value off the straight line from A to B can't be reached by any ease
			let off = 0
			for (let j = 0; j < vs.length && off <= tol; j++) for (let d = 0; d < D.length; d++) off = Math.max(off, Math.abs(A[d] + D[d] * ps[j] - vs[j][d]))
			if (off <= tol) {
				const ease = fitEase(us, ps, along, tol)
				if (ease) return { ease }
			}
			if (!motionPath || vs.length < 4) return null
			return fitMotionPath(us, vs.map((v) => [v[0], v[1]]), tol)
		}
		const setEase = (kf, f) => {
			// shapes and motion-path keys take one ease (lottie-web reads them as plain numbers)
			const w = (v) => (shape || f.to ? v : new Array(dims).fill(v))
			kf.o = { x: w(f.ease.x1), y: w(f.ease.y1) }
			kf.i = { x: w(f.ease.x2), y: w(f.ease.y2) }
			delete kf.h
			delete kf.e
			if (f.to) {
				kf.to = dims === 3 ? f.to.concat(0) : f.to
				kf.ti = dims === 3 ? f.ti.concat(0) : f.ti
			}
		}

		const kept = [k[0]]
		for (let a = 0; a < k.length - 1; ) {
			if (!fittable(a)) {
				kept.push(k[++a])
				continue
			}
			let end = a
			while (end < k.length - 1 && fittable(end)) end++
			// furthest key that one segment from `a` can reach: double, then halve
			let good = a + 1, best = null, bad = null
			for (let step = 1; good < end; step *= 2) {
				const b = Math.min(good + step, end)
				const f = fitSpan(a, b)
				if (!f) {
					bad = b
					break
				}
				good = b
				best = f
			}
			while (bad != null && bad - good > 1) {
				const mid = (good + bad) >> 1
				const f = fitSpan(a, mid)
				if (f) (good = mid), (best = f)
				else bad = mid
			}
			if (best && good > a + 1) {
				setEase(k[a], best)
				n += good - a - 1
			}
			kept.push(k[good])
			a = good
		}
		p.k = kept
	})
	return n
}

// Least-squares 2D similarity (rotation, uniform scale, translation) mapping P onto Q.
function fitSimilarity(P, Q, allowScale) {
	const m = P.length
	let px = 0, py = 0, qx = 0, qy = 0
	for (let i = 0; i < m; i++) (px += P[i][0]), (py += P[i][1]), (qx += Q[i][0]), (qy += Q[i][1])
	;(px /= m), (py /= m), (qx /= m), (qy /= m)
	let a = 0, b = 0, pp = 0
	for (let i = 0; i < m; i++) {
		const x = P[i][0] - px, y = P[i][1] - py, u = Q[i][0] - qx, v = Q[i][1] - qy
		a += x * u + y * v
		b += x * v - y * u
		pp += x * x + y * y
	}
	const th = Math.atan2(b, a)
	const s = allowScale && pp > EPS ? Math.hypot(a, b) / pp : 1
	const c = Math.cos(th) * s, sn = Math.sin(th) * s
	const tx = qx - (c * px - sn * py), ty = qy - (sn * px + c * py)
	let err = 0
	for (let i = 0; i < m; i++) {
		const x = c * P[i][0] - sn * P[i][1] + tx, y = sn * P[i][0] + c * P[i][1] + ty
		err = Math.max(err, Math.hypot(x - Q[i][0], y - Q[i][1]))
	}
	return { th, s, tx, ty, err }
}

// Vertices plus tangent end points (tangents are relative in Lottie).
function shapePoints(shapes) {
	const pts = []
	for (const sh of shapes)
		sh.v.forEach((v, i) => {
			pts.push(v, [v[0] + sh.i[i][0], v[1] + sh.i[i][1]], [v[0] + sh.o[i][0], v[1] + sh.o[i][1]])
		})
	return pts
}

const isStaticIdentityTr = (tr) =>
	tr &&
	['p', 'a', 's', 'r', 'sk'].every((f) => !tr[f] || !isAnimated(tr[f])) &&
	(!tr.o || !isAnimated(tr.o)) &&
	(!tr.p || asArray(tr.p.k).every((v) => Math.abs(v) < EPS)) &&
	(!tr.a || asArray(tr.a.k).every((v) => Math.abs(v) < EPS)) &&
	(!tr.s || asArray(tr.s.k).every((v) => Math.abs(v - 100) < EPS)) &&
	(!tr.r || Math.abs(asArray(tr.r.k)[0] || 0) < EPS) &&
	(!tr.sk || Math.abs(asArray(tr.sk.k)[0] || 0) < EPS)

// Least-squares rotation + non-uniform scale (M = R·diag(sx, sy), Lottie's scale-then-
// rotate order) + translation mapping P onto Q: a full affine fit with its shear dropped.
function fitRotateScale(P, Q) {
	const m = P.length
	let px = 0, py = 0, qx = 0, qy = 0
	for (let i = 0; i < m; i++) (px += P[i][0]), (py += P[i][1]), (qx += Q[i][0]), (qy += Q[i][1])
	;(px /= m), (py /= m), (qx /= m), (qy /= m)
	let sxx = 0, sxy = 0, syy = 0, a = 0, b = 0, c = 0, d = 0
	for (let i = 0; i < m; i++) {
		const x = P[i][0] - px, y = P[i][1] - py, u = Q[i][0] - qx, v = Q[i][1] - qy
		sxx += x * x
		sxy += x * y
		syy += y * y
		a += u * x
		b += u * y
		c += v * x
		d += v * y
	}
	const det = sxx * syy - sxy * sxy
	if (Math.abs(det) < EPS) return null
	const m11 = (a * syy - b * sxy) / det, m12 = (b * sxx - a * sxy) / det
	const m21 = (c * syy - d * sxy) / det, m22 = (d * sxx - c * sxy) / det
	const th = Math.atan2(m21, m11), co = Math.cos(th), si = Math.sin(th)
	const sx = Math.hypot(m11, m21), sy = -si * m12 + co * m22
	const M = [co * sx, -si * sy, si * sx, co * sy]
	const tx = qx - (M[0] * px + M[1] * py), ty = qy - (M[2] * px + M[3] * py)
	let err = 0
	for (let i = 0; i < m; i++) {
		const x = M[0] * P[i][0] + M[1] * P[i][1] + tx, y = M[2] * P[i][0] + M[3] * P[i][1] + ty
		err = Math.max(err, Math.hypot(x - Q[i][0], y - Q[i][1]))
	}
	return { th, sx, sy, tx, ty, err }
}

// Baked shapes that only move, turn or scale (also squash and stretch): keep the first
// frame's path and animate the group's transform instead. Only for frame-by-frame bakes
// (every key ≤ 1 frame apart), where transform and vertex interpolation agree.
// ponytail: no shear (Lottie skew support varies by player); add sk/sa if bakes need it.
export function recoverRigidMotion(json, opts = {}) {
	const ctx = layerContexts(json, opts.display || 1)
	let tol
	let n = 0
	const visit = (items) => {
		if (!Array.isArray(items)) return
		for (const g of items) {
			if (!g || g.ty !== 'gr') continue
			visit(g.it)
			const it = g.it || []
			const tr = it.find((x) => x.ty === 'tr')
			const paths = it.filter((x) => x.ty === 'sh')
			if (!paths.length || !isStaticIdentityTr(tr)) continue
			if (!it.every((x) => ['sh', 'fl', 'st', 'tr'].includes(x.ty))) continue
			if (!paths.every((x) => isAnimated(x.ks) && !x.ks.x)) continue
			const times = paths[0].ks.k.map((kf) => kf.t)
			if (times.length < 2 || !paths.every((x) => x.ks.k.length === times.length && x.ks.k.every((kf, j) => kf.t === times[j] && kf.s)))
				continue
			if (times.some((t, j) => j && t - times[j - 1] > 1 + EPS)) continue
			const frameShapes = times.map((_, j) => paths.flatMap((x) => x.ks.k[j].s))
			const base = frameShapes[0]
			if (!frameShapes.every((f) => f.length === base.length && f.every((sh, i) => sh.v.length === base[i].v.length && !!sh.c === !!base[i].c)))
				continue
			const P = shapePoints(base)
			// pivot on the shape's centre so position only carries real movement
			const c = P.reduce((m, q) => [m[0] + q[0] / P.length, m[1] + q[1] / P.length], [0, 0])
			const stroked = it.some((x) => x.ty === 'st')
			const fits = []
			let ok = true,
				prev = 0
			for (const f of frameShapes) {
				const Q = shapePoints(f)
				let fit = fitSimilarity(P, Q, !stroked) // scaling a group scales its stroke
				if (fit.err > tol && !stroked) fit = fitRotateScale(P, Q) || fit
				if (fit.err > tol) {
					ok = false
					break
				}
				if (fit.sx == null) fit.sx = fit.sy = fit.s
				let deg = (fit.th * 180) / Math.PI
				while (deg - prev > 180) deg -= 360
				while (deg - prev < -180) deg += 360
				prev = deg
				const co = Math.cos(fit.th), sn = Math.sin(fit.th)
				const x = c[0] * fit.sx, y = c[1] * fit.sy
				fits.push({ p: [co * x - sn * y + fit.tx, sn * x + co * y + fit.ty], r: deg, s: [fit.sx * 100, fit.sy * 100] })
			}
			if (!ok) continue
			const ease = (j) => {
				const src = paths[0].ks.k[j]
				const kf = {}
				for (const f of ['i', 'o', 'h']) if (src[f] !== undefined) kf[f] = src[f]
				return kf
			}
			const keys = (get) => ({ a: 1, k: fits.map((f, j) => Object.assign({ t: times[j], s: get(f) }, ease(j))) })
			tr.a = { a: 0, k: c }
			tr.p = keys((f) => f.p)
			tr.r = keys((f) => [f.r])
			if (!stroked) tr.s = keys((f) => f.s)
			paths.forEach((x) => {
				x.ks = { a: 0, k: x.ks.k[0].s[0] }
			})
			n++
		}
	}
	for (const layers of layerLists(json))
		for (const L of layers) {
			const share = (opts.accuracy != null ? opts.accuracy : 0.25) * BUDGET.rigid
			tol = opts.tolerance != null ? opts.tolerance : share / ctx.get(L).scale
			visit(L.shapes)
		}
	return n
}

const roundTo = (v, d) => {
	const f = Math.pow(10, d)
	const r = Math.round(v * f) / f
	return r === 0 ? 0 : r // no -0
}
const roundDeep = (v, d) => {
	if (typeof v === 'number') return roundTo(v, d)
	if (Array.isArray(v)) return v.map((x) => roundDeep(x, d))
	if (isObj(v)) {
		const o = {}
		for (const k in v) o[k] = k === 'c' && typeof v[k] === 'boolean' ? v[k] : roundDeep(v[k], d)
		return o
	}
	return v
}

// Rounds every value to the fewest decimals whose rounding can't be seen at the target
// accuracy, worked out per layer and kind of value. opts.decimals fixes them per kind.
export function roundPrecision(json, opts = {}) {
	const fixed = opts.decimals || {}
	let n = 0
	forEachLayerProp(json, opts, BUDGET.round, (p, key, owner, tolFor) => {
		const kind = category(key, owner)
		const d = fixed[kind] != null ? fixed[kind] : decimalsFor(tolFor(kind))
		const dpx = fixed.px != null ? fixed.px : decimalsFor(tolFor('px'))
		n++
		if (!isAnimated(p)) {
			p.k = roundDeep(p.k, d)
			return
		}
		for (const kf of p.k) {
			if (kf.s !== undefined) kf.s = roundDeep(kf.s, d)
			if (kf.e !== undefined) kf.e = roundDeep(kf.e, d)
			if (kf.to) kf.to = roundDeep(kf.to, dpx)
			if (kf.ti) kf.ti = roundDeep(kf.ti, dpx)
			if (kf.i) kf.i = roundDeep(kf.i, 3)
			if (kf.o) kf.o = roundDeep(kf.o, 3)
			if (typeof kf.t === 'number') kf.t = roundTo(kf.t, 3)
		}
	})
	return n
}

// Removes path points that don't change the outline at the target accuracy: points on a
// straight line, doubled points and points along a smooth curve, refitting the curve
// either side. Only still paths; layers with modifiers that work per point (round
// corners, zig zag, pucker, offset) are left alone.
// ponytail: still paths only; animated paths would need the same points removed from every key.
export function simplifyPaths(json, opts = {}) {
	let n = 0
	const perPoint = new Map() // layer -> has a per-point modifier
	forEachLayerProp(json, opts, BUDGET.fit, (p, key, owner, tolFor, L) => {
		if (key !== 'ks' && key !== 'pt') return
		if (isAnimated(p) || !isObj(p.k) || !Array.isArray(p.k.v)) return
		if (!perPoint.has(L)) perPoint.set(L, /"ty":"(rd|zz|pb|op)"/.test(JSON.stringify(L.shapes || [])))
		if (perPoint.get(L)) return
		const r = simplifyPath(p.k, tolFor('px'))
		if (!r) return
		p.k = r.shape
		n += r.removed
	})
	return n
}

// Shape layers with identical content become one precomp used several times. Cavalry
// writes every duplicate (and every comp reference) out in full; After Effects exports
// share a precomp. The precomp is drawn offset by `pad` so content left or above the
// origin isn't clipped by the precomp's bounds, and the anchor moves by the same amount.
// ponytail: exact duplicates only; copies one frame apart (re-baked) aren't matched.
export function instanceLayers(json, opts = {}) {
	const minBytes = opts.minBytes != null ? opts.minBytes : 1000
	const pad = 2 * Math.max(json.w || 0, json.h || 0, 1000)
	let n = 0,
		next = 0
	const ids = new Set((json.assets || []).map((a) => a.id))
	const newId = () => {
		let id
		do id = 'inst_' + next++
		while (ids.has(id))
		ids.add(id)
		return id
	}
	for (const layers of layerLists(json)) {
		const parents = new Set(layers.map((L) => L.parent).filter((v) => v != null))
		const groups = new Map()
		layers.forEach((L, i) => {
			if (L.ty !== 4 || L.tt || L.td || L.tp != null || L.ddd === 1 || L.ao === 1 || parents.has(L.ind)) return
			if ((L.masksProperties && L.masksProperties.length) || (L.ef && L.ef.length)) return
			const key = JSON.stringify({ shapes: L.shapes, ip: L.ip, op: L.op, st: L.st, sr: L.sr })
			if (key.length < minBytes || key.indexOf('"x":"') >= 0) return
			if (!groups.has(key)) groups.set(key, [])
			groups.get(key).push(i)
		})
		for (const idx of groups.values()) {
			if (idx.length < 2) continue
			const first = layers[idx[0]]
			const id = newId()
			const inner = {
				ty: 4,
				ind: 1,
				nm: first.nm,
				ip: first.ip,
				op: first.op,
				st: first.st || 0,
				sr: first.sr || 1,
				ks: { p: { a: 0, k: [pad, pad, 0] } },
				shapes: first.shapes,
			}
			json.assets = json.assets || []
			json.assets.push({ id, nm: first.nm, layers: [inner] })
			for (const i of idx) {
				const L = layers[i]
				const ks = Object.assign({}, L.ks)
				ks.a = shiftAnchor(ks.a, pad)
				const outer = { ty: 0, refId: id, w: 2 * pad, h: 2 * pad, ind: L.ind, ip: L.ip, op: L.op, st: 0, sr: 1, ks }
				for (const f of ['nm', 'parent', 'bm', 'hd']) if (L[f] !== undefined) outer[f] = L[f]
				layers[i] = outer
			}
			n += idx.length - 1
		}
	}
	return n
}

function shiftAnchor(a, pad) {
	const add = (v) => {
		const out = asArray(v).slice()
		out[0] = (out[0] || 0) + pad
		out[1] = (out[1] || 0) + pad
		return out
	}
	if (!a) return { a: 0, k: [pad, pad, 0] }
	if (!isAnimated(a)) return Object.assign({}, a, { k: add(a.k) })
	return Object.assign({}, a, {
		k: a.k.map((kf) => Object.assign({}, kf, kf.s ? { s: add(kf.s) } : {}, kf.e ? { e: add(kf.e) } : {})),
	})
}

// ---------- serialising ----------

// Shortest text for a number. With `exponent`, 0.000001 -> 1e-6 and 12300000 -> 123e5.
export function formatNumber(v, exponent) {
	if (!isFinite(v)) return 'null'
	let s = String(v)
	if (!exponent) return s
	if (Number.isInteger(v)) {
		const m = /^(-?\d*?[1-9])(0{3,})$/.exec(s)
		if (m) {
			const e = m[1] + 'e' + m[2].length
			if (e.length < s.length) s = e
		}
		return s
	}
	const m = /^(-?)0\.(0{3,})(\d+)$/.exec(s)
	if (m) {
		const e = m[1] + m[3] + 'e-' + (m[2].length + m[3].length)
		if (e.length < s.length) s = e
	}
	return s
}

// JSON.stringify, but numbers go through formatNumber.
export function serialise(json, { pretty = false, exponent = false } = {}) {
	if (!exponent) return pretty ? JSON.stringify(json, null, 2) : JSON.stringify(json)
	const nl = pretty ? '\n' : ''
	const out = (v, ind) => {
		if (typeof v === 'number') return formatNumber(v, true)
		if (v === null || typeof v !== 'object') return JSON.stringify(v)
		const inner = pretty ? ind + '  ' : ''
		if (Array.isArray(v)) {
			if (!v.length) return '[]'
			return '[' + nl + v.map((x) => inner + out(x === undefined ? null : x, inner)).join(',' + nl) + nl + ind + ']'
		}
		const keys = Object.keys(v).filter((k) => v[k] !== undefined)
		if (!keys.length) return '{}'
		const sep = pretty ? ': ' : ':'
		return '{' + nl + keys.map((k) => inner + JSON.stringify(k) + sep + out(v[k], inner)).join(',' + nl) + nl + ind + '}'
	}
	return out(json, '')
}

// A layer transform as a shape-group transform (2D values; layer values carry a z).
function groupTransform(ks) {
	const flat2 = (p, def) => {
		if (!p) return { a: 0, k: def }
		const cut = (v) => (Array.isArray(v) && v.length > 2 ? v.slice(0, 2) : v)
		if (!isAnimated(p)) return { a: 0, k: cut(p.k) }
		return {
			a: 1,
			k: p.k.map((kf) => {
				const o = Object.assign({}, kf)
				for (const f of ['s', 'e', 'to', 'ti']) if (o[f]) o[f] = cut(o[f])
				return o
			}),
		}
	}
	let pos = ks.p
	if (pos && pos.s) pos = { a: 0, k: [asArray(pos.x.k)[0], asArray(pos.y.k)[0]] } // only static split positions get here
	const tr = { ty: 'tr', p: flat2(pos, [0, 0]), a: flat2(ks.a, [0, 0]), s: flat2(ks.s, [100, 100]), r: ks.r || { a: 0, k: 0 }, o: ks.o || { a: 0, k: 100 } }
	if (ks.sk) tr.sk = ks.sk
	if (ks.sa) tr.sa = ks.sa
	return tr
}

// Cavalry writes every shape as its own layer; After Effects files hold many shapes in one
// layer as groups. Runs of neighbouring shape layers with the same parent and timing become
// one layer, each old layer a group carrying its transform. Lossless: only layers that
// nothing parents to, mattes or masks, at normal blend, 2D, and whose opacity can't change
// how their own shapes overlap (100%, or a single fill or stroke).
// ponytail: animated split (x/y) positions keep their layer; iOS shape transforms don't split.
export function mergeShapeLayers(json) {
	if (hasExpressions(json)) return 0 // expressions can name layers
	let n = 0
	const paints = (items) => {
		let c = 0
		const walk = (its) => (its || []).forEach((it) => (it.ty === 'gr' ? walk(it.it) : ['fl', 'st', 'gf', 'gs'].includes(it.ty) && c++))
		walk(items)
		return c
	}
	for (const layers of layerLists(json)) {
		const parents = new Set(layers.map((l) => l.parent).filter((p) => p != null))
		const ok = (l) => {
			if (l.ty !== 4 || parents.has(l.ind) || l.tt || l.td || l.tp || l.masksProperties || l.ef || l.bm || l.hd || l.ddd || l.ao) return false
			const ks = l.ks || {}
			if (ks.p && ks.p.s && (isAnimated(ks.p.x) || isAnimated(ks.p.y))) return false
			if (ks.rx || ks.ry || ks.or) return false
			const o = ks.o
			const full = !o || (!isAnimated(o) && Math.abs(asArray(o.k)[0] - 100) < EPS)
			return full || paints(l.shapes) <= 1
		}
		const same = (a, b) => a.parent === b.parent && a.ip === b.ip && a.op === b.op && (a.st || 0) === (b.st || 0) && (a.sr || 1) === (b.sr || 1)
		const out = []
		for (let i = 0; i < layers.length; ) {
			let j = i + 1
			if (ok(layers[i])) while (j < layers.length && ok(layers[j]) && same(layers[i], layers[j])) j++
			if (j - i < 2) {
				out.push(layers[i++])
				continue
			}
			const run = layers.slice(i, j)
			const merged = Object.assign({}, run[0], {
				ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
				shapes: run.map((l) => ({ ty: 'gr', nm: l.nm, it: (l.shapes || []).concat([groupTransform(l.ks || {})]) })),
			})
			out.push(merged)
			n += run.length - 1
			i = j
		}
		layers.length = 0
		layers.push(...out)
	}
	return n
}

// Bounds of a group's drawing items over all their keys, grown by its widest stroke;
// null when something can't be bounded.
function itemsBounds(items) {
	let b = null
	const grow = (x, y) => (b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y])
	const values = (p) => (!p ? [] : isAnimated(p) ? p.k.map((k) => k.s).filter((v) => v !== undefined) : [p.k])
	let pad = 0
	for (const it of items) {
		if (it.ty === 'gr') {
			const inner = itemsBounds((it.it || []).filter((x) => x.ty !== 'tr')) // path-only groups have identity transforms
			if (!inner) return null
			grow(inner[0], inner[1])
			grow(inner[2], inner[3])
		} else if (it.ty === 'sh') {
			for (const v of values(it.ks))
				for (const sh of asArray(v)) {
					if (!sh || !sh.v) return null
					sh.v.forEach((q, i) => {
						grow(q[0], q[1])
						grow(q[0] + sh.i[i][0], q[1] + sh.i[i][1])
						grow(q[0] + sh.o[i][0], q[1] + sh.o[i][1])
					})
				}
		} else if (it.ty === 'rc' || it.ty === 'el') {
			for (const c of values(it.p)) for (const sz of values(it.s)) grow(c[0] - sz[0] / 2, c[1] - sz[1] / 2), grow(c[0] + sz[0] / 2, c[1] + sz[1] / 2)
		} else if (it.ty === 'sr') {
			const r = Math.max(...values(it.or).map((v) => asArray(v)[0]))
			for (const c of values(it.p)) grow(c[0] - r, c[1] - r), grow(c[0] + r, c[1] + r)
		} else if (it.ty === 'st' || it.ty === 'gs') {
			const w = Math.max(...values(it.w).map((v) => asArray(v)[0]))
			pad = Math.max(pad, (w / 2) * Math.max(it.ml || 4, 1)) // miter joins reach furthest
		}
	}
	return b && [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]
}

const PATH_ITEMS = ['sh', 'rc', 'el', 'sr']
const PAINT_ITEMS = ['fl', 'st', 'gf', 'gs']
// A path, or a group holding only paths under an identity transform (Cavalry nests them).
const isPathItem = (x) =>
	PATH_ITEMS.includes(x.ty) || (x.ty === 'gr' && !x.hd && !x.bm && Array.isArray(x.it) && x.it.every((y) => (y.ty === 'tr' ? identityTr(y) : isPathItem(y))))

// Cavalry's writer puts a shape's fills and strokes both inside the group holding its
// path and again on the group around it, so every path is painted twice: double the paint
// data, darker anti-aliased edges, and see-through paint drawn twice as strong. When a
// layer's or group's only content is one inner group and paints equal to the inner
// group's, the outer copies go. Cavalry draws each paint once, so this matches it more closely.
export function removeDoubledPaints(json) {
	let n = 0
	const strip = (items) => items.map(({ nm, mn, ix, cix, ...rest }) => rest)
	// items: a layer's shape list or a group's; returns it without doubled paints
	const visit = (items) => {
		if (!Array.isArray(items)) return items
		for (const g of items) if (g && g.ty === 'gr') g.it = visit(g.it)
		const inner = items.filter((x) => x.ty === 'gr')
		const outerPaints = items.filter((x) => PAINT_ITEMS.includes(x.ty))
		if (inner.length !== 1 || !outerPaints.length || items.indexOf(inner[0]) !== 0) return items
		if (inner.length + outerPaints.length + (items.some((x) => x.ty === 'tr') ? 1 : 0) !== items.length) return items
		const innerPaints = (inner[0].it || []).filter((x) => PAINT_ITEMS.includes(x.ty))
		if (!deepEqual(strip(innerPaints), strip(outerPaints))) return items
		n += outerPaints.length
		return items.filter((x) => !outerPaints.includes(x))
	}
	for (const layers of layerLists(json)) for (const L of layers) if (Array.isArray(L.shapes)) L.shapes = visit(L.shapes)
	return n
}

// Cavalry gives every path its own group with its own fill and stroke, and writes a
// filled, stroked shape as two groups each holding the path. Neighbouring groups with the
// same transform, holding only paths and fills/strokes, become one group when either
//  - their paths are the same: one copy of the path takes both groups' paints, the upper
//    group's first (a stroke group above a fill group stays a stroke over the fill), or
//  - their fills/strokes are identical and their shapes don't overlap, so drawing them as
//    one compound shape can't change a pixel (fill rules, see-through paint and draw
//    order only matter where shapes overlap).
export function mergeShapeGroups(json) {
	let n = 0
	const style = (g) => {
		if (g.ty !== 'gr' || g.hd || g.bm || !Array.isArray(g.it)) return null
		const paths = g.it.filter(isPathItem)
		const paints = g.it.filter((x) => PAINT_ITEMS.includes(x.ty))
		const tr = g.it.find((x) => x.ty === 'tr')
		if (!paths.length || !paints.length || paths.length + paints.length + (tr ? 1 : 0) !== g.it.length) return null
		// every path must come before every paint (paints apply to the paths above them)
		const lastPath = Math.max(...paths.map((x) => g.it.indexOf(x)))
		if (paints.some((x) => g.it.indexOf(x) < lastPath)) return null
		if (paths.some((x) => x.hd) || paints.some((x) => x.hd || x.d)) return null // dashes restart per path
		return { paths, paints, tr, box: itemsBounds(g.it) }
	}
	const strip = (items) => items.map(({ nm, mn, ix, cix, ...rest }) => rest)
	const stripDeep = (items) => items.map(({ nm, mn, ix, cix, np, ...rest }) => (rest.it ? Object.assign(rest, { it: stripDeep(rest.it) }) : rest))
	const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
	const visit = (items) => {
		if (!Array.isArray(items)) return
		for (const it of items) if (it && it.ty === 'gr') visit(it.it)
		for (let i = 0; i < items.length - 1; ) {
			const a = style(items[i]), b = a && style(items[i + 1])
			const sameTr = b && deepEqual(a.tr ? strip([a.tr]) : null, b.tr ? strip([b.tr]) : null)
			const samePaths = sameTr && deepEqual(stripDeep(a.paths), stripDeep(b.paths))
			const sharePaint = sameTr && !samePaths && a.box && b.box && !overlaps(a.box, b.box) && deepEqual(strip(a.paints), strip(b.paints))
			if (!samePaths && !sharePaint) {
				i++
				continue
			}
			const g = items[i]
			g.it = samePaths ? a.paths.concat(a.paints, b.paints, a.tr ? [a.tr] : []) : a.paths.concat(b.paths, a.paints, a.tr ? [a.tr] : [])
			items.splice(i + 1, 1)
			n++ // stay on i: the merged group may take the next one too
		}
	}
	for (const layers of layerLists(json)) for (const L of layers) visit(L.shapes)
	return n
}

// ---------- catalogue + runner ----------

// group: lossless | lossy | assets | output. Order here is the order passes run in: lossy
// passes come before collapseStatic and friends so those can clean up after them.
export const PASSES = [
	{ id: 'removeHidden', label: 'Remove hidden layers and shapes', group: 'lossless', on: true, run: removeHidden },
	{ id: 'removeDeadLayers', label: 'Remove layers that are never visible', group: 'lossless', on: true, run: removeDeadLayers },
	{ id: 'foldStaticParents', label: 'Fold still group layers into their children', group: 'lossless', on: true, run: foldStaticParents },
	{ id: 'removeIdentityNulls', label: 'Remove do-nothing null layers', group: 'lossless', on: true, run: removeIdentityNulls },
	{ id: 'removeUnusedAssets', label: 'Remove unused assets', group: 'lossless', on: true, run: removeUnusedAssets },
	{ id: 'dedupeAssets', label: 'Merge identical assets', group: 'lossless', on: true, run: dedupeAssets },
	{ id: 'trimToLayerRange', label: 'Trim keys outside each layer’s time range', group: 'lossless', on: true, run: trimToLayerRange },
	{ id: 'recoverRigidMotion', label: 'Turn baked moving shapes back into transforms', group: 'lossy', on: true, run: recoverRigidMotion },
	{ id: 'holdJumps', label: 'Hold one-frame jumps', group: 'lossless', on: true, run: holdJumps, options: { all: false } },
	{ id: 'simplifyKeys', label: 'Fit keyframes with curves', group: 'lossy', on: true, run: simplifyKeys },
	{ id: 'simplifyPaths', label: 'Simplify still paths', group: 'lossy', on: true, run: simplifyPaths },
	{ id: 'roundPrecision', label: 'Round values (decimals per kind)', group: 'lossy', on: true, run: roundPrecision },
	{ id: 'instanceLayers', label: 'Share identical layers as one precomp', group: 'lossless', on: true, run: instanceLayers },
	{ id: 'removeDoubledPaints', label: 'Remove doubled fills and strokes', group: 'lossless', on: true, run: removeDoubledPaints },
	{ id: 'mergeShapeLayers', label: 'Merge neighbouring shape layers', group: 'lossless', on: true, run: mergeShapeLayers },
	{ id: 'flattenShapeGroups', label: 'Flatten nested shape groups', group: 'lossless', on: true, run: flattenShapeGroups },
	{ id: 'mergeShapeGroups', label: 'Share fills and strokes between shapes', group: 'lossless', on: true, run: mergeShapeGroups },
	{ id: 'collapseStatic', label: 'Make unchanging animated properties static', group: 'lossless', on: true, run: collapseStatic },
	{ id: 'removeRedundantKeys', label: 'Remove keys that change nothing', group: 'lossless', on: true, run: removeRedundantKeys },
	{ id: 'trimKeyframeFields', label: 'Drop unused keyframe fields', group: 'lossless', on: true, run: trimKeyframeFields },
	{ id: 'removeDefaults', label: 'Drop default-valued fields', group: 'lossless', on: true, run: removeDefaults },
	{ id: 'unwrapScalars', label: 'Unwrap one-value arrays', group: 'lossless', on: true, run: unwrapScalars },
	{ id: 'stripMeta', label: 'Strip metadata', group: 'lossless', on: true, run: stripMeta, options: { names: false, matchNames: true, markers: false, keepEffectMatchNames: false } },
]

const clone = (v) => JSON.parse(JSON.stringify(v))

// settings: { [passId]: true | false | {options}, accuracy (px), display (scale it plays at), exponent, pretty }
export function optimise(input, settings = {}) {
	const json = clone(input)
	const fmt = { exponent: !!settings.exponent, pretty: !!settings.pretty }
	const report = [{ id: 'input', bytes: JSON.stringify(input).length }]
	for (const pass of PASSES) {
		const s = settings[pass.id] !== undefined ? settings[pass.id] : pass.on
		if (!s) continue
		const opts = Object.assign({ accuracy: settings.accuracy, display: settings.display }, pass.options, isObj(s) ? s : {})
		const changes = pass.run(json, opts)
		report.push({ id: pass.id, changes, bytes: JSON.stringify(json).length })
	}
	const text = serialise(json, fmt)
	report.push({ id: 'output', bytes: text.length })
	return { json, text, report, expressions: hasExpressions(json) }
}
