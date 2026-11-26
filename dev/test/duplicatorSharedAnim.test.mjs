import test from 'node:test'
import assert from 'node:assert/strict'

import {
	restructureSharedAnim,
	copyGroups,
	propertySampler,
	fitOffsets,
	geometryKey,
	vertexCentroid,
	readSeries,
} from '../src/modules/duplicatorSharedAnim.js'

// The module is pure JSON in / JSON out, so these tests build Lottie fragments by
// hand. What they cover is the trust decision: which duplicators may be rewritten,
// and which must be left alone because the copies are not one shared animation.

const SQUARE = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10],
]

const pathOf = (dx, dy) => ({
	ty: 'sh',
	ks: {
		a: 0,
		k: {
			v: SQUARE.map(([x, y]) => [x + dx, y + dy]),
			i: SQUARE.map(() => [0, 0]),
			o: SQUARE.map(() => [0, 0]),
			c: true,
		},
	},
})

const fill = { ty: 'fl', c: { a: 0, k: [0, 0, 0, 1] }, o: { a: 0, k: 100 } }

// A scale ramp identical to the shape the real exporter bakes: flat, then eased up
// to 100. `off` shifts where the ramp starts, which is the delay being measured.
const scaleAt = (t, off) => {
	const u = Math.min(1, Math.max(0, (t - 10 - off) / 10))
	return [
		{ t: 0, s: [100 * 0, 0], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
		{ t: 10 + off, s: [0, 0], o: { x: 0.33, y: 0 }, i: { x: 0.67, y: 1 } },
		{ t: 20 + off, s: [100, 100] },
	]
}

const scaleProp = (off) => ({ a: 1, k: scaleAt(0, off) })

const copy = (dx, dy, off) => ({
	ty: 'gr',
	it: [
		pathOf(dx, dy),
		fill,
		{
			ty: 'tr',
			p: { a: 0, k: [dx, dy] },
			a: { a: 0, k: [dx, dy] },
			s: scaleProp(off),
			r: { a: 0, k: 0 },
			o: { a: 0, k: 100 },
		},
	],
})

const lottie = (copies, extra = []) => ({
	v: '5.12.2',
	fr: 60,
	ip: 0,
	op: 95,
	w: 1080,
	h: 2440,
	layers: [
		{
			ddd: 0,
			ind: 1,
			ty: 4,
			nm: 'duplicator',
			ip: 0,
			op: 95,
			st: 0,
			ks: {},
			shapes: [
				{
					ty: 'gr',
					it: [
						...copies,
						{
							ty: 'tr',
							p: { a: 0, k: [0, 0] },
							o: { a: 0, k: 100 },
						},
					],
				},
				...extra,
			],
		},
	],
	assets: [],
})

const frames = () => {
	const out = []
	for (let t = 0; t <= 95; t += 0.25) out.push(t)
	return out
}

// 24 copies on a grid, all the same geometry, delayed by a spread of offsets.
const grid = (n = 24, offsets = null) => {
	const out = []
	for (let i = 0; i < n; i++) {
		const dx = 100 * (i % 6)
		const dy = 100 * Math.floor(i / 6)
		const off = offsets ? offsets[i] : -i * 0.4
		out.push(copy(dx, dy, off))
	}
	return out
}

test('copyGroups reads copies out of the duplicator container, not the container itself', () => {
	const j = lottie(grid(24))
	const groups = copyGroups(j.layers[0].shapes)
	assert.equal(groups.length, 24)
	// the container's trailing `tr` is not a copy
	assert.ok(groups.every((g) => g.it.some((it) => it.ty === 'tr')))
})

test('copyGroups ignores a small non-duplicator group', () => {
	const extra = { ty: 'gr', it: [{ ty: 'rc' }, fill, { ty: 'tr' }] }
	const j = lottie(grid(24), [extra])
	assert.equal(copyGroups(j.layers[0].shapes).length, 24)
})

test('bezier sampler reproduces a linear ramp between two keys', () => {
	const prop = {
		a: 1,
		k: [
			{ t: 0, s: [0], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
			{ t: 10, s: [10], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
		],
	}
	const f = propertySampler(prop)
	assert.ok(Math.abs(f(0) - 0) < 1e-6)
	assert.ok(Math.abs(f(5) - 5) < 1e-6)
	assert.ok(Math.abs(f(10) - 10) < 1e-6)
	// clamped outside the key range
	assert.deepEqual(f(-5), [0])
	assert.deepEqual(f(50), [10])
})

test('geometryKey treats translated copies as the same shape', () => {
	const a = pathOf(0, 0)
	const b = pathOf(37, -12)
	assert.equal(geometryKey(a), geometryKey(b))
})

test('vertexCentroid is the mean of the vertices', () => {
	const c = vertexCentroid(pathOf(10, 20))
	assert.deepEqual(c, [15, 25])
})

test('fitOffsets recovers a linear delay spread', () => {
	const offsets = []
	for (let i = 0; i < 24; i++) offsets.push(-i * 0.4)
	const series = offsets.map((off) => {
		const f = propertySampler(scaleProp(off))
		return frames().map((t) => ({ t, v: f(t)[0] }))
	})
	const refSamplerFor = (i) => (t) =>
		propertySampler(scaleProp(offsets[i]))(t)[0]
	const fit = fitOffsets(series, frames(), { refSampler: refSamplerFor })
	assert.ok(fit, 'fit should succeed')
	// the earliest-rising copy is the most delayed in its own timeline
	assert.equal(fit.ref, 23)
	// every recovered offset lands within a quarter frame of the truth
	for (let i = 0; i < 24; i++) {
		const want = -offsets[i] + offsets[23]
		assert.ok(
			Math.abs(fit.offsets[i] - want) < 0.26,
			'copy ' + i + ' offset ' + fit.offsets[i] + ' vs ' + want
		)
	}
	assert.ok(fit.relativeResidual < 0.02, 'residual ' + fit.relativeResidual)
})

test('fitOffsets refuses a flat channel', () => {
	const series = [0, 1].map(() => frames().map((t) => ({ t, v: 0 })))
	assert.equal(fitOffsets(series, frames(), {}), null)
})

// The strict gate the user chose: a duplicator whose copies are NOT one shared
// curve must be left exactly as it is, rather than half-rewritten.
test('a duplicator whose copies do not share a curve is left untouched', () => {
	const j = lottie(grid(24))
	// give one copy a completely different scale curve so no single lag explains it
	j.layers[0].shapes[0].it[5].it[2].s = {
		a: 1,
		k: [
			{ t: 0, s: [0], o: { x: 0.9, y: 0 }, i: { x: 0.1, y: 1 } },
			{ t: 40, s: [100], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
		],
	}
	const before = JSON.stringify(j.layers)
	const out = restructureSharedAnim(j, { sharedAnim: true })
	const rep = out.reports[0]
	assert.ok(
		rep.skipped,
		'should be skipped, got ' + JSON.stringify(rep).slice(0, 120)
	)
	assert.match(rep.skipped, /residual/)
	// and nothing on the layer moved
	assert.equal(JSON.stringify(j.layers), before)
})

test('a shared-curve duplicator is rewritten into one asset plus refs', () => {
	const j = lottie(grid(24))
	const out = restructureSharedAnim(j, { sharedAnim: true })
	assert.equal(out.changed, 1)
	const rep = out.reports[0]
	assert.equal(rep.copies, 24)
	assert.ok(rep.saved > 0)

	// one asset, referenced by every copy
	assert.equal(j.assets.length, 1)
	const refs = j.layers.filter((L) => L.ty === 0)
	assert.equal(refs.length, 24)
	assert.ok(refs.every((r) => r.refId === j.assets[0].id))

	// CRITICAL: a precomp ref must carry its own w/h or lottie-web's clip rectangle
	// is undefined and the layer renders empty
	assert.ok(refs.every((r) => r.w && r.h))

	// `st` carries the delay, and the reference copy has the smallest |st|
	const sts = refs.map((r) => r.st)
	assert.ok(
		Math.max(...sts) > 1,
		'delays should spread over frames, got ' + sts.slice(0, 6)
	)
	assert.ok(
		Math.min(...sts.map(Math.abs)) < 0.01,
		'the reference copy should sit at st 0'
	)
})

test('the shared asset is an array of shapes, not a bare group', () => {
	// A bare `gr` object here is silently ignored by lottie-web and the precomp
	// renders empty — this exact mistake cost a long debugging detour.
	const j = lottie(grid(24))
	restructureSharedAnim(j, { sharedAnim: true })
	const shapes = j.assets[0].layers[0].shapes
	assert.ok(Array.isArray(shapes), 'shapes must be an array')
	assert.ok(shapes.length > 0)
})

test('a non-duplicator shape group on the same layer survives the rewrite', () => {
	// A background panel sits beside the duplicator. Dropping it changes pixels at
	// the frames where the copies are not yet on screen.
	const extra = {
		ty: 'gr',
		it: [
			{
				ty: 'rc',
				d: 1,
				s: { a: 0, k: [100, 100] },
				p: { a: 0, k: [0, 0] },
			},
			fill,
			{ ty: 'tr', p: { a: 0, k: [10, 20] } },
		],
	}
	const j = lottie(grid(24), [extra])
	restructureSharedAnim(j, { sharedAnim: true })
	const kept = j.layers.filter((L) => L.ty === 4)
	assert.equal(kept.length, 1, 'the extra drawing should be one shape layer')
	assert.equal(kept[0].shapes.length, 1)
	assert.equal(kept[0].shapes[0].it[0].ty, 'rc')
})

test('copies with distinct geometries are not merged', () => {
	const copies = grid(24)
	// a DIFFERENT SIZE, which survives translation normalisation, unlike an offset
	copies[3].it[0] = {
		ty: 'sh',
		ks: {
			a: 0,
			k: {
				v: [
					[0, 0],
					[20, 0],
					[20, 20],
					[0, 20],
				],
				i: [
					[0, 0],
					[0, 0],
					[0, 0],
					[0, 0],
				],
				o: [
					[0, 0],
					[0, 0],
					[0, 0],
					[0, 0],
				],
				c: true,
			},
		},
	}
	const j = lottie(copies)
	const out = restructureSharedAnim(j, { sharedAnim: true })
	assert.equal(out.changed, 0)
	assert.match(out.reports[0].skipped, /distinct geometries/)
})

test('the rewrite keeps authored position keys verbatim', () => {
	// Position carries the Stagger-delayed x movement and is exact, so it must not be
	// resampled or refitted on the way through.
	const copies = grid(24)
	const j = lottie(copies)
	const beforeP = copies.map((c) => JSON.stringify(c.it[2].p))
	restructureSharedAnim(j, { sharedAnim: true })
	const refs = j.layers.filter((L) => L.ty === 0)
	refs.forEach((r, i) => assert.equal(JSON.stringify(r.ks.p), beforeP[i]))
})

test('an option flag that is off leaves the JSON alone', () => {
	const j = lottie(grid(24))
	const before = JSON.stringify(j)
	restructureSharedAnim(j, {})
	assert.equal(JSON.stringify(j), before)
})

test('layer indices do not collide with layers outside the duplicator', () => {
	// A duplicator can sit beside other layers, and Lottie parents by `ind`. Reusing
	// 1..N here would quietly reparent unrelated layers.
	const j = lottie(grid(24))
	j.layers.forEach((L) => {
		L.ind = 900
	})
	j.layers.push({
		ddd: 0,
		ind: 901,
		ty: 4,
		nm: 'other',
		ip: 0,
		op: 95,
		st: 0,
		ks: {},
		shapes: [],
	})
	restructureSharedAnim(j, { sharedAnim: true })
	const inds = j.layers.map((L) => L.ind)
	assert.equal(
		new Set(inds).size,
		inds.length,
		'duplicate inds: ' + inds.join(',')
	)
	assert.ok(
		inds.every((n) => n >= 900),
		'refs should be numbered above the existing layers'
	)
	// the parent null, if any, must point at a layer that exists
	for (const L of j.layers) {
		if (L.parent == null) continue
		assert.ok(
			inds.includes(L.parent),
			'layer ' + L.ind + ' parents to missing ' + L.parent
		)
	}
})

test('the replaced layer transform is carried on a parent null', () => {
	// A baked duplicator carries the comp-level scale on the LAYER, not the copies.
	// Dropping it draws the whole grid at full size for the entire animation — the
	// bug that made a real export render 67.8% wrong.
	const j = lottie(grid(24))
	const L = j.layers[0]
	L.ks = {
		s: {
			a: 1,
			k: [
				{
					t: 0,
					s: [1139, 1139],
					o: { x: [1], y: [0] },
					i: { x: [0], y: [1] },
				},
				{ t: 20, s: [100, 100] },
			],
		},
		o: { a: 0, k: 100 },
	}
	restructureSharedAnim(j, { sharedAnim: true })
	const nulls = j.layers.filter((x) => x.ty === 3)
	assert.ok(
		nulls.length >= 1,
		'expected a parent null carrying the layer transform'
	)
	assert.deepEqual(nulls[0].ks.s, L.ks.s)
	const refs = j.layers.filter((x) => x.ty === 0)
	assert.ok(
		refs.every((r) => r.parent === nulls[0].ind),
		'refs should parent to it'
	)
})

test('a layer parented in the scene stays parented through the rewrite', () => {
	// The duplicator sits under a comp null. Its copies must keep that chain, or the
	// comp-level transform disappears and everything moves.
	const j = lottie(grid(24))
	j.layers[0].parent = 1
	j.layers.push({
		ddd: 0,
		ind: 1,
		ty: 3,
		nm: 'comp',
		ip: 0,
		op: 95,
		st: 0,
		ks: {},
	})
	restructureSharedAnim(j, { sharedAnim: true })
	const nulls = j.layers.filter((x) => x.ty === 3 && x.nm !== 'comp')
	assert.equal(
		nulls[0].parent,
		1,
		'the transform null should keep the original parent'
	)
})

test('readSeries interpolates linearly and clamps', () => {
	const s = [
		{ t: 0, v: 0 },
		{ t: 1, v: 10 },
		{ t: 2, v: 20 },
	]
	assert.equal(readSeries(s, -1), 0)
	assert.equal(readSeries(s, 3), 20)
	assert.ok(Math.abs(readSeries(s, 0.5) - 5) < 1e-9)
})
