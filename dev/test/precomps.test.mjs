import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyMasks, fillProps, layerMatrix, padMatteBounds, repairPositions, staticSingleKeys, valueAt } from '../src/modules/precomps.js'

// Rect centres measured in Cavalry (y up, origin at the comp centre) at frames 0, 5, 10.
const CAVALRY = {
	A: [[60, 30]], B: [[40, 20]], C: [[75.36, 12.68]], D: [[63.04, -5.98]], E: [[72.28, 8.01]], E2: [[55, 27.5]],
	R: [[60, 30], [62.29, -16], [120, -30]], // pivot + animated rotation and scale
}

// World position of a layer's rect centre with Lottie's transform: p + R·S·(x − a), up the parents.
function worldCentre(json, L, t) {
	const byInd = Object.fromEntries(json.layers.map((l) => [l.ind, l]))
	const apply = (ks, [x, y]) => {
		const pv = ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t)
		const a = valueAt(ks.a, t) || [0, 0], s = valueAt(ks.s, t) || [100, 100], r = ((valueAt(ks.r, t) || [0])[0] * Math.PI) / 180
		const X = ((x - a[0]) * s[0]) / 100, Y = ((y - a[1]) * s[1]) / 100
		return [pv[0] + Math.cos(r) * X - Math.sin(r) * Y, pv[1] + Math.sin(r) * X + Math.cos(r) * Y]
	}
	let q = [0, 0]
	for (let l = L; l; l = byInd[l.parent]) q = apply(l.ks, q)
	return [q[0] - json.w / 2, json.h / 2 - q[1]]
}

test('repairPositions puts pivoted, rotated, scaled and parented layers where Cavalry draws them', () => {
	const json = JSON.parse(fs.readFileSync(new URL('./fixtures/cavalry-pivots.json', import.meta.url)))
	const C = json.layers.find((l) => l.nm === 'C')
	assert.ok(Math.abs(worldCentre(json, C, 0)[0] - 75.36) > 10, 'the raw export is off')
	// Scene data the exporter samples: pivots (Lottie space) and world pivots (Lottie comp space).
	const toLottie = ([x, y]) => [x + json.w / 2, json.h / 2 - y]
	const pivot = { A: [40, -20], B: [40, -20], C: [40, -20], D: [40, -20], R: [40, -20], G: [40, -20], GS: [40, -20], E: [0, 0], E2: [0, 0] }
	const world = (nm) => {
		if (nm === 'E' || nm === 'E2') return CAVALRY[nm][0] // rect centre = pivot
		if (pivot[nm]) return [100, 50] // top-level: position is where the pivot sits
		return null
	}
	const frames = [0, 5, 10]
	repairPositions(json.layers, frames, (L) => pivot[L.nm] || null, (L) => {
		const w = world(L.nm)
		return w ? Object.fromEntries(frames.map((f) => [f, toLottie(w)])) : null
	})
	for (const name in CAVALRY) {
		const L = json.layers.find((l) => l.nm === name)
		CAVALRY[name].forEach((want, i) => {
			const got = worldCentre(json, L, frames[i])
			assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.05, `${name} @${frames[i]}: ${got} vs ${want}`)
		})
	}
})

test('staticSingleKeys turns one-key animated properties into static values', () => {
	const ks = { s: { a: 1, k: [{ s: [100, 100, 0], t: 0 }] }, o: { a: 1, k: [{ s: [50], t: 0 }] }, r: { a: 1, k: [{ s: [0], t: 0 }, { s: [90], t: 9 }] } }
	const path = { a: 1, k: [{ s: [{ v: [[0, 0]], i: [[0, 0]], o: [[0, 0]], c: true }], t: 0 }] }
	assert.equal(staticSingleKeys([{ ks, shapes: [{ ty: 'sh', ks: path }] }]), 3)
	assert.deepEqual(ks.s, { a: 0, k: [100, 100, 0] })
	assert.deepEqual(ks.o, { a: 0, k: 50 })
	assert.equal(ks.r.a, 1)
	assert.equal(path.a, 0)
	assert.ok(!Array.isArray(path.k) && path.k.v)
})

test('applyMasks puts a world-space mask into each target layer\'s own space', () => {
	const sq = (x, y) => ({ isClosed: true, points: [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]].map((p) => ({ position: p, inHandle: p, outHandle: p })) })
	// target moves right 1 px a frame and is scaled 200%; the mask stays put in the world
	const L = { ind: 2, parent: 1, ks: { p: { a: 1, k: [{ t: 0, s: [0, 0], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }, { t: 2, s: [2, 0] }] }, s: { a: 0, k: [200, 200] } } }
	const P = { ind: 1, ks: { p: { a: 0, k: [100, 50] } } }
	const parentMatrix = (l, t) => { const [a] = [P]; const p = valueAt(a.ks.p, t); return [1, 0, 0, 1, p[0], p[1]] }
	const n = applyMasks([{ mode: 2, paths: { 0: [sq(100, 50)], 1: [sq(100, 50)], 2: [sq(100, 50)] } }], [L], parentMatrix)
	assert.equal(n, 1)
	const m = L.masksProperties[0]
	assert.equal(m.mode, 'a')
	assert.equal(m.pt.a, 1, 'mask moves in layer space because the layer moves')
	assert.deepEqual(m.pt.k[0].s[0].v[1], [5, 0])
	assert.deepEqual(m.pt.k[2].s[0].v[0], [-1, 0])
	assert.equal(L.hasMask, true)
})

test('inheritOpacity folds parent opacity into children (Lottie parents only pass transforms)', async () => {
	const { inheritOpacity } = await import('../src/modules/precomps.js')
	const hold = { a: 1, k: [{ t: 0, s: [100], h: 1 }, { t: 3, s: [0], h: 1 }, { t: 6, s: [0] }] }
	const layers = [
		{ ind: 1, ks: { o: hold } },
		{ ind: 2, parent: 1, ks: { o: { a: 0, k: 50 } } },
		{ ind: 3, parent: 2, ks: {} },
		{ ind: 4, ks: { o: { a: 0, k: 40 } } },
		{ ind: 5, parent: 4, ks: { o: { a: 0, k: 50 } } },
	]
	assert.equal(inheritOpacity(layers, 0, 6), 3)
	const o3 = layers[2].ks.o
	assert.equal(o3.a, 1)
	assert.deepEqual(o3.k.map((k) => k.s[0]), [50, 50, 50, 0, 0, 0, 0])
	assert.equal(o3.k[0].h, 1, 'hold keys stay steps')
	assert.deepEqual(layers[4].ks.o, { a: 0, k: 20 })
})

test('fillProps: shared channel keys kept, mismatched keys baked per frame, alpha to opacity', () => {
	const hold = (t, v) => ({ t, s: [v], h: 1 })
	const still = (v) => ({ a: 0, k: v })
	const keyed = (...k) => ({ a: 1, k })
	// r, g, b keyed together (holds), alpha static
	const a = fillProps([keyed(hold(0, 0), { t: 3, s: [1] }), keyed(hold(0, 1), { t: 3, s: [0] }), keyed(hold(0, 0.5), { t: 3, s: [0.5] }), still(0.5)], 0, 10)
	assert.deepEqual(a.color.k, [{ t: 0, s: [0, 1, 0.5, 1], h: 1 }, { t: 3, s: [1, 0, 0.5, 1] }])
	assert.deepEqual(a.opacity, { a: 0, k: 0.5 })
	// keys at different frames: one key per frame, values from each channel
	const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
	const b = fillProps([keyed({ t: 0, s: [0], ...lin }, { t: 4, s: [1] }), still(0), still(0), keyed({ t: 0, s: [1], ...lin }, { t: 2, s: [0] })], 0, 4)
	assert.equal(b.color.k.length, 5)
	assert.deepEqual(b.color.k[2].s.map((v) => +v.toFixed(6)), [0.5, 0, 0, 1])
	assert.equal(+b.opacity.k[1].s[0].toFixed(6), 0.5)
	// nothing keyed: static
	assert.deepEqual(fillProps([still(1), still(0), still(0), still(1)], 0, 4).color, { a: 0, k: [1, 0, 0, 1] })
})

test('layerMatrix skews like lottie-web: x shifts by -tan(sk)·y, before rotation', () => {
	const apply = (M, [x, y]) => [M[0] * x + M[1] * y + M[4], M[2] * x + M[3] * y + M[5]]
	const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, a + ' vs ' + b))
	near(apply(layerMatrix({ sk: { a: 0, k: 45 } }, 0), [0, 10]), [-10, 10])
	// rotated 90° after the skew: (0,10) -> skew (-10,10) -> rotate (-10,-10)
	near(apply(layerMatrix({ sk: { a: 0, k: 45 }, r: { a: 0, k: 90 } }, 0), [0, 10]), [-10, -10])
})

test('padMatteBounds widens a straight stroked line so lottie-web’s matte mask keeps it', () => {
	const still = (k) => ({ a: 0, k })
	const layer = (v, w) => ({ shapes: [{ ty: 'gr', it: [{ ty: 'sh', ks: still({ c: false, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]) }) }, { ty: 'st', w: still(w) }, { ty: 'tr', p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) }] }] })
	const line = layer([[0, 50], [1000, 50]], 17)
	assert.equal(padMatteBounds(line), true)
	const rc = line.shapes[1].it[0]
	assert.deepEqual([rc.p.k, rc.s.k], [[500, 50], [1034, 34]])
	assert.equal(padMatteBounds(layer([[0, 0], [1000, 0], [1000, 1000]], 17)), false) // roomy: left alone
})
