import test from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/modules/passes.js'

const kf = (t, s, extra = {}) => ({ t, s, ...extra })
const lin = { i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }
const ease = { i: { x: [0.2], y: [1] }, o: { x: [0.8], y: [0] } }
const layer = (over = {}) => ({ ty: 4, ind: 1, ip: 0, op: 100, st: 0, sr: 1, ks: { o: { a: 0, k: 100 } }, shapes: [], ...over })

test('collapseStatic: equal keys become static; spatial and text keys stay', () => {
	const j = {
		layers: [
			layer({
				ks: {
					o: { a: 1, k: [kf(0, [50], ease), kf(10, [50])] },
					p: { a: 1, k: [kf(0, [0, 0], { to: [10, 0], ti: [-10, 0] }), kf(10, [0, 0])] },
				},
				t: { d: { k: [kf(0, { t: 'a' }), kf(5, { t: 'a' })] } },
			}),
		],
	}
	assert.equal(P.collapseStatic(j), 1)
	assert.deepEqual(j.layers[0].ks.o, { a: 0, k: 50 })
	assert.equal(j.layers[0].ks.p.a, 1)
	assert.equal(j.layers[0].t.d.k.length, 2)
})

test('collapseStatic: shape keyframes unwrap the path', () => {
	const path = { c: true, v: [[0, 0]], i: [[0, 0]], o: [[0, 0]] }
	const j = { layers: [layer({ shapes: [{ ty: 'sh', ks: { a: 1, k: [kf(0, [path]), kf(9, [path])] } }] })] }
	P.collapseStatic(j)
	assert.deepEqual(j.layers[0].shapes[0].ks, { a: 0, k: path })
})

test('removeRedundantKeys: flat runs and exact linear keys go, eased and peak keys stay', () => {
	const p = {
		a: 1,
		k: [kf(0, [0], lin), kf(5, [50], lin), kf(10, [100], ease), kf(20, [100], lin), kf(30, [100], lin), kf(40, [0])],
	}
	const j = { layers: [layer({ ks: { o: p } })] }
	assert.equal(P.removeRedundantKeys(j), 2)
	assert.deepEqual(p.k.map((k) => k.t), [0, 10, 30, 40])
})

test('removeRedundantKeys: spatial flat run is kept (curve can leave and return)', () => {
	const p = { a: 1, k: [kf(0, [0, 0], { to: [10, 0], ti: [0, 0] }), kf(5, [0, 0]), kf(10, [0, 0])] }
	P.removeRedundantKeys({ layers: [layer({ ks: { p } })] })
	assert.equal(p.k.length, 3)
})

test('trimToLayerRange: keeps one key each side, skips parents', () => {
	const keys = () => ({ a: 1, k: [0, 10, 20, 30, 40, 50].map((t) => kf(t, [t], lin)) })
	const child = layer({ ind: 2, parent: 1, ip: 15, op: 35, ks: { o: keys() } })
	const parent = layer({ ind: 1, ip: 15, op: 35, ks: { o: keys() } })
	const j = { layers: [child, parent] }
	assert.equal(P.trimToLayerRange(j), 2)
	assert.deepEqual(child.ks.o.k.map((k) => k.t), [10, 20, 30, 40])
	assert.equal(parent.ks.o.k.length, 6)
})

test('trimToLayerRange: keys are in comp time even when st is offset', () => {
	const L = layer({ ip: 285, op: 466, st: 285, ks: { s: { a: 1, k: [434, 457, 491, 500].map((t) => kf(t, [t, t], lin)) } } })
	P.trimToLayerRange({ layers: [L] })
	assert.deepEqual(L.ks.s.k.map((k) => k.t), [434, 457, 491])
})

test('removeHidden / removeDeadLayers keep parents and mattes', () => {
	const j = {
		layers: [
			layer({ ind: 1, hd: true }),
			layer({ ind: 2, hd: true }),
			layer({ ind: 3, parent: 2 }),
			layer({ ind: 4, ks: { o: { a: 0, k: 0 } } }),
			layer({ ind: 5, td: 1, ks: { o: { a: 0, k: 0 } } }),
			layer({ ind: 6, tt: 1, shapes: [{ ty: 'fl', hd: true }, { ty: 'st' }] }),
		],
	}
	assert.equal(P.removeHidden(j), 2) // layer 1 + one shape
	assert.equal(P.removeDeadLayers(j), 1) // layer 4
	assert.deepEqual(j.layers.map((L) => L.ind), [2, 3, 5, 6])
})

test('removeUnusedAssets follows precomps; dedupeAssets rewrites refIds', () => {
	const img = (id) => ({ id, w: 1, h: 1, u: 'images/', p: 'a.png', e: 0 })
	const j = {
		assets: [
			{ id: 'c1', layers: [{ ty: 2, refId: 'i1' }] },
			img('i1'),
			img('i2'),
			img('unused'),
			{ id: 'c2', layers: [{ ty: 2, refId: 'i2' }] },
		],
		layers: [{ ty: 0, refId: 'c1' }, { ty: 0, refId: 'c2' }],
	}
	assert.equal(P.removeUnusedAssets(j), 1)
	assert.equal(P.dedupeAssets(j), 1) // i2 -> i1 (c1/c2 differ until remapped)
	assert.equal(j.assets.find((a) => a.id === 'c2').layers[0].refId, 'i1')
	assert.ok(!j.assets.some((a) => a.id === 'i2'))
})

test('trimKeyframeFields drops hold tangents, last-key tangents and e', () => {
	const p = { a: 1, k: [kf(0, [0], { ...ease, h: 1, e: [5] }), kf(5, [5], { ...ease, e: [9] }), kf(9, [9], { ...ease, h: 1 })] }
	P.trimKeyframeFields({ layers: [layer({ ks: { o: p } })] })
	assert.deepEqual(p.k[0], { t: 0, s: [0], h: 1 })
	assert.deepEqual(p.k[1], { t: 5, s: [5], ...ease })
	assert.deepEqual(p.k[2], { t: 9, s: [9] })
})

test('stripMeta keeps names expressions use', () => {
	const j = {
		meta: { g: 'x' },
		layers: [
			layer({ nm: 'Ctrl', ln: 'a', cl: 'b' }),
			layer({ nm: 'Other', ks: { o: { a: 0, k: 100, x: "thisComp.layer('Ctrl').transform.opacity" } } }),
		],
	}
	P.stripMeta(j, { names: true })
	assert.equal(j.layers[0].nm, 'Ctrl')
	assert.equal(j.layers[1].nm, undefined)
	assert.equal(j.layers[0].ln, undefined)
	assert.equal(j.meta, undefined)
})

test('removeIdentityNulls re-parents children; keeps moving nulls', () => {
	const id = { p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } }
	const moving = { ...id, r: { a: 1, k: [kf(0, [0], lin), kf(9, [90])] } }
	const j = {
		layers: [
			layer({ ind: 1, ty: 3, ks: moving }),
			layer({ ind: 2, ty: 3, parent: 1, ks: id }),
			layer({ ind: 3, parent: 2 }),
			layer({ ind: 4, ty: 3, ks: { p: { s: true, x: { a: 0, k: 0 }, y: { a: 0, k: 0 } } } }),
			layer({ ind: 5, parent: 4 }),
		],
	}
	assert.equal(P.removeIdentityNulls(j), 2)
	assert.deepEqual(j.layers.map((L) => [L.ind, L.parent]), [[1, undefined], [3, 1], [5, undefined]])
})

test('removeDefaults drops zero skew, ao 0 and empty names', () => {
	const j = { chars: [], layers: [layer({ ao: 0, nm: '', mn: '', ks: { sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } }, shapes: [{ ty: 'tr', nm: '', sk: { a: 0, k: 5 }, sa: { a: 0, k: 0 } }] })] }
	P.removeDefaults(j)
	const L = j.layers[0]
	assert.equal(L.ao, undefined); assert.equal(L.nm, undefined); assert.equal(L.ks.sk, undefined); assert.equal(j.chars, undefined)
	assert.ok(L.shapes[0].sk, 'non-zero skew stays')
})

test('formatNumber / serialise round-trip exactly', () => {
	assert.equal(P.formatNumber(0.000001, true), '1e-6')
	assert.equal(P.formatNumber(-0.0000125, true), '-125e-7')
	assert.equal(P.formatNumber(12300000, true), '123e5')
	assert.equal(P.formatNumber(0.0012, true), '0.0012')
	assert.equal(P.formatNumber(1000, true), '1e3')
	const v = { a: [0.000001, 12300000, -0.0004567, 1.5, 0, -0], b: 'x"y', c: [], d: {}, e: null }
	for (const pretty of [false, true]) {
		const text = P.serialise(v, { exponent: true, pretty })
		assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(v)))
	}
	assert.ok(P.serialise(v, { exponent: true }).length < JSON.stringify(v).length)
})

test('optimise: reports bytes per pass and never grows the file', () => {
	const j = {
		v: '5.7.0', fr: 25, ip: 0, op: 50, w: 100, h: 100, meta: { a: 'Cavalry' },
		layers: [layer({ nm: 'L', ks: { o: { a: 1, k: [kf(0, [100], ease), kf(10, [100], ease), kf(20, [100])] }, p: { a: 0, k: [50, 50, 0] } } })],
		assets: [{ id: 'unused', p: 'x.png', u: '', e: 0 }],
	}
	const r = P.optimise(j, { exponent: true })
	assert.equal(r.report[0].id, 'input')
	assert.ok(r.report.at(-1).bytes < r.report[0].bytes)
	assert.equal(j.layers[0].ks.o.a, 1, 'input is not mutated')
	assert.equal(r.json.layers[0].ks.o.a, 0)
	assert.deepEqual(r.json.assets, [])
})
