import test from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/modules/passes.js'
import * as F from '../src/modules/fit.js'

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

test('trimToLayerRange: keeps one key each side; parents keep keys while a child is visible', () => {
	const keys = () => ({ a: 1, k: [0, 10, 20, 30, 40, 50].map((t) => kf(t, [t], lin)) })
	const child = layer({ ind: 2, parent: 1, ip: 15, op: 35, ks: { o: keys() } })
	const parent = layer({ ind: 1, ty: 3, ip: 0, op: 20, ks: { o: keys() } })
	const j = { layers: [child, parent] }
	P.trimToLayerRange(j)
	assert.deepEqual(child.ks.o.k.map((k) => k.t), [10, 20, 30, 40])
	assert.deepEqual(parent.ks.o.k.map((k) => k.t), [0, 10, 20, 30, 40]) // own 0..20 plus the child's 15..35
})

test('trimToLayerRange / removeDeadLayers: a precomp only keeps the inner frames it shows', () => {
	const keys = () => ({ a: 1, k: [0, 10, 20, 30, 40, 50, 60].map((t) => kf(t, [t], lin)) })
	const inner = layer({ ind: 1, ip: 0, op: 100, ks: { o: keys() } })
	const unseen = layer({ ind: 2, ip: 70, op: 100 })
	// shown for outer frames 0..10, offset so inner frames 20..30 play
	const shifted = { ty: 0, ind: 1, refId: 'c', ip: 0, op: 10, st: -20, ks: {} }
	const j = { fr: 10, ip: 0, op: 10, assets: [{ id: 'c', layers: [inner, unseen] }], layers: [shifted] }
	P.removeDeadLayers(j)
	P.trimToLayerRange(j)
	assert.deepEqual(j.assets[0].layers.map((L) => L.ind), [1])
	assert.deepEqual(inner.ks.o.k.map((k) => k.t), [20, 30]) // the window lands on keys 20 and 30
	// time remapped: tm (seconds) holds inner frame 40, so only the keys around 40 stay
	const inner2 = layer({ ind: 1, ip: 0, op: 100, ks: { o: keys() } })
	const remap = { ty: 0, ind: 1, refId: 'c', ip: 0, op: 10, st: 0, tm: { a: 0, k: 4 }, ks: {} }
	const j2 = { fr: 10, ip: 0, op: 10, assets: [{ id: 'c', layers: [inner2] }], layers: [remap] }
	P.trimToLayerRange(j2)
	assert.deepEqual(inner2.ks.o.k.map((k) => k.t), [40, 50])
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
		layers: [layer({ nm: 'L', ks: { o: { a: 1, k: [kf(0, [100], ease), kf(10, [100], ease), kf(20, [100])] }, p: { a: 0, k: [50, 50, 0] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[0, 0]], i: [[0, 0]], o: [[0, 0]], c: false } } }] })],
		assets: [{ id: 'unused', p: 'x.png', u: '', e: 0 }],
	}
	const r = P.optimise(j, { exponent: true })
	assert.equal(r.report[0].id, 'input')
	assert.ok(r.report.at(-1).bytes < r.report[0].bytes)
	assert.equal(j.layers[0].ks.o.a, 1, 'input is not mutated')
	assert.equal(r.json.layers[0].ks.o, undefined) // collapsed to 100, then left out as the default
	assert.deepEqual(r.json.assets, [])
})

test('removeDefaults: default transform values go, except a shape group’s opacity', () => {
	const tr = idTr()
	const j = { layers: [layer({ ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } }, shapes: [{ ty: 'gr', it: [tr] }] })] }
	P.removeDefaults(j)
	assert.deepEqual(j.layers[0].ks, {})
	assert.deepEqual(Object.keys(tr).sort(), ['o', 'ty']) // lottie-web canvas needs a group's o
	const moved = { layers: [layer({ ks: { p: { a: 0, k: [5, 0, 0] }, s: { a: 0, k: [50, 50, 100] } } })] }
	P.removeDefaults(moved)
	assert.deepEqual(Object.keys(moved.layers[0].ks).sort(), ['p', 's'])
})

// ---------- lossy ----------

const square = (cx, cy, deg, s = 1) => {
	const th = (deg * Math.PI) / 180
	const pts = [[-5, -5], [5, -5], [5, 5], [-5, 5]].map(([x, y]) => [cx + s * (x * Math.cos(th) - y * Math.sin(th)), cy + s * (x * Math.sin(th) + y * Math.cos(th))])
	return { c: true, v: pts, i: pts.map(() => [0, 0]), o: pts.map(() => [0, 0]) }
}
const linKey = { i: { x: 0.833, y: 0.833 }, o: { x: 0.167, y: 0.167 } }

test('recoverRigidMotion: baked spinning, moving square becomes a static path + transform', () => {
	const keys = Array.from({ length: 10 }, (_, t) => kf(t, [square(20, 10 + t * 3, t * 30)], linKey))
	const tr = { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
	const g = { ty: 'gr', it: [{ ty: 'sh', ks: { a: 1, k: keys } }, { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] } }, tr] }
	assert.equal(P.recoverRigidMotion({ layers: [layer({ shapes: [g] })] }), 1)
	assert.equal(g.it[0].ks.a, 0)
	assert.deepEqual(tr.a.k.map(Math.round), [20, 10])
	tr.p.k.forEach((k, t) => {
		assert.ok(Math.abs(k.s[0] - 20) < 1e-6 && Math.abs(k.s[1] - (10 + t * 3)) < 1e-6)
	})
	tr.r.k.forEach((k, t) => assert.ok(Math.abs(k.s[0] - t * 30) < 1e-6, 'rotation unwrapped past 180'))
	tr.s.k.forEach((k) => assert.ok(Math.abs(k.s[0] - 100) < 1e-6))
})

test('recoverRigidMotion: skips real deformation and turning between spaced keys', () => {
	const warped = Array.from({ length: 4 }, (_, t) => { const sq = square(0, 0, 0); sq.v[0] = [-5 - t * 4, -5]; return kf(t, [sq], linKey) })
	const spaced = [kf(0, [square(0, 0, 0)], linKey), kf(10, [square(0, 0, 90)])]
	for (const keys of [warped, spaced]) {
		const g = { ty: 'gr', it: [{ ty: 'sh', ks: { a: 1, k: keys } }, { ty: 'tr', p: { a: 0, k: [0, 0] } }] }
		assert.equal(P.recoverRigidMotion({ layers: [layer({ shapes: [g] })] }), 0)
	}
})

test('recoverRigidMotion: spaced eased keys that only move and scale, growing from a point', () => {
	const ease = { i: { x: 0.6, y: 1.4 }, o: { x: 0.3, y: 0 } }
	const keys = [kf(0, [square(0, 0, 0, 0)], { h: 1 }), kf(1, [square(5, 5, 0, 0.2)], ease), kf(6, [square(40, 20, 0, 1)], ease), kf(15, [square(60, -10, 0, 0.8)])]
	const tr = { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
	const g = { ty: 'gr', it: [{ ty: 'sh', ks: { a: 1, k: keys } }, { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] } }, tr] }
	assert.equal(P.recoverRigidMotion({ layers: [layer({ shapes: [g] })] }), 1)
	assert.deepEqual(g.it[0].ks.k.v, square(40, 20, 0, 1).v) // the largest key, not the point
	assert.equal(tr.r.a, 0)
	assert.deepEqual(tr.s.k.map((k) => Math.round(k.s[0])), [0, 20, 100, 80])
	assert.deepEqual(tr.p.k.map((k) => k.s.map(Math.round)), [[0, 0], [5, 5], [40, 20], [60, -10]])
})

test('simplifyKeys: a baked straight move collapses; the turning point stays', () => {
	const vals = [0, 10, 20, 30, 40, 30, 20, 10, 0]
	const p = { a: 1, k: vals.map((v, t) => kf(t, [v, 0], { i: { x: [1, 1], y: [1, 1] }, o: { x: [0, 0], y: [0, 0] } })) }
	P.simplifyKeys({ layers: [layer({ ks: { p } })] })
	assert.deepEqual(p.k.map((k) => k.t), [0, 4, 8])
})

test('simplifyKeys: eased keys are never dropped', () => {
	const p = { a: 1, k: [kf(0, [0], ease), kf(5, [50], ease), kf(10, [100])] }
	P.simplifyKeys({ layers: [layer({ ks: { o: p } })] })
	assert.equal(p.k.length, 3)
})

test('simplifyKeys: opts.eased refits across eased keys that one ease can follow', () => {
	const near = { o: { x: 0.4, y: 0.38 }, i: { x: 0.6, y: 0.62 } } // all but linear
	const keys = () => ({ a: 1, k: [kf(0, [0], near), kf(5, [50], near), kf(10, [100])] })
	const kept = keys(), refit = keys()
	P.simplifyKeys({ layers: [layer({ ks: { o: kept } })] }, { accuracy: 1 })
	P.simplifyKeys({ layers: [layer({ ks: { o: refit } })] }, { accuracy: 1, eased: true })
	assert.equal(kept.k.length, 3)
	assert.equal(refit.k.length, 2)
})

test('roundPrecision: keys either side of an overshooting ease keep more decimals', () => {
	// moves 0.01 but the ease swings ×128: rounded to 0.1 apart it would swing 10× as far
	const keys = (o, i) => ({ a: 1, k: [{ t: 0, s: [165.55, 0], o, i }, { t: 20, s: [165.54, 0] }] })
	const steep = keys({ x: 0.35, y: 128.5 }, { x: 0.65, y: 89.7 }), plain = keys({ x: 0.3, y: 0 }, { x: 0.7, y: 1 })
	const j = { layers: [layer({ ks: { p: steep } }), layer({ ind: 2, ks: { p: plain } })] }
	P.roundPrecision(j, { accuracy: 1 })
	assert.deepEqual(steep.k.map((k) => k.s[0]), [165.55, 165.54])
	assert.deepEqual(plain.k.map((k) => k.s[0]), [165.6, 165.5])
})

test('roundPrecision: decimals by kind of value', () => {
	const j = { layers: [layer({ ks: { p: { a: 0, k: [1.23456, -0.0001] }, o: { a: 0, k: 55.555 } }, shapes: [{ ty: 'fl', c: { a: 0, k: [0.123456, 0.5, 0.5, 1] } }] })] }
	P.roundPrecision(j)
	assert.deepEqual(j.layers[0].ks.p.k, [1.23, 0])
	assert.equal(j.layers[0].ks.o.k, 55.6)
	assert.deepEqual(j.layers[0].shapes[0].c.k, [0.123, 0.5, 0.5, 1])
})

test('instanceLayers: identical shape layers share one precomp; anchor shifts by the pad', () => {
	const shapes = [{ ty: 'gr', it: [{ ty: 'rc', s: { a: 0, k: [10, 10] }, p: { a: 0, k: [0, 0] }, nm: 'x'.repeat(1200) }] }]
	const copy = (ind, x) => layer({ ind, nm: 'Coin', bm: 1, shapes: JSON.parse(JSON.stringify(shapes)), ks: { p: { a: 0, k: [x, 50, 0] }, a: { a: 0, k: [5, 5, 0] } } })
	const j = { w: 100, h: 100, layers: [copy(1, 10), copy(2, 60), copy(3, 90), layer({ ind: 4, parent: 3 })] }
	assert.equal(P.instanceLayers(j), 1) // 1 and 2 share; 3 is a parent so it stays
	const [a, b, c] = j.layers
	assert.equal(a.ty, 0); assert.equal(a.refId, b.refId); assert.equal(c.ty, 4)
	assert.equal(a.bm, 1)
	const pad = 2000
	assert.deepEqual(a.ks.a.k, [5 + pad, 5 + pad, 0])
	assert.deepEqual(a.ks.p.k, [10, 50, 0])
	assert.equal(a.w, 2 * pad)
	const inner = j.assets[0].layers[0]
	assert.deepEqual(inner.ks.p.k, [pad, pad, 0])
	assert.deepEqual(inner.shapes, shapes)
	assert.equal(inner.bm, undefined, 'blend stays on the outer layer')
})

test('holdJumps holds the key before a one-frame jump, leaves smooth runs and spaced keys alone', () => {
	const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
	// steady 1 px/frame, then a 100 px jump between frames 3 and 4, then steady again
	const vals = [0, 1, 2, 3, 103, 104, 105]
	const p = { a: 1, k: vals.map((v, t) => kf(t, [v, 0], { ...lin })) }
	const spaced = { a: 1, k: [kf(0, [0], { ...lin }), kf(10, [500])] } // a slow move over 10 frames
	const j = { layers: [layer({ ks: { p, o: spaced } })] }
	assert.equal(P.holdJumps(j), 1)
	assert.equal(p.k[3].h, 1)
	assert.equal(p.k[3].i, undefined)
	assert.ok(p.k.every((k, i) => i === 3 || k.h !== 1))
	assert.equal(spaced.k[0].h, undefined)
	// all: every one-frame key steps (Cavalry-style frames)
	const q = { a: 1, k: [0, 1, 2].map((v, t) => kf(t, [v], { ...lin })) }
	P.holdJumps({ layers: [layer({ ks: { o: q } })] }, { all: true })
	assert.deepEqual(q.k.map((k) => k.h), [1, 1, undefined])
})

import { valueAt } from '../src/modules/precomps.js'

// World matrix of a layer at t, Lottie semantics, up the parent chain.
function worldOf(layers, L, t) {
	const by = Object.fromEntries(layers.map((l) => [l.ind, l]))
	const m = (ks) => {
		const p = ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0]
		const a = valueAt(ks.a, t) || [0, 0], s = valueAt(ks.s, t) || [100, 100], r = (((valueAt(ks.r, t) || [0])[0] || 0) * Math.PI) / 180
		const c = Math.cos(r), sn = Math.sin(r), M = [c * s[0] / 100, -sn * s[1] / 100, sn * s[0] / 100, c * s[1] / 100]
		return [M[0], M[1], M[2], M[3], p[0] - (M[0] * a[0] + M[1] * a[1]), p[1] - (M[2] * a[0] + M[3] * a[1])]
	}
	const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[0] * B[4] + A[1] * B[5] + A[4], A[2] * B[4] + A[3] * B[5] + A[5]]
	let M = [1, 0, 0, 1, 0, 0]
	for (let l = L; l; l = by[l.parent]) M = mul(m(l.ks || {}), M)
	return M
}

test('foldStaticParents removes still, empty parents without moving anything', () => {
	const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }
	const group = (ind, parent, ks) => ({ ty: 4, ind, parent, ip: 0, op: 10, ks, shapes: [{ ty: 'gr', it: [] }] })
	const shape = (ind, parent, ks) => ({ ty: 4, ind, parent, ip: 0, op: 10, ks, shapes: [{ ty: 'gr', it: [{ ty: 'sh', ks: { a: 0, k: { v: [[0, 0]], i: [[0, 0]], o: [[0, 0]], c: false } } }] }] })
	const make = () => [
		group(1, undefined, { p: { a: 0, k: [300, 200] }, a: { a: 0, k: [10, 5] }, s: { a: 0, k: [150, 150] }, r: { a: 0, k: 30 } }),
		group(2, 1, { p: { s: true, x: { a: 0, k: 40 }, y: { a: 0, k: -20 } }, s: { a: 0, k: [50, 200] } }), // non-uniform, no rotation
		shape(3, 2, { p: { s: true, x: { a: 1, k: [kf(0, [0], lin), kf(10, [100])] }, y: { a: 0, k: 7 } }, s: { a: 1, k: [kf(0, [100, 100], lin), kf(10, [60, 60])] } }),
		shape(4, 1, { p: { a: 1, k: [kf(0, [5, 5, 0], lin), kf(10, [50, -30, 0])] }, r: { a: 1, k: [kf(0, [0], lin), kf(10, [90])] } }),
		group(5, undefined, { p: { a: 1, k: [kf(0, [0, 0], lin), kf(10, [9, 9])] } }), // moving parent stays
		shape(6, 5, { p: { a: 0, k: [1, 1] } }),
	]
	const before = make(), after = make()
	const n = P.foldStaticParents({ layers: after })
	// 2 folds into 3 (non-uniform scale, child doesn't rotate). 1 stays: its child 3 now has
	// split, animated position under a rotated parent. 5 moves, so it stays.
	assert.equal(n, 1)
	assert.deepEqual(after.map((L) => L.ind).sort(), [1, 3, 4, 5, 6])
	for (const ind of [3, 4, 6])
		for (const t of [0, 3.5, 10]) {
			const A = worldOf(before, before.find((l) => l.ind === ind), t)
			const B = worldOf(after, after.find((l) => l.ind === ind), t)
			A.forEach((v, i) => assert.ok(Math.abs(v - B[i]) < 1e-6, `layer ${ind} @${t}: ${A} vs ${B}`))
		}
})

test('flattenShapeGroups lifts sole identity groups and keeps every scope', () => {
	const tr = (p) => ({ ty: 'tr', p: { a: 0, k: p || [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } })
	const sh = { ty: 'sh', ks: { a: 0, k: { v: [[0, 0]], i: [[0, 0]], o: [[0, 0]], c: false } } }
	const fl = { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] } }
	// Cavalry style: layer > gr(identity) > gr(identity) > [sh, fl]
	const L1 = layer({ shapes: [{ ty: 'gr', it: [{ ty: 'gr', it: [sh, fl, tr()] }, tr()] }] })
	// moved inner group at layer level: its transform must stay in a group
	const L2 = layer({ shapes: [{ ty: 'gr', it: [{ ty: 'gr', it: [sh, fl, tr([5, 5])] }, tr()] }] })
	// two sibling groups: each keeps its own fill scope
	const L3 = layer({ shapes: [{ ty: 'gr', it: [sh, fl, tr()] }, { ty: 'gr', it: [sh, { ...fl }, tr()] }] })
	P.flattenShapeGroups({ layers: [L1, L2, L3] })
	assert.deepEqual(L1.shapes.map((x) => x.ty), ['sh', 'fl'])
	assert.equal(L2.shapes.length, 1)
	assert.deepEqual(L2.shapes[0].it.map((x) => x.ty), ['sh', 'fl', 'tr'])
	assert.deepEqual(L2.shapes[0].it[2].p.k, [5, 5])
	assert.deepEqual(L3.shapes.map((x) => x.ty), ['gr', 'gr'])
})

// ---------- curve fitting ----------

const smooth = (u) => u * u * (3 - 2 * u) // ease in-out
const baked = (n, f) => Array.from({ length: n + 1 }, (_, t) => kf(t, f(t / n), linKey))

test('simplifyKeys: a baked ease in-out becomes two eased keys, within tolerance at every frame', () => {
	const p = { a: 1, k: baked(30, (u) => [100 * smooth(u)]) }
	const before = p.k.map((k) => k.s[0])
	P.simplifyKeys({ layers: [layer({ ks: { o: p } })] })
	assert.equal(p.k.length, 2)
	const e = { x1: p.k[0].o.x[0], y1: p.k[0].o.y[0], x2: p.k[0].i.x[0], y2: p.k[0].i.y[0] }
	before.forEach((v, t) => assert.ok(Math.abs(100 * F.easeAt(e, t / 30) - v) < 0.3))
})

test('simplifyKeys: a baked path morph (straight-line vertices, one ease) becomes two keys', () => {
	const p = { a: 1, k: baked(24, (u) => [square(0, 0, 0, 1 + 2 * smooth(u))]) }
	P.simplifyKeys({ layers: [layer({ shapes: [{ ty: 'sh', ks: p }] })] })
	assert.equal(p.k.length, 2)
	assert.equal(typeof p.k[0].o.x, 'number') // shapes take one ease, not one per value
})

test('simplifyKeys: baked motion along an arc gets a motion path', () => {
	const p = { a: 1, k: baked(30, (u) => [100 * Math.cos((u * Math.PI) / 2), 100 * Math.sin((u * Math.PI) / 2)]) }
	P.simplifyKeys({ layers: [layer({ ks: { p } })] })
	assert.ok(p.k.length <= 3, p.k.length + ' keys')
	assert.ok(p.k[0].to && p.k[0].ti)
	assert.equal(typeof p.k[0].o.x, 'number') // lottie-web reads motion-path eases as numbers
})

test('fitMotionPath: no ease that dips below 0 (lottie-web jumps to the segment end)', () => {
	// along a quarter circle from a standstill: the least-squares ease lands just under 0
	const us = Array.from({ length: 21 }, (_, j) => j / 20)
	const prog = (u) => F.easeAt({ x1: 0.7, y1: 0, x2: 0.3, y2: 1 }, u)
	const pts = us.map((u) => [100 * Math.cos((prog(u) * Math.PI) / 2), 100 * Math.sin((prog(u) * Math.PI) / 2)])
	const f = F.fitMotionPath(us, pts, 0.5)
	assert.ok(f && f.ease.y1 >= 0 && f.ease.y2 >= 0, JSON.stringify(f && f.ease))
})

test('accuracy is on screen: a layer drawn 10× larger keeps finer values', () => {
	const make = (s) => ({ layers: [layer({ ks: { s: { a: 0, k: [s, s] }, o: { a: 0, k: 100 } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { c: false, v: [[1.23456, 0], [5, 5]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] } } }] })] })
	const a = make(100), b = make(1000)
	P.roundPrecision(a)
	P.roundPrecision(b)
	assert.equal(a.layers[0].shapes[0].ks.k.v[0][0], 1.23)
	assert.equal(b.layers[0].shapes[0].ks.k.v[0][0], 1.235)
})

test('recoverRigidMotion: squash and stretch while turning becomes non-uniform scale', () => {
	const keys = Array.from({ length: 8 }, (_, t) => {
		const sq = square(0, 0, 0)
		const sx = 1 + t * 0.1, sy = 1 - t * 0.05, th = t * 0.2
		sq.v = sq.v.map(([x, y]) => [x * sx * Math.cos(th) - y * sy * Math.sin(th) + t, x * sx * Math.sin(th) + y * sy * Math.cos(th)])
		return kf(t, [sq], linKey)
	})
	const tr = { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
	const g = { ty: 'gr', it: [{ ty: 'sh', ks: { a: 1, k: keys } }, { ty: 'fl' }, tr] }
	assert.equal(P.recoverRigidMotion({ layers: [layer({ shapes: [g] })] }), 1)
	const last = tr.s.k[7].s
	assert.ok(Math.abs(last[0] - 170) < 1e-6 && Math.abs(last[1] - 65) < 1e-6, String(last))
})

test('simplifyPaths: points on straight edges go, corners stay; per-point modifiers block it', () => {
	const pts = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [0, 10]]
	const sh = () => ({ ty: 'sh', ks: { a: 0, k: { c: true, v: pts, i: pts.map(() => [0, 0]), o: pts.map(() => [0, 0]) } } })
	const j = { layers: [layer({ shapes: [sh()] }), layer({ ind: 2, shapes: [sh(), { ty: 'rd', r: { a: 0, k: 4 } }] })] }
	assert.equal(P.simplifyPaths(j), 2)
	assert.deepEqual(j.layers[0].shapes[0].ks.k.v, [[0, 0], [10, 0], [10, 10], [0, 10]])
	assert.equal(j.layers[1].shapes[0].ks.k.v.length, 6)
})

test('simplifyPaths: a circle drawn with 16 points refits to fewer, staying on the circle', () => {
	const n = 16, r = 100, h = (4 / 3) * Math.tan(Math.PI / (2 * n)) * r
	const v = [], i = [], o = []
	for (let q = 0; q < n; q++) {
		const a = (q / n) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a)
		v.push([r * c, r * s])
		i.push([h * s, -h * c])
		o.push([-h * s, h * c])
	}
	const ks = { a: 0, k: { c: true, v, i, o } }
	P.simplifyPaths({ layers: [layer({ shapes: [{ ty: 'sh', ks }] })] })
	assert.ok(ks.k.v.length <= 6, ks.k.v.length + ' points')
})

test('simplifyPaths: a baked superellipse polyline refits as curves on every key, morphs in step', () => {
	const blob = (w, h, n = 200) => {
		const v = Array.from({ length: n }, (_, q) => {
			const a = (q / n) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a)
			return [w * Math.sign(c) * Math.abs(c) ** 0.5, h * Math.sign(s) * Math.abs(s) ** 0.5] // exponent 4
		})
		return { c: true, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]) }
	}
	const keys = [{ t: 0, h: 1, s: [blob(200, 100)] }, { t: 1, s: [blob(300, 150)] }, { t: 10, s: [blob(320, 160)] }]
	const before = keys.map((kf) => kf.s[0])
	const ks = { a: 1, k: JSON.parse(JSON.stringify(keys)) }
	assert.ok(P.simplifyPaths({ layers: [layer({ shapes: [{ ty: 'sh', ks }] })] }, { accuracy: 1 }) > 0)
	const counts = ks.k.map((kf) => kf.s[0].v.length)
	assert.ok(counts.every((c) => c === counts[0]) && counts[0] <= 24, counts.join())
	// every key stays on its original outline, both ways (tolerance: 1 px × fit share × half)
	const curve = (sh) => sh.v.flatMap((p, j) => {
		const b = (j + 1) % sh.v.length, q = sh.v[b], c1 = [p[0] + sh.o[j][0], p[1] + sh.o[j][1]], c2 = [q[0] + sh.i[b][0], q[1] + sh.i[b][1]]
		return Array.from({ length: 32 }, (_, n) => {
			const t = n / 32, r = 1 - t
			return [0, 1].map((x) => r * r * r * p[x] + 3 * r * r * t * c1[x] + 3 * r * t * t * c2[x] + t * t * t * q[x])
		})
	})
	const toSeg = (p, a, b) => {
		const d = [b[0] - a[0], b[1] - a[1]], l = d[0] ** 2 + d[1] ** 2
		const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l)) : 0
		return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t)
	}
	const near = (a, b) => Math.max(...a.map((p) => Math.min(...b.map((q, n) => toSeg(p, q, b[(n + 1) % b.length])))))
	ks.k.forEach((kf, j) => {
		const A = curve(before[j]), B = curve(kf.s[0])
		assert.ok(Math.max(near(A, B), near(B, A)) <= 0.36, 'key ' + j)
	})
})

// ---------- structure ----------

const tri = (x) => ({ c: true, v: [[x, 0], [x + 10, 0], [x + 5, 8]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] })
const idTr = () => ({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } })
const fill = (o = 100) => ({ ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: o } })

test('removeDoubledPaints: the outer copy of a paint Cavalry writes twice goes', () => {
	// Cavalry writes an editable path as gr{gr{path, fill}, fill}: painted twice in Lottie
	const shapes = [{ ty: 'gr', it: [{ ty: 'gr', it: [{ ty: 'sh', ks: { a: 0, k: tri(0) } }, fill(50), idTr()] }, fill(50), idTr()] }]
	const j = { layers: [layer({ shapes })] }
	assert.equal(P.removeDoubledPaints(j), 1)
	assert.deepEqual(j.layers[0].shapes[0].it.map((x) => x.ty), ['gr', 'tr'])
	// a different outer paint is a real second paint and stays
	const other = [{ ty: 'gr', it: [{ ty: 'gr', it: [{ ty: 'sh', ks: { a: 0, k: tri(0) } }, fill(50), idTr()] }, fill(20), idTr()] }]
	assert.equal(P.removeDoubledPaints({ layers: [layer({ shapes: other })] }), 0)
})

test('mergeShapeLayers: neighbouring shape layers become groups of one layer, transforms kept', () => {
	const mk = (ind, x, extra = {}) => layer({ ind, nm: 'L' + ind, ks: { p: { a: 0, k: [x, 5, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }, shapes: [{ ty: 'sh', ks: { a: 0, k: tri(0) } }, fill()], ...extra })
	const j = { layers: [mk(1, 10), mk(2, 20), mk(3, 30, { tt: 1 }), mk(4, 40), mk(5, 50, { parent: 4 })] }
	assert.equal(P.mergeShapeLayers(j), 1) // 1+2 merge; 3 has a matte, 4 is a parent, 5's parent differs
	const m = j.layers[0]
	assert.equal(j.layers.length, 4)
	assert.deepEqual(m.shapes.map((g) => g.nm), ['L1', 'L2'])
	assert.deepEqual(m.shapes[1].it.find((x) => x.ty === 'tr').p.k, [20, 5])
	// see-through layers with several paints keep their own layer (overlaps would change)
	const seeThrough = (ind) => mk(ind, 0, { ks: { o: { a: 0, k: 50 } }, shapes: [{ ty: 'sh', ks: { a: 0, k: tri(0) } }, fill(), { ty: 'st', w: { a: 0, k: 2 }, c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 } }] })
	assert.equal(P.mergeShapeLayers({ layers: [seeThrough(1), seeThrough(2)] }), 0)
})

test('mergeShapeGroups: same path twice takes both paints; matching paints share when shapes are apart', () => {
	const g = (x, paint) => ({ ty: 'gr', it: [{ ty: 'sh', ks: { a: 0, k: tri(x) } }, paint, idTr()] })
	const stroke = { ty: 'st', w: { a: 0, k: 2 }, c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 } }
	const same = { layers: [layer({ shapes: [g(0, stroke), g(0, fill())] })] }
	assert.equal(P.mergeShapeGroups(same), 1)
	assert.deepEqual(same.layers[0].shapes[0].it.map((x) => x.ty), ['sh', 'st', 'fl', 'tr']) // stroke stays over fill
	const apart = { layers: [layer({ shapes: [g(0, fill()), g(100, fill())] })] }
	assert.equal(P.mergeShapeGroups(apart), 1)
	const touching = { layers: [layer({ shapes: [g(0, fill()), g(5, fill())] })] }
	assert.equal(P.mergeShapeGroups(touching), 0)
})

test('equalisePathPoints: keys get one point count; shapes unchanged; holds where the count changes', () => {
	const shape = (pts) => ({ c: true, v: pts, i: pts.map(() => [0, 0]), o: pts.map((_, i) => [i, 0]) })
	const tri = shape([[0, 0], [10, 0], [5, 8]]), quad = shape([[0, 0], [10, 0], [10, 10], [0, 10]])
	const p = { a: 1, k: [kf(0, [tri], linKey), kf(1, [quad], linKey), kf(5, [quad])] }
	assert.equal(P.equalisePathPoints({ layers: [layer({ shapes: [{ ty: 'sh', ks: p }] })] }), 1)
	assert.deepEqual(p.k.map((k) => k.s[0].v.length), [4, 4, 4])
	assert.equal(p.k[0].h, 1) // 3 -> 4 points: hold
	assert.equal(p.k[1].h, undefined)
	const t = p.k[0].s[0]
	assert.deepEqual(t.v[3], [5, 8]) // padding sits on the last point
	assert.deepEqual(t.o[2], [0, 0]) // ...with a zero-length step to it
	assert.deepEqual(t.o[3], [2, 0]) // and the closing segment keeps the last point's handle
})
