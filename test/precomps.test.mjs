import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { repairPositions, staticSingleKeys, valueAt } from '../src/modules/precomps.js'

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
