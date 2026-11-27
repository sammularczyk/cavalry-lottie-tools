// End-to-end wiring test for injectSubMeshVisibility, driven by a stubbed
// Cavalry API. The pure maths (mask windows, the oscillator formula, the RDP
// thinning) is covered in submeshVisibility.test.mjs; this file covers the part
// that only exists in the exporter: which driver is resolved for which
// attribute, how several deformers combine, and where the value lands in the
// baked JSON.

import test from 'node:test'
import assert from 'node:assert/strict'

// The module reads `api` as a global, the way Cavalry's script host provides it.
// Build a scene stub, install it, then import the module for the first time.
const scene = {
	layers: {}, // id → { type, parent, niceName, attrs }
	conns: {}, // `${id}.${attr}` → fromId
	children: {}, // parentId → [ids]
}

function layer(id, type, attrs, parent) {
	scene.layers[id] = { type: type, attrs: attrs || {} }
	scene.children[id] = []
	if (parent) {
		scene.children[parent] = scene.children[parent] || []
		scene.children[parent].push(id)
	}
	return id
}

function connect(from, to, attr) {
	scene.conns[to + '.' + attr] = from
}

const stub = {
	getChildren: (id) => scene.children[id] || [],
	getLayerType: (id) => (scene.layers[id] ? scene.layers[id].type : null),
	hasAttribute: (id, a) => {
		const L = scene.layers[id]
		if (!L) return false
		if (/^[^.]+\.[0-9]+$/.test(a)) {
			// list slots: deformers.N / shapes.N exist only up to the last entry
			const cut = a.lastIndexOf('.')
			const head = a.slice(0, cut)
			const n = Number(a.slice(cut + 1))
			return Object.keys(scene.conns).some((k) => {
				if (!k.startsWith(id + '.' + head + '.')) return false
				return Number(k.slice((id + '.' + head + '.').length)) === n
			})
		}
		return Object.prototype.hasOwnProperty.call(L.attrs, a)
	},
	get: (id, a) => (scene.layers[id] ? scene.layers[id].attrs[a] : undefined),
	getInConnection: (id, a) => scene.conns[id + '.' + a] || '',
	getKeyframeTimes: (id, a) => (scene.layers[id] && scene.layers[id].keyframeTimes && scene.layers[id].keyframeTimes[a]) || [],
	setFrame: (f) => { stub._frame = f },
	getFrame: () => (stub._frame !== undefined ? stub._frame : 0),
	set: (id, dict) => {
		const L = scene.layers[id]
		if (L) Object.assign(L.attrs, dict)
	},
	connect: (from, _id, to, attr) => connect(from, to, attr),
	parent: () => {},
	create: (type, name) => layer('probe#' + type, type, {}, null),
	deleteLayer: () => {},
	getActiveComp: () => 'comp#1',
	getInConnectedAttributes: (id) => Object.keys(scene.conns).filter((k) => k.startsWith(id + '.')).map((k) => k.slice(id.length + 1)),
	// A four-copy duplicator: copy centres in a row, matching baked group centres.
	getBoundingBox: (ex) => {
		const idx = Number(scene.layers[ex].attrs.indices || 0)
		if (scene.centres) {
			const c = scene.centres[idx]
			return { x: c[0] - 20, y: c[1] - 20, width: 40, height: 40 }
		}
		return { x: idx * 40, y: 0, width: 40, height: 40 }
	},
	makeFolder: () => {},
}

globalThis.api = stub

const { injectSubMeshVisibility } = await import('../src/modules/cavalryExport.js')
const { measureTarget, decodeProbeLayer } = await import('../src/modules/subMeshMeasure.js')

const frames = [{ frame: 0 }, { frame: 15 }, { frame: 30 }, { frame: 45 }]

// A baked duplicator layer: four copy groups, each with a trivial path and a tr.
function bakedLayer() {
	const group = (x) => ({
		ty: 'gr',
		it: [
			{ ty: 'sh', ks: { a: 0, k: { v: [[x, 0], [x + 40, 0], [x + 40, 40], [x, 40]] } } },
			{ ty: 'fl' },
			{ ty: 'tr', p: { a: 0, k: [x + 20, 20] }, o: { a: 0, k: 100 } },
		],
	})
	return {
		ty: 4,
		nm: 'copies',
		shapes: [{ ty: 'gr', it: [group(0), group(40), group(80), group(120)] }],
	}
}

function buildScene(driverType, driverAttrs, attr) {
	for (const k of Object.keys(scene.layers)) delete scene.layers[k]
	scene.conns = {}
	scene.children = {}
	scene.centres = null
	layer('comp#1', 'compNode', {}, null)
	const dup = layer('duplicator#1', 'duplicator', { 'generator.count': { x: 4, y: 1 } }, 'comp#1')
	const sm = layer('subMesh#1', 'subMesh', {}, 'comp#1')
	connect(sm, dup, 'deformers.0')
	const driver = layer('driver#1', driverType, driverAttrs, 'comp#1')
	connect(driver, sm, attr)
	return { dup, sm, driver }
}

test('an oscillator on shapeOpacity writes a thinned fade onto every copy', () => {
	buildScene('oscillator', {
		minimum: 0,
		maximum: 100,
		frequency: 0.5,
		timeMode: 0,
		trigType: 0,
		waveType: 0,
		strength: 100,
		strengthToZero: false,
		timeOffset: 0,
		timeScale: 1,
		offset: 0,
	}, 'shapeOpacity')
	const json = { layers: [bakedLayer()] }
	const n = injectSubMeshVisibility('comp#1', json, frames)
	assert.equal(n, 4)
	const groups = json.layers[0].shapes[0].it
	for (const g of groups) {
		const o = g.it.find((i) => i.ty === 'tr').o
		assert.equal(o.a, 1)
		// 0.5 cycles/s over 45 frames at 60 fps = 3/8 of a cycle: 50 → 85.36 → 85.36 → 50
		assert.ok(o.k.length >= 2)
		assert.ok(Math.abs(o.k[0].s[0] - 50) < 0.01, `first key ${o.k[0].s[0]}`)
	}
})

test('a visibility gate writes hold keys, and an all-hidden copy is marked hd', () => {
	// A window that shows only the first copy: index 0 visible, 1..3 hidden.
	buildScene('visibility', { start: 0, end: 25, travel: 0, invert: false, alwaysOn: '', alwaysOff: '' }, 'shapeVisibility')
	const json = { layers: [bakedLayer()] }
	const n = injectSubMeshVisibility('comp#1', json, frames)
	assert.equal(n, 3)
	const groups = json.layers[0].shapes[0].it
	// copy 0 stays visible → untouched
	assert.equal(groups[0].it.find((i) => i.ty === 'tr').o.a, 0)
	// copies 1..3 are hidden at every frame → hd, stripped later by removeHidden
	for (const gi of [1, 2, 3]) {
		assert.equal(groups[gi].hd, true, `copy ${gi}`)
	}
})

test('a gate and a fade on the same duplicator multiply', () => {
	const { sm1 } = (() => {
		const s = buildScene('visibility', { start: 0, end: 25, travel: 0, invert: false, alwaysOn: '', alwaysOff: '' }, 'shapeVisibility')
		// add a second deformer on the same duplicator carrying an oscillator fade
		const sm2 = layer('subMesh#2', 'subMesh', {}, 'comp#1')
		connect(sm2, s.dup, 'deformers.1')
		const osc = layer('osc#1', 'oscillator', {
			minimum: 0, maximum: 100, frequency: 0.5, timeMode: 0, trigType: 0, waveType: 0,
			strength: 100, strengthToZero: false, timeOffset: 0, timeScale: 1, offset: 0,
		}, 'comp#1')
		connect(osc, sm2, 'shapeOpacity')
		return { sm1: s }
	})()
	assert.ok(sm1)
	const json = { layers: [bakedLayer()] }
	injectSubMeshVisibility('comp#1', json, frames)
	const groups = json.layers[0].shapes[0].it
	// copy 0 is inside the gate and keeps its fade
	const o = groups[0].it.find((i) => i.ty === 'tr').o
	assert.equal(o.a, 1)
	// copies 1..3 are gated off, so the product is 0 everywhere → hd
	for (const gi of [1, 2, 3]) assert.equal(groups[gi].hd, true, `copy ${gi}`)
})

test('a seeded random driver leaves the copies visible instead of guessing', () => {
	buildScene('random', { seed: 3, minimum: 0, maximum: 1, useIndex: true, useLayerAsSeed: false }, 'shapeVisibility')
	const json = { layers: [bakedLayer()] }
	const n = injectSubMeshVisibility('comp#1', json, frames)
	assert.equal(n, 0)
	for (const g of json.layers[0].shapes[0].it) {
		assert.equal(g.hd, undefined)
		assert.equal(g.it.find((i) => i.ty === 'tr').o.a, 0)
	}
})

test('a layer-seeded random driver is refused the same way', () => {
	buildScene('random', { seed: 3, minimum: 0, maximum: 1, useIndex: true, useLayerAsSeed: true }, 'shapeVisibility')
	const json = { layers: [bakedLayer()] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames), 0)
})

test('an oscillator whose timeOffset is driven is refused, not evaluated flat', () => {
	const s = buildScene('oscillator', {
		minimum: 0, maximum: 100, frequency: 1, timeMode: 0, trigType: 0, waveType: 0,
		strength: 100, strengthToZero: false, timeOffset: 0, timeScale: 1, offset: 0,
	}, 'shapeOpacity')
	const rnd = layer('random#9', 'random', { seed: 1, minimum: 0, maximum: 10, useIndex: true }, 'comp#1')
	connect(rnd, s.driver, 'timeOffset')
	const json = { layers: [bakedLayer()] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames), 0)
})

test('an index-pure javascript driver gates on its expression', () => {
	buildScene('javaScript', { expression: 'ctx.index < 2 ? 1 : 0;' }, 'shapeVisibility')
	const json = { layers: [bakedLayer()] }
	const n = injectSubMeshVisibility('comp#1', json, frames)
	assert.equal(n, 2)
	const groups = json.layers[0].shapes[0].it
	assert.equal(groups[0].it.find((i) => i.ty === 'tr').o.a, 0)
	assert.equal(groups[1].it.find((i) => i.ty === 'tr').o.a, 0)
	assert.equal(groups[2].hd, true)
	assert.equal(groups[3].hd, true)
})

test('an already-animated tr.o is never clobbered', () => {
	buildScene('visibility', { start: 0, end: 25, travel: 0, invert: false, alwaysOn: '', alwaysOff: '' }, 'shapeVisibility')
	const json = { layers: [bakedLayer()] }
	const existing = { a: 1, k: [{ t: 0, s: [42] }] }
	json.layers[0].shapes[0].it[0].it.find((i) => i.ty === 'tr').o = existing
	const n = injectSubMeshVisibility('comp#1', json, frames)
	// copy 0's own opacity is animated, so it is skipped; copies 1..3 are hd
	assert.equal(n, 3)
	assert.equal(json.layers[0].shapes[0].it[0].it.find((i) => i.ty === 'tr').o, existing)
})

// Baked groups at arbitrary Lottie centres (y down), one 40 px square each.
function bakedAt(centres) {
	const group = ([x, y]) => ({
		ty: 'gr',
		it: [
			{ ty: 'sh', ks: { a: 0, k: { v: [[x - 20, y - 20], [x + 20, y - 20], [x + 20, y + 20], [x - 20, y + 20]] } } },
			{ ty: 'fl' },
			{ ty: 'tr', o: { a: 0, k: 100 } },
		],
	})
	return { ty: 4, nm: 'copies', shapes: [{ ty: 'gr', it: centres.map(group) }] }
}

const trO = (g) => g.it.find((i) => i.ty === 'tr').o

test('index sources pair through the writer\'s y flip', () => {
	// 2x2 grid, ids bottom row first in Cavalry (y up). The writer flips y, so
	// the bottom row bakes at the LARGER Lottie y. Baked in reverse id order.
	buildScene('javaScript', { expression: 'ctx.index < 2 ? 1 : 0;' }, 'shapeVisibility')
	scene.layers['duplicator#1'].attrs['generator.count'] = { x: 2, y: 2 }
	scene.centres = [[-20, -20], [20, -20], [-20, 20], [20, 20]]
	const json = { layers: [bakedAt([[520, 280], [480, 280], [520, 320], [480, 320]])] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames), 2)
	const g = json.layers[0].shapes[0].it
	assert.equal(g[0].hd, true) // top row (Lottie y 280) = ids 2, 3
	assert.equal(g[1].hd, true)
	assert.equal(g[2].hd, undefined) // bottom row (Lottie y 320) = ids 0, 1
	assert.equal(g[3].hd, undefined)
})

test('measured random values gate copies by baked position', () => {
	const { sm, driver } = buildScene('value', {}, 'shapeVisibility')
	// Probe centres sit in another frame and order; only their layout matters.
	const copies = [
		{ c: [1120, 20], v: 0.2 }, // matches group at x 120
		{ c: [1080, 20], v: 0.5 }, // x 80 — exactly at the threshold, visible
		{ c: [1040, 20], v: 0.49 }, // x 40
		{ c: [1000, 20], v: 0.9 }, // x 0
	]
	const measured = { [sm]: { shapeVisibility: { kind: 'value', node: driver, copies } } }
	const json = { layers: [bakedLayer()] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames, measured), 2)
	const g = json.layers[0].shapes[0].it
	assert.equal(g[0].hd, undefined)
	assert.equal(g[1].hd, true)
	assert.equal(g[2].hd, undefined)
	assert.equal(g[3].hd, true)
})

test('a measurement taken for another driver is ignored', () => {
	const { sm } = buildScene('value', {}, 'shapeVisibility')
	const copies = [0, 40, 80, 120].map((x) => ({ c: [x + 20, 20], v: 0 }))
	const measured = { [sm]: { shapeVisibility: { kind: 'value', node: 'value#other', copies } } }
	const json = { layers: [bakedLayer()] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames, measured), 0)
})

test('measured opacity values are clamped to 0..100', () => {
	const { sm, driver } = buildScene('value', {}, 'shapeOpacity')
	const copies = [[0, -50], [40, 150], [80, 30], [120, 100]].map(([x, v]) => ({ c: [x + 20, 20], v }))
	const measured = { [sm]: { shapeOpacity: { kind: 'value', node: driver, copies } } }
	const json = { layers: [bakedLayer()] }
	injectSubMeshVisibility('comp#1', json, frames, measured)
	const g = json.layers[0].shapes[0].it
	assert.equal(g[0].hd, true)
	assert.equal(trO(g[1]).a, 0)
	assert.equal(trO(g[1]).k, 100)
	assert.equal(trO(g[3]).k, 100)
	// 30 at every frame: a constant written as a held value
	const o2 = trO(g[2])
	const vals = o2.a ? o2.k.map((k) => k.s[0]) : [o2.k]
	assert.ok(vals.every((v) => Math.abs(v - 30) < 0.01), JSON.stringify(o2))
})

test('a measured oscillator phase shifts each copy\'s fade (timeOffset in seconds)', () => {
	const s = buildScene('oscillator', {
		minimum: 0, maximum: 100, frequency: 0.5, timeMode: 0, trigType: 0, waveType: 0,
		strength: 100, strengthToZero: false, timeOffset: 0, timeScale: 1, offset: 0,
	}, 'shapeOpacity')
	const rnd = layer('random#9', 'random', { seed: 1, minimum: 0, maximum: 1, useIndex: true }, 'comp#1')
	connect(rnd, s.driver, 'timeOffset')
	// The probe reads the oscillator's own output at two playhead frames. Copies
	// carry timeOffsets 0 / 0.5 / 1 / 1.5 s; at 0.5 Hz that is mid-line, peak,
	// mid-line, trough at frame 0. Sampling at 15 and 45 checks the solver's
	// phase is shifted back to frame 0.
	const out = (f, off) => 50 + 50 * Math.sin(2 * Math.PI * 0.5 * (f / 60 + off))
	const copies = [[0, 0], [40, 0.5], [80, 1], [120, 1.5]].map(([x, off]) => ({ c: [x + 20, 20], v: out(15, off), vs: [out(15, off), out(45, off)] }))
	const measured = { [s.sm]: { shapeOpacity: { kind: 'phase', node: s.driver, frames: [15, 45], copies } } }
	const json = { layers: [bakedLayer()] }
	assert.equal(injectSubMeshVisibility('comp#1', json, frames, measured), 4)
	const first = json.layers[0].shapes[0].it.map((g) => trO(g).k[0].s[0])
	assert.deepEqual(first.map((v) => Math.round(v)), [50, 100, 50, 0])
})

test('a random with an animating seed measures at its integer-crossing frames', () => {
	const { sm, driver } = buildScene('random', { minimum: 0, maximum: 1, useIndex: true, useLayerAsSeed: false }, 'shapeVisibility')
	scene.layers['comp#1'].attrs = { startFrame: 0, endFrame: 90 }
	// Give the driver a keyframed seed 0 → 8 over [0, 82] (linear).
	scene.layers[driver].keyframeTimes = { seed: [0, 82] }
	// IntegerCrossings reads floor(seed) per frame; model seed(t) = 8t/82.
	scene.layers[driver].attrs.seed = 0 // placeholder
	const origGet = stub.get
	stub.get = (id, a) => {
		if (id === driver && a === 'seed') return (8 * stub.getFrame()) / 82
		return scene.layers[id].attrs[a]
	}
	const t = measureTarget(sm, 'shapeVisibility', 'comp#1')
	stub.get = origGet
	assert.equal(t && t.kind, 'value')
	assert.equal(t.node, driver)
	assert.deepEqual(t.frames, [0, 11, 21, 31, 41, 52, 62, 72, 82])
	delete scene.layers[driver].keyframeTimes
})

test('a measured multi-frame value reproduces as hold keys', () => {
	const { sm, driver } = buildScene('value', {}, 'shapeVisibility')
	// Copy values at frames [0, 11, 21, ...], piecewise-constant gates.
	const copies = [
		{ c: [20, 20], v: 0.1, vs: [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1] }, // at x 0
		{ c: [60, 20], v: 0.9, vs: [0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9] }, // x 40
	]
	const measured = { [sm]: { shapeVisibility: { kind: 'value', node: driver, frames: [0, 11, 21, 31, 41, 52, 62, 72, 82], copies } } }
	const json = { layers: [bakedLayer()] }
	// frames list drives the export; inject over export frames 0..30.
	const expFrames = []
	for (let f = 0; f <= 30; f++) expFrames.push({ frame: f })
	assert.equal(injectSubMeshVisibility('comp#1', json, expFrames, measured), 2)
	const g = json.layers[0].shapes[0].it
	// copy at x 0 (Lottie y 280 = id 2): toggles 100/0/100 → hold keys at 0,11,21
	const o = trO(g[2])
	assert.equal(o.a, 1)
	const keys = o.k.map((k) => [k.t, k.s[0]])
	assert.deepEqual(keys[0], [0, 100])
	assert.deepEqual(keys[1], [11, 0])
	assert.deepEqual(keys[2], [21, 100])
	// a gate must STEP between values, so every key is a hard hold (h:1), no easing
	assert.deepEqual(o.k.map((k) => k.h), [1, 1, 1])
})

test('measureTarget routes each driver', () => {
	let s = buildScene('value', {}, 'shapeVisibility')
	assert.deepEqual(measureTarget(s.sm, 'shapeVisibility', 'comp#1'), { kind: 'value', node: s.driver, frames: [0], interp: true })
	s = buildScene('visibility', {}, 'shapeVisibility')
	assert.equal(measureTarget(s.sm, 'shapeVisibility', 'comp#1'), null)
	s = buildScene('javaScript', { expression: 'ctx.index % 2' }, 'shapeVisibility')
	assert.equal(measureTarget(s.sm, 'shapeVisibility', 'comp#1'), null)
	s = buildScene('random', { useLayerAsSeed: true }, 'shapeVisibility')
	assert.equal(measureTarget(s.sm, 'shapeVisibility', 'comp#1'), null)
	s = buildScene('oscillator', { frequency: 0.5, waveType: 0, trigType: 0, minimum: 0, maximum: 100 }, 'shapeOpacity')
	scene.layers['comp#1'].attrs = { startFrame: 0, endFrame: 200 }
	// An undriven timeOffset is evaluated analytically, so nothing is measured.
	assert.equal(measureTarget(s.sm, 'shapeOpacity', 'comp#1'), null)
	const rnd = layer('random#9', 'random', {}, 'comp#1')
	connect(rnd, s.driver, 'timeOffset')
	// The oscillator's own output is measured, a quarter cycle apart (30 frames at 0.5 Hz).
	assert.deepEqual(measureTarget(s.sm, 'shapeOpacity', 'comp#1'), { kind: 'phase', node: s.driver, frames: [0, 30] })
	scene.layers[s.driver].attrs.waveType = 2
	assert.equal(measureTarget(s.sm, 'shapeOpacity', 'comp#1'), null)
})

test('decodeProbeLayer reads each copy\'s value from its sampler width', () => {
	// width = 100 * (value * 0.004 + 0.5) at frame 0
	const sq = (x, w) => ({ ty: 'gr', it: [{ ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [{ v: [[x - w / 2, -1], [x + w / 2, -1], [x + w / 2, 1], [x - w / 2, 1]] }] }, { t: 2 }] } }, { ty: 'tr' }] })
	const L = { ty: 4, shapes: [{ ty: 'gr', it: [sq(10, 50.16), sq(30, 48.7), sq(50, 56.92), sq(70, 67.2)] }] }
	const out = decodeProbeLayer(L)
	assert.deepEqual(out.map((o) => Math.round(o.v * 1000) / 1000), [0.4, -3.25, 17.3, 43])
	assert.deepEqual(out[2].c, [50, 0])
	assert.equal(decodeProbeLayer({ ty: 4, shapes: [] }), null)
})

test('a rig inside a referenced comp is found, and its baked layer can sit in a precomp asset', () => {
	for (const k of Object.keys(scene.layers)) delete scene.layers[k]
	scene.conns = {}
	scene.children = {}
	scene.centres = null
	// The exported comp only holds a reference; the duplicator and subMesh are
	// inside the referenced comp, exactly like MangoGrid inside the card.
	layer('comp#1', 'compNode', {}, null)
	layer('inner#1', 'compNode', {}, null)
	const ref = layer('ref#1', 'compositionReference', {}, 'comp#1')
	connect('inner#1.id', ref, 'composition')
	const dup = layer('duplicator#1', 'duplicator', { 'generator.count': { x: 4, y: 1 } }, 'inner#1')
	const sm = layer('subMesh#1', 'subMesh', {}, 'inner#1')
	connect(sm, dup, 'deformers.0')
	const gate = layer('visibility#1', 'visibility', { start: 0, end: 25, travel: 0, invert: false, alwaysOn: '', alwaysOff: '' }, 'inner#1')
	connect(gate, sm, 'shapeVisibility')
	// The bake lands inside a precomp asset, not the root layer list.
	const json = { layers: [{ ty: 0, refId: 'comp_0' }], assets: [{ id: 'comp_0', layers: [bakedLayer()] }] }
	const n = injectSubMeshVisibility('comp#1', json, frames)
	assert.equal(n, 3)
	const groups = json.assets[0].layers[0].shapes[0].it
	assert.equal(groups[0].it.find((i) => i.ty === 'tr').o.a, 0)
	for (const gi of [1, 2, 3]) assert.equal(groups[gi].hd, true, `copy ${gi}`)
})

test('a shared subMesh feeding two equal-count duplicators culls both baked layers', () => {
	for (const k of Object.keys(scene.layers)) delete scene.layers[k]
	scene.conns = {}
	scene.children = {}
	scene.centres = null
	layer('comp#1', 'compNode', {}, null)
	const dup1 = layer('duplicator#1', 'duplicator', { 'generator.input.count': { x: 4, y: 1 } }, 'comp#1')
	const dup2 = layer('duplicator#2', 'duplicator', { 'generator.input.count': { x: 4, y: 1 } }, 'comp#1')
	scene.layers[dup1].niceName = 'Rainbow Grid'
	scene.layers[dup2].niceName = 'Background Grid'
	const sm = layer('subMesh#1', 'subMesh', {}, 'comp#1')
	connect(sm, dup1, 'deformers.0')
	connect(sm, dup2, 'deformers.0')
	const val = layer('value#3', 'value', {}, 'comp#1')
	connect(val, sm, 'shapeOpacity')
	const origNiceName = stub.getNiceName
	stub.getNiceName = (id) => (scene.layers[id] && scene.layers[id].niceName) || id
	const copies = [
		{ c: [20, 20], v: 100, vs: [100] },
		{ c: [60, 20], v: 0, vs: [0] },
		{ c: [100, 20], v: 0, vs: [0] },
		{ c: [140, 20], v: 100, vs: [100] },
	]
	const measured = {
		'duplicator#1:subMesh#1': { shapeOpacity: { kind: 'value', node: val, frames: [0], copies } },
		'duplicator#2:subMesh#1': { shapeOpacity: { kind: 'value', node: val, frames: [0], copies } },
	}
	const layerA = bakedLayer()
	layerA.nm = 'Rainbow Grid'
	const layerB = bakedLayer()
	layerB.nm = 'Background Grid'
	const json = { layers: [layerA, layerB] }
	const n = injectSubMeshVisibility('comp#1', json, frames, measured)
	stub.getNiceName = origNiceName
	assert.equal(n, 4)
	for (const L of [layerA, layerB]) {
		const groups = L.shapes[0].it
		assert.equal(groups[0].hd, undefined)
		assert.equal(groups[1].hd, true)
		assert.equal(groups[2].hd, true)
		assert.equal(groups[3].hd, undefined)
	}
})
