import test from 'node:test'
import assert from 'node:assert/strict'
import {
	parseIndexList,
	visibilitySequenceMask,
	expressionMask,
	expressionIsIndexPure,
	maskToOpacityProp,
	valuesToOpacityProp,
	applyValuesToGroups,
	opacityValueAt,
	oscillatorValueAt,
	oscillatorSeries,
	pairByCentre,
	oscillatorPhaseFromSamples,
	phaseSampleGap,
	alignedPairs,
} from '../src/modules/submeshVisibility.js'

const seq = (over) => ({ start: 0, end: 100, travel: 0, invert: false, alwaysOn: '', alwaysOff: '', ...over })

test('parseIndexList handles plain lists and ranges', () => {
	assert.deepEqual(parseIndexList('1,3,5:8'), [1, 3, 5, 6, 7, 8])
	assert.deepEqual(parseIndexList('2:4,1'), [2, 3, 4, 1])
	assert.deepEqual(parseIndexList(''), [])
	assert.deepEqual(parseIndexList('x, : , 4'), [4])
})

test('full window keeps everything visible', () => {
	assert.deepEqual(visibilitySequenceMask(seq(), 4), [1, 1, 1, 1])
})

test('half window shows the first half', () => {
	assert.deepEqual(visibilitySequenceMask(seq({ start: 0, end: 50 }), 4), [1, 1, 0, 0])
})

test('invert flips the mask', () => {
	assert.deepEqual(visibilitySequenceMask(seq({ start: 0, end: 50, invert: true }), 4), [0, 0, 1, 1])
})

test('travel shifts the window forward one submesh per step', () => {
	// 2 of 6 visible, travelling: window [0,2) → [1,3) → [2,4)
	assert.deepEqual(visibilitySequenceMask(seq({ end: 33.4, travel: 0 }), 6)[0], 1)
	assert.deepEqual(visibilitySequenceMask(seq({ end: 33.4, travel: 1 }), 6)[1], 1)
	assert.deepEqual(visibilitySequenceMask(seq({ end: 33.4, travel: 2 }), 6)[2], 1)
})

test('alwaysOn and alwaysOff override the window (out-of-range indices ignored)', () => {
	assert.deepEqual(visibilitySequenceMask(seq({ start: 0, end: 50, alwaysOn: '3', alwaysOff: '1' }), 4), [0, 1, 1, 0])
	assert.deepEqual(visibilitySequenceMask(seq({ alwaysOff: '1,4' }), 4), [0, 1, 1, 0])
})

test('expressionMask evaluates per index with ctx', () => {
	assert.deepEqual(expressionMask('ctx.index >= 2 ? 0 : 1;', 4), [1, 1, 0, 0])
	assert.deepEqual(expressionMask('ctx.index % 2;', 4), [0, 1, 0, 1])
	assert.deepEqual(expressionMask('1;', 3), [1, 1, 1])
	assert.deepEqual(expressionMask('0;', 3), [0, 0, 0])
})

test('unpure or broken expressions give null (unknown)', () => {
	assert.equal(expressionMask('ctx.saveObject("x", {});', 2), null)
	assert.equal(expressionMask('ctx.hasObject("x");', 2), null)
	assert.equal(expressionMask('this is not js', 2), null)
	assert.equal(expressionIsIndexPure('ctx.index;'), true)
})

const frames = [{ frame: 0 }, { frame: 1 }, { frame: 2 }]

const group = (x, y) => ({
	ty: 'gr',
	it: [
		{ ty: 'sh', ks: { a: 0, k: { v: [[x - 1, y - 1], [x + 1, y + 1]] } } },
		{ ty: 'fl' },
		{ ty: 'tr', p: { a: 0, k: [x, y] }, o: { a: 0, k: 100 } },
	],
})

test('maskToOpacityProp writes a key only where the value flips', () => {
	const prop = maskToOpacityProp([1, 0, 1], frames)
	assert.equal(prop.a, 1)
	assert.deepEqual(prop.k.map((k) => [k.t, k.s[0]]), [[0, 100], [1, 0], [2, 100]])
})

test('maskToOpacityProp collapses equal-value runs into one hold key', () => {
	const f = [{ frame: 0 }, { frame: 1 }, { frame: 2 }, { frame: 3 }, { frame: 4 }]
	const prop = maskToOpacityProp([1, 1, 1, 0, 0], f)
	assert.deepEqual(prop.k.map((k) => [k.t, k.s[0]]), [[0, 100], [3, 0]])
	// a mask that never flips is a single key, not one per frame
	assert.deepEqual(maskToOpacityProp([0, 0, 0], f).k.map((k) => k.t), [0])
	// hold interpolation: the player must step, not ease, so each key is an h:1 hold
	assert.deepEqual(prop.k[0].h, 1)
})

test('pairByCentre matches by position, not ordinal', () => {
	// The writer bakes each row right-to-left; indices run left-to-right.
	const copyCentres = [[-100, -100], [0, -100], [100, -100]]
	const groupCentres = [[100, -100], [0, -100], [-100, -100]]
	assert.deepEqual(pairByCentre(copyCentres, groupCentres), [2, 1, 0])
})

test('pairByCentre handles a sort that scrambles every index', () => {
	const copyCentres = [[0, 0], [10, 0], [20, 0], [30, 0]]
	const groupCentres = [[30, 0], [10, 0], [0, 0], [20, 0]]
	assert.deepEqual(pairByCentre(copyCentres, groupCentres), [2, 1, 3, 0])
})

test('pairByCentre leaves a culled copy unmapped and never reuses a group', () => {
	// Two copies, one baked group: only the closer one may claim it.
	const copyCentres = [[0, 0], [100, 100]]
	const groupCentres = [[0, 0]]
	assert.deepEqual(pairByCentre(copyCentres, groupCentres), [0, null])
})

test('pairByCentre returns null without centres', () => {
	assert.equal(pairByCentre(null, [[0, 0]]), null)
	assert.equal(pairByCentre([[0, 0]], null), null)
})

// ---------------------------------------------------------------------------
// Oscillator: a closed-form wave, so its per-copy opacity is computed rather
// than measured. The expected numbers below are live Cavalry reads (oscillator
// routed into a subMesh's shapeRotation and sampled per frame), not restatements
// of the formula.
// ---------------------------------------------------------------------------

// Live reads are exact decimals; the formula is floats. Compare rounded to 4
// decimals, which is also the precision Cavalry's own readout had.
const r4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4)

const osc = (over) => ({
	minimum: 0,
	maximum: 100,
	frequency: 1,
	timeMode: 0,
	trigType: 0,
	waveType: 0,
	strength: 100,
	strengthToZero: false,
	timeOffset: 0,
	timeScale: 1,
	offset: 0,
	fps: 60,
	...over,
})

test('oscillator: sine at 1 Hz / 60 fps hits min at half a cycle', () => {
	// sampled live at frames 0..60 one frame apart
	assert.deepEqual([0, 15, 30, 45, 60].map((t) => r4(oscillatorValueAt(osc(), t))), [50, 100, 50, 0, 50])
	assert.equal(r4(oscillatorValueAt(osc(), 10)), 93.3013)
})

test('oscillator: min/max span the output, centre and amplitude follow them', () => {
	const c = osc({ minimum: -50, maximum: 50 })
	assert.deepEqual([0, 15, 30, 45].map((t) => r4(oscillatorValueAt(c, t))), [0, 50, 0, -50])
})

test('oscillator: cosine and a quarter-second timeOffset agree exactly', () => {
	const frames = [0, 5, 10, 20, 30, 45, 60]
	const cos = frames.map((f) => r4(oscillatorValueAt(osc({ trigType: 1 }), f)))
	const off = frames.map((f) => r4(oscillatorValueAt(osc({ timeOffset: 0.25 }), f)))
	assert.deepEqual(cos, off)
	assert.equal(r4(oscillatorValueAt(osc({ trigType: 1 }), 0)), 100)
})

test('oscillator: sine, triangle and sawtooth share the sine phase; cosine leads', () => {
	const f = [0, 15, 30, 45]
	assert.deepEqual(f.map((t) => r4(oscillatorValueAt(osc({ waveType: 2 }), t))), [50, 100, 50, 0])
	assert.deepEqual(f.map((t) => r4(oscillatorValueAt(osc({ waveType: 3 }), t))), [50, 75, 0, 25])
	assert.deepEqual(f.map((t) => r4(oscillatorValueAt(osc({ trigType: 1, waveType: 2 }), t))), [100, 50, 0, 50])
	// square saturates and only flips at the half cycle
	assert.deepEqual([0, 29, 30].map((t) => r4(oscillatorValueAt(osc({ waveType: 1 }), t))), [100, 100, 0])
})

test('oscillator: Strength scales to zero or to the minimum by its flag', () => {
	// measured at minimum 20 / maximum 100 (fixtures: 30/50/30/10/30 and 40/60/40/20/40)
	const c = osc({ minimum: 20, maximum: 100 })
	const at = (cfg) => [0, 15, 30, 45].map((t) => r4(oscillatorValueAt(cfg, t)))
	assert.deepEqual(at({ ...c, strength: 50, strengthToZero: true }), [30, 50, 30, 10])
	assert.deepEqual(at({ ...c, strength: 50, strengthToZero: false }), [40, 60, 40, 20])
	assert.deepEqual(at({ ...c, strength: 0, strengthToZero: true }), [0, 0, 0, 0])
	assert.deepEqual(at({ ...c, strength: 0, strengthToZero: false }), [20, 20, 20, 20])
})

test('oscillator: offset adds after, negative frequency mirrors, BPM divides by 60', () => {
	const c = osc({ minimum: 20, maximum: 100 })
	assert.deepEqual([0, 15, 30, 45].map((t) => r4(oscillatorValueAt({ ...c, offset: 25 }, t))), [85, 125, 85, 45])
	assert.deepEqual([0, 15, 30, 45].map((t) => r4(oscillatorValueAt({ ...c, frequency: -1 }, t))), [60, 20, 60, 100])
	// 60 frames at 60 fps = 1 s. 60 cycles/min = 1 Hz, so it matches frequency 1.
	const bpm = osc({ frequency: 60, timeMode: 1 })
	assert.equal(r4(oscillatorValueAt(bpm, 15)), r4(oscillatorValueAt(osc(), 15)))
})

test('oscillator: tangent and custom waves refuse rather than guess', () => {
	assert.equal(oscillatorValueAt(osc({ trigType: 2 }), 10), null)
	assert.equal(oscillatorValueAt(osc({ waveType: 4 }), 10), null)
})

test('oscillatorSeries walks the frame list and threads a per-copy offset', () => {
	const f = [{ frame: 0 }, { frame: 15 }, { frame: 30 }]
	assert.deepEqual(oscillatorSeries(osc(), f).map(r4), [50, 100, 50])
	assert.equal(oscillatorSeries(osc({ trigType: 2 }), f), null)
	assert.equal(oscillatorSeries(osc(), []), null)
	// a quarter-second offset is a quarter cycle: the series starts where the
	// cosine starts.
	assert.deepEqual(oscillatorSeries(osc(), f, 0.25).map(r4), [100, 50, 0])
})

test('valuesToOpacityProp thins a smooth curve to within its tolerance', () => {
	const f = []
	for (let i = 0; i <= 60; i++) f.push({ frame: i })
	const vals = f.map((p) => 50 + 50 * Math.sin((2 * Math.PI * p.frame) / 60))
	const prop = valuesToOpacityProp(vals, f, 0.75)
	assert.equal(prop.a, 1)
	assert.equal(prop.k[0].t, 0)
	assert.equal(prop.k[prop.k.length - 1].t, 60)
	assert.ok(prop.k.length < vals.length, 'a sine must not need a key per frame')
	// linear interpolation between keys stays within tolerance of the samples
	const keys = prop.k
	let worst = 0
	for (let i = 0; i < vals.length; i++) {
		let j = 0
		while (j < keys.length - 1 && keys[j + 1].t <= f[i].frame) j++
		const a = keys[j]
		const b = keys[Math.min(j + 1, keys.length - 1)]
		const t = b.t === a.t ? 0 : (f[i].frame - a.t) / (b.t - a.t)
		const got = a.s[0] + (b.s[0] - a.s[0]) * t
		worst = Math.max(worst, Math.abs(got - vals[i]))
	}
	assert.ok(worst <= 0.75 + 1e-6, `interpolated error ${worst} exceeds tolerance`)
	assert.deepEqual(prop.k[0].i, { x: [0.5], y: [0.5] })
})

test('valuesToOpacityProp keeps a straight line as two keys', () => {
	const f = [{ frame: 0 }, { frame: 10 }, { frame: 20 }]
	const prop = valuesToOpacityProp([0, 50, 100], f, 0.75)
	assert.deepEqual(prop.k.map((k) => [k.t, k.s[0]]), [[0, 0], [20, 100]])
})

test('applyValuesToGroups: full leaves alone, zero culls, fade animates', () => {
	const groups = [group(0, 0), group(10, 0), group(20, 0), group(30, 0)]
	const vals = {
		0: [100, 100, 100], // never changes → untouched
		1: [0, 0, 0], // never drawn → hd
		2: [100, 50, 0], // fade → animated curve
		3: [100, 0, 100], // gate → hold keys
	}
	const n = applyValuesToGroups(groups, vals, frames)
	assert.equal(n, 3)
	assert.equal(groups[0].hd, undefined)
	assert.equal(groups[1].hd, true)
	const fade = groups[2].it.find((i) => i.ty === 'tr').o
	assert.equal(fade.a, 1)
	assert.equal(fade.k[0].s[0], 100)
	assert.equal(fade.k[fade.k.length - 1].s[0], 0)
	const gate = groups[3].it.find((i) => i.ty === 'tr').o
	assert.deepEqual(gate.k.map((k) => [k.t, k.s[0]]), [[0, 100], [1, 0], [2, 100]])
	// a gate steps between values → hard holds, no easing
	assert.deepEqual(gate.k.map((k) => k.h), [1, 1, 1])
})

test('applyValuesToGroups leaves a copy alone when any sample is unknown', () => {
	const groups = [group(0, 0)]
	const n = applyValuesToGroups(groups, { 0: [100, null, 0] }, frames)
	assert.equal(n, 0)
	assert.equal(groups[0].hd, undefined)
	assert.equal(groups[0].it.find((i) => i.ty === 'tr').o.a, 0)
})

test('applyValuesToGroups multiplies into an already-animated opacity', () => {
	const g = group(0, 0)
	g.it.find((i) => i.ty === 'tr').o = {
		a: 1,
		k: [
			{ t: 0, s: [100], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } },
			{ t: 2, s: [0], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } },
		],
	}
	const n = applyValuesToGroups([g], { 0: [0, 100, 100] }, frames)
	assert.equal(n, 1)
	const o = g.it.find((i) => i.ty === 'tr').o
	assert.equal(o.a, 1)
	// frame 0: 0 × 100 = 0; frame 1: 100 × 50 = 50; frame 2: 100 × 0 = 0
	assert.deepEqual(o.k.map((k) => [k.t, k.s[0]]), [[0, 0], [1, 50], [2, 0]])
})

test('applyValuesToGroups leaves a copy alone when its authored opacity is zero throughout', () => {
	const g = group(0, 0)
	g.it.find((i) => i.ty === 'tr').o = { a: 1, k: [{ t: 0, s: [0] }, { t: 2, s: [0] }] }
	const n = applyValuesToGroups([g], { 0: [100, 100, 100] }, frames)
	assert.equal(n, 0)
	assert.equal(g.hd, undefined)
})

test('opacityValueAt reads static and animated curves', () => {
	assert.equal(opacityValueAt({ a: 0, k: 100 }, 0), 100)
	assert.equal(opacityValueAt({ a: 0, k: [40] }, 0), 40)
	assert.equal(opacityValueAt(null, 0), 100)
	const lin = { x: [0.5], y: [0.5] }
	const prop = { a: 1, k: [{ t: 0, s: [100], i: lin, o: lin }, { t: 2, s: [0], i: lin, o: lin }] }
	assert.equal(opacityValueAt(prop, -5), 100)
	assert.ok(Math.abs(opacityValueAt(prop, 1) - 50) < 1e-6)
	assert.equal(opacityValueAt(prop, 9), 0)
})

test('oscillatorPhaseFromSamples recovers a timeOffset from two outputs', () => {
	const base = { minimum: -100, maximum: 100, frequency: 0.2, timeMode: 0, trigType: 0, waveType: 0, strength: 100, strengthToZero: true, timeScale: 1, offset: 0, fps: 60 }
	const cfgs = [
		base,
		{ ...base, trigType: 1 },
		{ ...base, minimum: 20, maximum: 100, strength: 50, strengthToZero: false, offset: 5 },
		{ ...base, minimum: 20, maximum: 100, strength: 50, strengthToZero: true },
		{ ...base, timeMode: 1, frequency: 30, timeScale: 2 },
	]
	for (const cfg of cfgs) {
		const gap = phaseSampleGap(cfg)
		for (const off of [0, 0.37, 1.9, 3.56, -2.2]) {
			const c = { ...cfg, timeOffset: off }
			const p = oscillatorPhaseFromSamples(cfg, oscillatorValueAt(c, 0, 0), oscillatorValueAt(c, gap, 0), gap)
			assert.ok(p != null)
			for (const t of [0, 17, 133]) assert.ok(Math.abs(oscillatorValueAt({ ...cfg, timeOffset: p }, t, 0) - oscillatorValueAt(c, t, 0)) < 1e-6, JSON.stringify([cfg, off, t]))
		}
	}
	assert.equal(phaseSampleGap(base), 75)
	assert.equal(oscillatorPhaseFromSamples({ ...base, waveType: 2 }, 0, 0, 75), null)
	assert.equal(oscillatorPhaseFromSamples({ ...base, trigType: 2 }, 0, 0, 75), null)
	assert.equal(oscillatorPhaseFromSamples(base, 0, 0, 0), null)
})

test('alignedPairs flips y and aligns centroids before nearest matching', () => {
	// Cavalry y-down copies vs Lottie groups mirrored in y and shifted.
	const cav = [[0, -10], [10, -10], [0, 10], [10, 10]]
	const lot = [[105, 210], [95, 210], [105, 190], [95, 190]] // shuffled, y = -y, offset (100, 200)
	const m = alignedPairs(cav, lot, true)
	// copy 0 (0,-10) -> Lottie (0,10)+offset -> (100,210)? nearest after centring: x 0 -> 95, y +10 -> 210
	assert.deepEqual(m, [1, 0, 3, 2])
})
