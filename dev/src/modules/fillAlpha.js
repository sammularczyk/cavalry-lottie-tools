// Move a paint's alpha out of its colour and into its opacity.
//
// Cavalry writes a shape's `material.materialColor` straight into the fill's
// `c` property, alpha channel and all: a 65% grey card exports as
// `{ ty: 'fl', c: { k: [0.545, 0.545, 0.545, 0.655] }, o: { k: 100 } }`.
//
// No player reads that fourth channel. lottie-web builds the colour property
// with dimension 1 and paints `rgb(` from `c.v[0..2]` (elementData.c and
// SVGFillStyleData), and takes a paint's transparency from `fl.o` alone. So an
// alpha in `c[3]` is silently dropped and the shape draws solid.
//
// Lottie's own model is the split: colour is RGB, opacity a separate
// percentage. The exporter already writes that split for Fill *filters*
// (precomps.js fillProps), so this pass applies the same rule to every paint
// Cavalry's writer produced. It is idempotent — a colour already at alpha 1 is
// left alone, which also makes it safe to run after any other pass.
//
// Gradient fills (`gf`) and gradient strokes (`gs`) are untouched: their stops
// carry alpha by design.

// Every layer list in the document: the root plus each comp asset.
function layerLists(json) {
	const lists = []
	if (Array.isArray(json.layers)) lists.push(json.layers)
	for (const a of json.assets || [])
		if (Array.isArray(a.layers)) lists.push(a.layers)
	return lists
}

const isNum = (v) => typeof v === 'number' && isFinite(v)
const round = (v) => Math.round(v * 1000) / 1000

// The scalar of an opacity property at one key time (0..100), or null.
function staticOpacity(prop) {
	if (!prop) return 100
	if (prop.a === 1) return null
	const v = Array.isArray(prop.k) ? prop.k[0] : prop.k
	return isNum(v) ? v : 100
}

// A curve of opacity percentages, or a static one, dropping a fully-transparent
// paint's opacity to a plain 0 (there is no visible difference, and a 0 fill
// costs a player nothing).
function opacityFrom(values) {
	const keys = values.filter((k) => isNum(k.v))
	if (!keys.length) return { a: 0, k: 100 }
	if (keys.every((k) => k.v <= 0)) return { a: 0, k: 0 }
	const same = keys.every((k) => Math.abs(k.v - keys[0].v) < 1e-6)
	if (same) return { a: 0, k: round(keys[0].v) }
	return {
		a: 1,
		k: keys.map((k, i) => {
			const out = { t: k.t, s: [round(k.v)] }
			if (i < keys.length - 1) {
				out.o = k.o || { x: [0], y: [0] }
				out.i = k.i || { x: [1], y: [1] }
			}
			if (k.h === 1) out.h = 1
			return out
		}),
	}
}

const RGB = (k) => [k[0], k[1], k[2], 1]

// Rewrite one paint's colour/opacity pair in place. Returns 1 when it changed.
function splitPaint(paint) {
	const c = paint && paint.c
	if (!c || (c.a !== 1 && !Array.isArray(c.k))) return 0
	const base = staticOpacity(paint.o)

	if (c.a !== 1) {
		const k = c.k
		if (!Array.isArray(k) || k.length < 4) return 0
		const a = k[3]
		if (!isNum(a) || a >= 1) return 0
		c.k = RGB(k)
		paint.o = opacityFrom([{ t: 0, v: (base == null ? 100 : base) * a }])
		return 1
	}

	// Animated colour: each key carries its own alpha, so the paint's opacity
	// becomes a curve at the same times. That is how a colour fading through
	// transparency bakes into `c` keys.
	const keys = c.k || []
	let transparent = 0
	for (const key of keys) {
		const s = key && key.s
		if (Array.isArray(s) && s.length >= 4 && isNum(s[3]) && s[3] < 1)
			transparent++
	}
	// A partly transparent colour keyed against an ANIMATED paint opacity has no
	// exact Lottie form (two curves, different key times). Leave it alone rather
	// than bake an approximation that renders differently.
	if (!transparent || (base == null && transparent < keys.length)) return 0

	c.k = keys.map((key) => {
		const s = key && key.s
		if (!Array.isArray(s) || s.length < 4) return key
		return Object.assign({}, key, { s: RGB(s) })
	})
	paint.o = opacityFrom(
		keys.map((key) => {
			const s = key && key.s
			const a =
				Array.isArray(s) && s.length >= 4 && isNum(s[3]) ? s[3] : 1
			const t = typeof key.t === 'number' ? key.t : 0
			return {
				t: t,
				v: (base == null ? 100 : base) * a,
				h: key.h,
				i: key.i,
				o: key.o,
			}
		})
	)
	return transparent
}

// Walk a shape tree (groups nest through `it`).
function walkShapes(items) {
	let n = 0
	for (const it of items || []) {
		if (!it || typeof it !== 'object') continue
		if (it.ty === 'gr') n += walkShapes(it.it)
		else if (it.ty === 'fl' || it.ty === 'st') n += splitPaint(it)
	}
	return n
}

// Move every paint's colour alpha into its opacity property.
// -> number of paints changed
export function splitFillAlpha(json) {
	if (!json) return 0
	let n = 0
	for (const layers of layerLists(json)) {
		for (const L of layers) {
			if (!L || !Array.isArray(L.shapes)) continue
			n += walkShapes(L.shapes)
		}
	}
	return n
}
