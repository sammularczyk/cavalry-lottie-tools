// Lottie JSON optimisation passes. Pure functions over the parsed JSON — no `api.` calls,
// so they run (and are tested) in Node as well as in Cavalry.
//
// Each pass mutates the json it is given and returns the number of things it changed.
// `optimise` clones the input, runs the selected passes in catalogue order and reports
// the bytes each one saved.

// ---------- walking ----------

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
export function removeDefaults(json) {
	let n = 0
	const zero = (p) => p && !isAnimated(p) && !p.x && Number(asArray(p.k)[0]) === 0
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk)
		if (!isObj(node)) return
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
			if (rest.length !== 1 || rest[0].ty !== 'gr' || !identityTr(ownTr)) return items
			const g = rest[0]
			if (g.hd || (g.bm && g.bm !== 0) || !Array.isArray(g.it)) return items
			const inner = g.it.find((it) => it.ty === 'tr')
			if (identityTr(inner)) items = g.it.filter((it) => it.ty !== 'tr').concat(ownTr ? [ownTr] : [])
			else if (!top) items = g.it.slice() // this level's transform is the identity: the inner one replaces it
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
			if (ty === 'rc' || ty === 'el') return 'px'
			if (ty === 'tm') return 'opacity'
			return 'scale'
		case 'e':
			return ty === 'tm' ? 'opacity' : 'px'
		default:
			return 'px'
	}
}

export const TOLERANCE = { px: 0.25, scale: 0.25, angle: 0.1, opacity: 0.5, color: 0.004 }
export const DECIMALS = { px: 2, scale: 2, angle: 2, opacity: 1, color: 3, tangent: 3 }

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

// RDP over time: drop keys whose value lies within tol of the straight line between the
// keys kept either side. Only runs of linear segments are touched; eased, held and
// spatial keys always stay.
export function simplifyKeys(json, opts = {}) {
	const tol = Object.assign({}, TOLERANCE, opts.tolerance)
	let n = 0
	forEachProp(json, (p, key, owner) => {
		if (!isAnimated(p) || p.k.length < 3 || p.x) return
		const k = p.k
		const vals = k.map((kf) => (kf.s === undefined ? null : flatten(kf.s)))
		if (vals.some((v) => !v || v.length !== vals[0].length)) return
		const dims = Array.isArray(k[0].s) && !isObj(k[0].s[0]) ? k[0].s.length : 1
		const t = tol[category(key, owner)]
		const keep = new Array(k.length).fill(false)
		keep[0] = keep[k.length - 1] = true
		for (let j = 0; j < k.length - 1; j++) {
			if (!isLinearSegment(k[j], dims) || hasSpatial(k[j])) keep[j] = keep[j + 1] = true
		}
		const rdp = (a, b) => {
			let worst = -1,
				at = -1
			for (let j = a + 1; j < b; j++) {
				const u = (k[j].t - k[a].t) / (k[b].t - k[a].t)
				let err = 0
				for (let d = 0; d < vals[j].length; d++) err = Math.max(err, Math.abs(vals[a][d] + (vals[b][d] - vals[a][d]) * u - vals[j][d]))
				if (err > worst) (worst = err), (at = j)
			}
			if (worst > t) {
				keep[at] = true
				rdp(a, at)
				rdp(at, b)
			}
		}
		let a = 0
		for (let j = 1; j < k.length; j++) {
			if (!keep[j]) continue
			if (j - a > 1) rdp(a, j)
			a = j
		}
		const kept = k.filter((_, j) => keep[j])
		n += k.length - kept.length
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

// Baked shapes that only move, turn or scale: keep the first frame's path and move the
// group's transform instead. Only for frame-by-frame bakes (every key ≤ 1 frame apart),
// where transform and vertex interpolation agree.
// ponytail: similarity only (no skew / non-uniform scale); full affine fit if bakes need it.
export function recoverRigidMotion(json, opts = {}) {
	const tol = opts.tolerance != null ? opts.tolerance : TOLERANCE.px
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
				const fit = fitSimilarity(P, shapePoints(f), !stroked) // scaling a group scales its stroke
				if (fit.err > tol) {
					ok = false
					break
				}
				let deg = (fit.th * 180) / Math.PI
				while (deg - prev > 180) deg -= 360
				while (deg - prev < -180) deg += 360
				prev = deg
				const k = Math.cos(fit.th) * fit.s,
					sn = Math.sin(fit.th) * fit.s
				fits.push({ p: [k * c[0] - sn * c[1] + fit.tx, sn * c[0] + k * c[1] + fit.ty], r: deg, s: fit.s * 100 })
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
			if (!stroked) tr.s = keys((f) => [f.s, f.s])
			paths.forEach((x) => {
				x.ks = { a: 0, k: x.ks.k[0].s[0] }
			})
			n++
		}
	}
	for (const layers of layerLists(json)) for (const L of layers) visit(L.shapes)
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

// Decimals per kind of value instead of one global precision.
export function roundPrecision(json, opts = {}) {
	const dec = Object.assign({}, DECIMALS, opts.decimals)
	let n = 0
	forEachProp(json, (p, key, owner) => {
		const d = dec[category(key, owner)]
		n++
		if (!isAnimated(p)) {
			p.k = roundDeep(p.k, d)
			return
		}
		for (const kf of p.k) {
			if (kf.s !== undefined) kf.s = roundDeep(kf.s, d)
			if (kf.e !== undefined) kf.e = roundDeep(kf.e, d)
			if (kf.to) kf.to = roundDeep(kf.to, dec.px)
			if (kf.ti) kf.ti = roundDeep(kf.ti, dec.px)
			if (kf.i) kf.i = roundDeep(kf.i, dec.tangent)
			if (kf.o) kf.o = roundDeep(kf.o, dec.tangent)
			if (typeof kf.t === 'number') kf.t = roundTo(kf.t, 3)
		}
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
	{ id: 'simplifyKeys', label: 'Simplify keyframes within tolerance', group: 'lossy', on: true, run: simplifyKeys },
	{ id: 'roundPrecision', label: 'Round values (decimals per kind)', group: 'lossy', on: true, run: roundPrecision },
	{ id: 'instanceLayers', label: 'Share identical layers as one precomp', group: 'lossless', on: true, run: instanceLayers },
	{ id: 'flattenShapeGroups', label: 'Flatten nested shape groups', group: 'lossless', on: true, run: flattenShapeGroups },
	{ id: 'collapseStatic', label: 'Make unchanging animated properties static', group: 'lossless', on: true, run: collapseStatic },
	{ id: 'removeRedundantKeys', label: 'Remove keys that change nothing', group: 'lossless', on: true, run: removeRedundantKeys },
	{ id: 'trimKeyframeFields', label: 'Drop unused keyframe fields', group: 'lossless', on: true, run: trimKeyframeFields },
	{ id: 'removeDefaults', label: 'Drop default-valued fields', group: 'lossless', on: true, run: removeDefaults },
	{ id: 'unwrapScalars', label: 'Unwrap one-value arrays', group: 'lossless', on: true, run: unwrapScalars },
	{ id: 'stripMeta', label: 'Strip metadata', group: 'lossless', on: true, run: stripMeta, options: { names: false, matchNames: true, markers: false, keepEffectMatchNames: false } },
]

const clone = (v) => JSON.parse(JSON.stringify(v))

// settings: { [passId]: true | false | {options} , exponent, pretty }
export function optimise(input, settings = {}) {
	const json = clone(input)
	const fmt = { exponent: !!settings.exponent, pretty: !!settings.pretty }
	const report = [{ id: 'input', bytes: JSON.stringify(input).length }]
	for (const pass of PASSES) {
		const s = settings[pass.id] !== undefined ? settings[pass.id] : pass.on
		if (!s) continue
		const opts = Object.assign({}, pass.options, isObj(s) ? s : {})
		const changes = pass.run(json, opts)
		report.push({ id: pass.id, changes, bytes: JSON.stringify(json).length })
	}
	const text = serialise(json, fmt)
	report.push({ id: 'output', bytes: text.length })
	return { json, text, report, expressions: hasExpressions(json) }
}
