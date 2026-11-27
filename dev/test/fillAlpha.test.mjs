import test from 'node:test'
import assert from 'node:assert/strict'
import { splitFillAlpha } from '../src/modules/fillAlpha.js'

// Cavalry writes a shape's material alpha into the fill colour's 4th channel.
// lottie-web reads only c[0..2] for the paint and takes transparency from `o`,
// so the alpha has to move or the shape draws solid.

test('a static fill colour moves its alpha into the fill opacity', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'rc',
						s: { a: 0, k: [303.2, 303.2] },
						p: { a: 0, k: [0, 0] },
						r: { a: 0, k: 41 },
					},
					{
						ty: 'fl',
						c: { a: 0, k: [0.545, 0.545, 0.545, 0.655] },
						o: { a: 0, k: 100 },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 1)
	const fl = json.layers[0].shapes[1]
	assert.deepEqual(fl.c.k, [0.545, 0.545, 0.545, 1])
	assert.equal(fl.o.a, 0)
	assert.ok(
		Math.abs(fl.o.k - 65.5) < 0.01,
		'opacity is the alpha as a percentage'
	)
})

test('an existing fill opacity multiplies with the colour alpha', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: { a: 0, k: [1, 0, 0, 0.5] },
						o: { a: 0, k: 50 },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 1)
	assert.ok(Math.abs(json.layers[0].shapes[0].o.k - 25) < 0.01)
})

test('a fully opaque colour is left untouched, so the pass is idempotent', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: { a: 0, k: [1, 0.267, 0.267, 1] },
						o: { a: 0, k: 100 },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 0)
	const before = JSON.stringify(json)
	assert.equal(splitFillAlpha(json), 0)
	assert.equal(JSON.stringify(json), before)
})

test('running the pass twice does not scale the opacity again', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: { a: 0, k: [0.5, 0.5, 0.5, 0.655] },
						o: { a: 0, k: 100 },
					},
				],
			},
		],
	}
	splitFillAlpha(json)
	const once = JSON.stringify(json)
	assert.equal(splitFillAlpha(json), 0)
	assert.equal(JSON.stringify(json), once)
})

test('fills nested in groups and shape layers inside precomp assets are rewritten', () => {
	const json = {
		layers: [],
		assets: [
			{
				id: 'comp_1',
				layers: [
					{
						ty: 4,
						shapes: [
							{
								ty: 'gr',
								it: [
									{
										ty: 'gr',
										it: [
											{
												ty: 'fl',
												c: {
													a: 0,
													k: [0.2, 0.4, 0.6, 0.4],
												},
												o: { a: 0, k: 100 },
											},
										],
									},
								],
							},
						],
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 1)
	const fl = json.assets[0].layers[0].shapes[0].it[0].it[0]
	assert.deepEqual(fl.c.k, [0.2, 0.4, 0.6, 1])
	assert.ok(Math.abs(fl.o.k - 40) < 0.01)
})

test('strokes get the same treatment', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'st',
						c: { a: 0, k: [0, 0, 0, 0.25] },
						o: { a: 0, k: 100 },
						w: { a: 0, k: 2 },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 1)
	assert.ok(Math.abs(json.layers[0].shapes[0].o.k - 25) < 0.01)
})

test('gradient fills keep their stop alphas', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'gf',
						o: { a: 0, k: 100 },
						g: { p: 2, k: { 0: [1, 0, 0], 1: [0, 0, 1] } },
						s: { a: 0, k: [0, 0] },
						e: { a: 0, k: [1, 1] },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 0)
	assert.deepEqual(json.layers[0].shapes[0].g.k, {
		0: [1, 0, 0],
		1: [0, 0, 1],
	})
})

test('an animated colour whose keys carry alpha becomes a colour plus an opacity curve', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: {
							a: 1,
							k: [
								{ t: 0, s: [1, 0, 0, 1] },
								{ t: 30, s: [1, 0, 0, 0.5] },
								{ t: 60, s: [0, 0, 1, 1] },
							],
						},
						o: { a: 0, k: 100 },
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 1)
	const fl = json.layers[0].shapes[0]
	fl.c.k.forEach((key) =>
		assert.equal(key.s[3], 1, 'every colour key is opaque')
	)
	assert.equal(fl.o.a, 1)
	const vals = fl.o.k.map((key) => key.s[0])
	assert.deepEqual(vals, [100, 50, 100])
})

test('a fill that is fully transparent at every key is marked hidden', () => {
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: {
							a: 1,
							k: [
								{ t: 0, s: [1, 0, 0, 0] },
								{ t: 10, s: [1, 0, 0, 0] },
							],
						},
						o: { a: 0, k: 100 },
					},
				],
			},
		],
	}
	splitFillAlpha(json)
	const fl = json.layers[0].shapes[0]
	assert.equal(fl.o.a, 0)
	assert.equal(fl.o.k, 0)
})

test('a partly transparent animated colour over an animated opacity is left alone', () => {
	// There is no exact Lottie form for two curves with different key times, so
	// the pass leaves the paint as written rather than baking an approximation.
	const json = {
		layers: [
			{
				ty: 4,
				shapes: [
					{
						ty: 'fl',
						c: {
							a: 1,
							k: [
								{ t: 0, s: [1, 0, 0, 0.5] },
								{ t: 20, s: [0, 0, 1, 1] },
							],
						},
						o: {
							a: 1,
							k: [
								{ t: 0, s: [100] },
								{ t: 20, s: [0] },
							],
						},
					},
				],
			},
		],
	}
	assert.equal(splitFillAlpha(json), 0)
	const fl = json.layers[0].shapes[0]
	assert.equal(fl.c.k[0].s[3], 0.5)
})

test('layers without shapes, and shape kinds that are not paints, are skipped', () => {
	const json = {
		layers: [
			{ ty: 3, ks: {} },
			{
				ty: 4,
				shapes: [
					{ ty: 'sh', ks: {} },
					{ ty: 'tr', p: { a: 0, k: [0, 0] } },
				],
			},
		],
		assets: [{ id: 'image_0', w: 10, h: 10, u: '', p: 'x.png' }],
	}
	assert.equal(splitFillAlpha(json), 0)
})
