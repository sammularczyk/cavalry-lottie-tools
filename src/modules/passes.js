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
		})
	})
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

// group: lossless | lossy | assets | output. `unsafe` lists target players the pass is
// switched off for. Order here is the order passes run in.
export const PASSES = [
	{ id: 'removeHidden', label: 'Remove hidden layers and shapes', group: 'lossless', on: true, run: removeHidden },
	{ id: 'removeDeadLayers', label: 'Remove layers that are never visible', group: 'lossless', on: true, run: removeDeadLayers },
	{ id: 'removeUnusedAssets', label: 'Remove unused assets', group: 'lossless', on: true, run: removeUnusedAssets },
	{ id: 'dedupeAssets', label: 'Merge identical assets', group: 'lossless', on: true, run: dedupeAssets },
	{ id: 'trimToLayerRange', label: 'Trim keys outside each layer’s time range', group: 'lossless', on: true, run: trimToLayerRange },
	{ id: 'collapseStatic', label: 'Make unchanging animated properties static', group: 'lossless', on: true, run: collapseStatic },
	{ id: 'removeRedundantKeys', label: 'Remove keys that change nothing', group: 'lossless', on: true, run: removeRedundantKeys },
	{ id: 'trimKeyframeFields', label: 'Drop unused keyframe fields', group: 'lossless', on: true, run: trimKeyframeFields },
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
