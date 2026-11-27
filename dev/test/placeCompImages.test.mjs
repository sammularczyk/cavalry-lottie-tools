import test from 'node:test'
import assert from 'node:assert/strict'
import { placeCompImages } from '../src/modules/imageFills.js'

// A comp-local image fill: the shader lives inside a referenced comp that a
// duplicator instances, so ONE image per shape goes into that comp's asset.
// The grey card in the Repeated_Duplicator_Fib scene is the measured case.

const cardComp = () => ({
	layers: [
		{
			ty: 4,
			ind: 26,
			ip: -36,
			op: 127,
			ks: {
				p: { x: { a: 0, k: 885.9 }, y: { a: 0, k: 233.8 }, s: true },
				s: {
					a: 1,
					k: [
						{ t: 0, s: [100, 100, 100] },
						{ t: 43, s: [0, 0, 100] },
						{ t: 90, s: [100, 100, 100] },
					],
				},
			},
			shapes: [
				{
					ty: 'rc',
					d: 1,
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
})

const job = () => ({
	assetId: 'imgc0',
	assetW: 220,
	assetH: 235,
	assetP: 'imgc0.png',
	assetU: '',
	px: 890,
	py: 227.5,
	color: [0.545, 0.545, 0.545],
})

test('the image goes into the comp that holds the shader, before the painted layer', () => {
	const json = cardComp()
	const r = placeCompImages(json, [job()])
	assert.equal(r.changed, 1)
	// Lottie paints the first array entry on top, so the image must be inserted
	// ahead of the layer whose flat fill it covers.
	const kinds = json.layers.map((l) => l.ty)
	assert.deepEqual(kinds, [3, 2, 4])
	assert.equal(json.layers[1].refId, 'imgc0')
	assert.equal(json.layers[2].shapes[0].ty, 'rc')
})

test('the image asset is added and reused rather than duplicated', () => {
	const json = cardComp()
	placeCompImages(json, [job()])
	const images = json.assets.filter((a) => a.layers === undefined)
	assert.equal(images.length, 1)
	assert.equal(images[0].id, 'imgc0')
	assert.equal(images[0].w, 220)
	assert.equal(images[0].h, 235)
	assert.equal(images[0].p, 'imgc0.png')
})

test('the carrier clones the painted layer transform so the card scale animates the image', () => {
	const json = cardComp()
	placeCompImages(json, [job()])
	const carrier = json.layers[0]
	assert.equal(carrier.ty, 3)
	assert.equal(carrier.ks.s.a, 1)
	assert.deepEqual(
		carrier.ks.s.k.map((k) => k.s[0]),
		[100, 0, 100]
	)
	assert.equal(carrier.ip, -36)
	assert.equal(carrier.op, 127)
})

test('the image position is comp pixels expressed inside the carrier', () => {
	const json = cardComp()
	placeCompImages(json, [job()])
	const image = json.layers[1]
	assert.equal(image.parent, json.layers[0].ind)
	// 890 - 885.9, 227.5 - 233.8: the crop centre relative to the layer position.
	assert.ok(Math.abs(image.ks.p.k[0] - 4.1) < 0.001)
	assert.ok(Math.abs(image.ks.p.k[1] - -6.3) < 0.001)
	assert.deepEqual(image.ks.s.k, [100, 100, 100])
})

test('the image anchors at its own centre and stays unflipped', () => {
	const json = cardComp()
	placeCompImages(json, [job()])
	assert.deepEqual(json.layers[1].ks.a.k, [110, 117.5])
})

test('a job whose colour matches no layer still lands in the comp rather than being dropped', () => {
	const json = cardComp()
	const r = placeCompImages(json, [
		Object.assign(job(), { color: [0.1, 0.2, 0.3] }),
	])
	assert.equal(r.changed, 1)
	assert.equal(json.layers.filter((l) => l.ty === 2).length, 1)
})

test('two shader fills in one comp insert at two different layers', () => {
	const json = cardComp()
	json.layers.push({
		ty: 4,
		ind: 30,
		ip: 0,
		op: 90,
		ks: { p: { a: 0, k: [100, 100] } },
		shapes: [
			{
				ty: 'fl',
				c: { a: 0, k: [0.1, 0.2, 0.3, 1] },
				o: { a: 0, k: 100 },
			},
		],
	})
	const r = placeCompImages(json, [
		job(),
		Object.assign(job(), {
			assetId: 'imgc1',
			assetP: 'imgc1.png',
			color: [0.1, 0.2, 0.3],
		}),
	])
	assert.equal(r.changed, 2)
	assert.equal(json.layers.filter((l) => l.ty === 2).length, 2)
})

test('an empty job list changes nothing', () => {
	const json = cardComp()
	const before = JSON.stringify(json)
	assert.equal(placeCompImages(json, []).changed, 0)
	assert.equal(placeCompImages(json, null).changed, 0)
	assert.equal(JSON.stringify(json), before)
})
