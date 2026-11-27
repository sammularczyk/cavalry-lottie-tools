// imageFills lays a baked cell over the copies of a duplicator-baked shape
// layer. The writer drops imageShader fills entirely, so this pass is the only
// thing that puts the image back; it has to reproduce the copy geometry exactly
// because a misplaced cell is not a small error, it is a different picture.
//
// The fixture is a trimmed copy of the real export's structure: a comp asset
// holding one shape layer whose copies animate their scale from 0 to full size.

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyImageFills, copyGroups } from '../src/modules/imageFills.js'

function group(cx, cy, w, h, scaleKeys) {
	var x = w / 2, y = h / 2
	return {
		ty: 'gr',
		np: 3,
		it: [
			{
				ty: 'sh',
				ks: {
					a: 0,
					k: {
						v: [[cx - x, cy - y], [cx + x, cy - y], [cx + x, cy + y], [cx - x, cy + y]],
						i: [[0, 0], [0, 0], [0, 0], [0, 0]],
						o: [[0, 0], [0, 0], [0, 0], [0, 0]],
						c: true
					}
				}
			},
			{ ty: 'fl', c: { a: 0, k: [0.05, 0.64, 0, 1] }, o: { a: 0, k: 100 } },
			{
				ty: 'tr',
				p: { a: 0, k: [cx, cy] },
				a: { a: 0, k: [cx, cy] },
				s: scaleKeys || { a: 0, k: [100, 100] },
				r: { a: 0, k: 0 },
				o: { a: 0, k: 100 }
			}
		]
	}
}

const ANIMATED_SCALE = {
	a: 1,
	k: [
		{ t: 85, s: [0, 0] },
		{ t: 132, s: [100, 100] },
		{ t: 468, s: [100, 100] }
	]
}

function makeDoc(opts) {
	opts = opts || {}
	var layerKs = { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [78, 78] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
	var copies = []
	for (var i = 0; i < (opts.copies || 3); i++) copies.push(group(340 + i * 486, -850, 331.76, 331.76, opts.animatedScale ? ANIMATED_SCALE : null))
	var comp = {
		id: 'comp_1',
		fr: 60,
		layers: [
			{ ind: 3, ty: 0, refId: 'comp_3', ip: 270, op: 1047 },
			{ ind: 36, ty: 3, ip: 0, op: 1201, ks: { p: { a: 0, k: [540, 1200] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [128.205, 128.205] } } },
			{ ind: 71, ty: 4, parent: 36, ip: 85, op: 1201, st: 0, sr: 1, ks: layerKs, shapes: copies },
			{ ind: 236, ty: 4, ip: 0, op: 1201, st: 0, sr: 1, ks: layerKs, shapes: [group(540, 1200, 1080, 2400)] }
		]
	}
	return {
		v: '5.12.2',
		w: 1080,
		h: 2400,
		fr: 60,
		ip: 0,
		op: 468,
		layers: [{ ind: 2, ty: 0, refId: 'comp_1', ip: 0, op: 468, ks: { p: { a: 0, k: [540, 1200] }, a: { a: 0, k: [540, 1200] } } }],
		assets: [
			{ id: 'comp_3', layers: [] },
			comp
		]
	}
}

const JOB = { assetId: 'cell', assetW: 314, assetH: 314, assetU: '', assetP: 'cell.png', copyCount: 3, cellW: 331.76 }

test('copyGroups reads a baked layer\'s sibling copy groups', () => {
	var doc = makeDoc()
	var layer = doc.assets[1].layers[2]
	assert.equal(copyGroups(layer).length, 3)
})

test('one image layer per copy, parented to a carrier with the old transform', () => {
	var doc = makeDoc()
	var r = applyImageFills(doc, [JOB])
	assert.equal(r.changed, 1)
	var comp = doc.assets[1]
	var images = comp.layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 3)
	var carrier = comp.layers.filter(function (L) { return L.ty === 3 && L.ind === images[0].parent })[0]
	assert.ok(carrier, 'the carrier exists')
	assert.deepEqual(carrier.ks.s.k, [78, 78], 'the carrier keeps the shape layer transform')
	assert.equal(carrier.parent, 36, 'the carrier keeps the shape layer parent')
	assert.equal(r.layers[0].copies, 3)
})

test('the images paint above the shape layer they decorate', () => {
	var doc = makeDoc()
	applyImageFills(doc, [JOB])
	var comp = doc.assets[1]
	var fillAt = comp.layers.findIndex(function (L) { return L.ind === 71 })
	var firstImageAt = comp.layers.findIndex(function (L) { return L.ty === 2 })
	assert.ok(firstImageAt < fillAt, 'images come before the fill: the first array entry paints on top')
})

test('an image is centred on its copy and spans the copy outline', () => {
	var doc = makeDoc()
	applyImageFills(doc, [JOB])
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	// The copy group anchors at its own centre, so the image position is that centre.
	assert.deepEqual(images[0].ks.p.k, [340, -850])
	assert.deepEqual(images[0].ks.a.k, [157, 157], 'anchored at the image centre')
	var s = images[0].ks.s
	assert.equal(s.a, 0)
	assert.ok(Math.abs(s.k[0] - (331.76 / 314) * 100) < 1e-6, 'scaled to the copy width')
	assert.ok(Math.abs(s.k[1] - (331.76 / 314) * 100) < 1e-6, 'scaled to the copy height')
})

test('the copy group\'s animated scale curve is carried by the image', () => {
	var doc = makeDoc({ animatedScale: true })
	applyImageFills(doc, [JOB])
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	var s = images[0].ks.s
	assert.equal(s.a, 1, 'the image keeps the curve instead of one static size')
	assert.equal(s.k.length, 3)
	assert.deepEqual(s.k[0].s, [0, 0], 'the image starts hidden with the copy')
	assert.ok(Math.abs(s.k[1].s[0] - (331.76 / 314) * 100) < 1e-6, 'and reaches the copy outline')
})

test('layer inds stay unique and every parent still resolves', () => {
	var doc = makeDoc()
	applyImageFills(doc, [JOB])
	var comp = doc.assets[1]
	var inds = comp.layers.map(function (L) { return L.ind })
	assert.equal(new Set(inds).size, inds.length, 'no duplicate ind')
	var present = {}
	inds.forEach(function (i) { present[i] = true })
	comp.layers.forEach(function (L) {
		if (L.parent != null) assert.ok(present[L.parent], 'layer ' + L.ind + ' parent ' + L.parent + ' resolves')
	})
})

test('the asset carries the cell size and path, and is deduplicated per job', () => {
	var doc = makeDoc()
	applyImageFills(doc, [JOB])
	var cell = doc.assets.filter(function (a) { return a.id.indexOf('cell') === 0 })
	assert.equal(cell.length, 1)
	assert.equal(cell[0].w, 314)
	assert.equal(cell[0].p, 'cell.png')
	assert.equal(cell[0].e, 0)
})

test('two jobs with identical asset specs share one asset; distinct specs get separate asset ids', () => {
	var doc = makeDoc()
	doc.assets[1].layers.push({
		ind: 95,
		ty: 4,
		parent: 36,
		ip: 159,
		op: 1201,
		ks: { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [78, 78] } },
		shapes: [group(2210, -3230, 331.76, 331.76), group(2210, -2744, 331.76, 331.76), group(2210, -2258, 331.76, 331.76), group(2210, -1772, 331.76, 331.76)]
	})
	var r = applyImageFills(doc, [JOB, { assetId: 'cell', assetW: 314, assetH: 314, assetP: 'cell.png', copyCount: 4, cellW: 331.76 }])
	assert.equal(r.changed, 2)
	var ids = doc.assets.filter(function (a) { return String(a.id).indexOf('cell') === 0 }).map(function (a) { return a.id })
	assert.deepEqual(ids, ['cell'], 'identical asset specs reuse the single image asset')

	var doc2 = makeDoc()
	doc2.assets[1].layers.push({
		ind: 95,
		ty: 4,
		parent: 36,
		ip: 159,
		op: 1201,
		ks: { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [78, 78] } },
		shapes: [group(2210, -3230, 331.76, 331.76), group(2210, -2744, 331.76, 331.76), group(2210, -2258, 331.76, 331.76), group(2210, -1772, 331.76, 331.76)]
	})
	var r2 = applyImageFills(doc2, [JOB, { assetId: 'cell', assetW: 314, assetH: 314, assetP: 'cell2.png', copyCount: 4, cellW: 331.76 }])
	assert.equal(r2.changed, 2)
	var ids2 = doc2.assets.filter(function (a) { return String(a.id).indexOf('cell') === 0 }).map(function (a) { return a.id })
	assert.deepEqual(ids2, ['cell', 'cell_1'], 'distinct image files still get separate asset ids')
})

test('a job with no matching copy layer is reported and changes nothing', () => {
	var doc = makeDoc()
	var r = applyImageFills(doc, [{ assetId: 'cell', assetW: 314, assetH: 314, assetP: 'cell.png', copyCount: 99 }])
	assert.equal(r.changed, 0)
	assert.ok(r.notes[0].indexOf('no baked copy layer matches') >= 0)
	assert.equal(doc.layers.length, 1, 'the document is untouched')
})

test('a layer whose copies have no usable outline keeps its flat fill', () => {
	var doc = makeDoc()
	var layer = doc.assets[1].layers[2]
	layer.shapes.forEach(function (g) {
		g.it = g.it.filter(function (s) { return s.ty !== 'sh' })
	})
	var r = applyImageFills(doc, [JOB])
	assert.equal(r.changed, 0)
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 0, 'no image was placed without an outline to size it')
	assert.equal(doc.assets[1].layers.filter(function (L) { return L.ty === 3 && L.nm && L.nm.indexOf('carrier') >= 0 }).length, 0, 'the carrier is not left behind')
})

test('an empty job list is a no-op', () => {
	var doc = makeDoc()
	var r = applyImageFills(doc, [])
	assert.equal(r.changed, 0)
	assert.equal(doc.assets.length, 2)
})

test('copy groups marked hd:true by visibility culling are skipped', () => {
	// `applyValuesToGroups` marks a permanently culled copy `g.hd = true` while
	// leaving `tr.o` at 100. Emitting a ty:2 layer for it paints a floating copy
	// at full opacity where the grid has a hole.
	var doc = makeDoc()
	var layer = doc.assets[1].layers[2]
	layer.shapes[1].hd = true
	var r = applyImageFills(doc, [JOB])
	assert.equal(r.changed, 1)
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 2, 'only the two visible copies receive image layers')
	assert.deepEqual(images.map(function (L) { return L.ks.p.k[0] }), [340, 340 + 2 * 486])
})

test('spansPitch scales a pitch-wide cell crop across the local copy pitch', () => {
	// A multi-copy capture crops from gutter midpoint to gutter midpoint (one
	// full pitch = 486 local units in X and Y here, wider than the 331.76 outline).
	var doc = makeDoc()
	// Give the fixture copies a 2D grid (pitch 486 in both X and Y) so both
	// axes have a measurable lattice pitch.
	doc.assets[1].layers[2].shapes = [
		group(340, -850, 331.76, 331.76),
		group(340 + 486, -850, 331.76, 331.76),
		group(340, -850 + 486, 331.76, 331.76)
	]
	applyImageFills(doc, [Object.assign({}, JOB, { spansPitch: true })])
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	var expected = (486 / 314) * 100
	assert.ok(Math.abs(images[0].ks.s.k[0] - expected) < 1e-6)
	assert.ok(Math.abs(images[0].ks.s.k[1] - expected) < 1e-6)
})

test('when subMesh shapeScale is baked into sh.ks vertices, the image inherits that scale curve and settles on the rest size', () => {
	// Cavalry's writer bakes subMesh shapeScale into path vertices (0 -> 331.76
	// spring overshoot -> 314.42 rest) while leaving tr.s at static [100, 100].
	var doc = makeDoc({ copies: 1 })
	var g = doc.assets[1].layers[2].shapes[0]
	var sh = g.it[0]
	function boxVerts(cx, cy, size) {
		var h = size / 2
		return {
			v: [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]],
			i: [[0, 0], [0, 0], [0, 0], [0, 0]],
			o: [[0, 0], [0, 0], [0, 0], [0, 0]],
			c: true
		}
	}
	sh.ks = {
		a: 1,
		k: [
			{ t: 85, s: [boxVerts(340, -850, 0)] },
			{ t: 100, s: [boxVerts(340, -850, 0)] },
			{ t: 126, s: [boxVerts(340, -850, 331.76)] },
			{ t: 165, s: [boxVerts(340, -850, 314)] },
			{ t: 468, s: [boxVerts(340, -850, 314)] }
		]
	}
	applyImageFills(doc, [{ assetId: 'cell', assetW: 314, assetH: 314, assetP: 'cell.png', copyCount: 1, cellW: 314 }])
	var img = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })[0]
	assert.equal(img.ks.s.a, 1, 'scale curve synthesised from animated path bbox')
	assert.deepEqual(img.ks.s.k[0].s, [0, 0], 'starts at zero before the copy pops in')
	var peak = img.ks.s.k.find(function (k) { return k.t === 126 })
	assert.ok(peak && Math.abs(peak.s[0] - (331.76 / 314) * 100) < 1e-4, 'reproduces the spring overshoot')
	var rest = img.ks.s.k[img.ks.s.k.length - 1]
	assert.ok(Math.abs(rest.s[0] - 100) < 1e-6, 'settles on the final rest bbox (314), not the overshoot')
})

test('multi-asset job registers every asset and cycles them across copies', () => {
	var doc = makeDoc({ copies: 4 })
	var r = applyImageFills(doc, [{
		assets: [
			{ assetId: 'img0', assetW: 800, assetH: 800, assetU: '', assetP: 'img0.png' },
			{ assetId: 'img1', assetW: 800, assetH: 800, assetU: '', assetP: 'img1.png' }
		],
		copyCount: 4
	}])
	assert.equal(r.changed, 1)
	assert.deepEqual(r.layers[0].assetIds, ['img0', 'img1'])
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 4)
	assert.deepEqual(images.map(function (L) { return L.refId }), ['img0', 'img1', 'img0', 'img1'])
})

test('multi-asset job matches a culled copy layer with fewer groups than grid copyCount', () => {
	var doc = makeDoc({ copies: 3 })
	var r = applyImageFills(doc, [{
		assets: [
			{ assetId: 'img0', assetW: 800, assetH: 800, assetU: '', assetP: 'img0.png' },
			{ assetId: 'img1', assetW: 800, assetH: 800, assetU: '', assetP: 'img1.png' }
		],
		copyCount: 5,
		allowUnderCount: true,
		copyAssetIndex: [1, -1, 0]
	}])
	assert.equal(r.changed, 1)
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 2, 'copy with index -1 is skipped')
	assert.deepEqual(images.map(function (L) { return L.refId }), ['img1', 'img0'])
})

test('measuredArrayIndex and measuredShapeId pair by centre and emit hold-keyed opacity gates', () => {
	var doc = makeDoc({ copies: 3 })
	// makeDoc places 3 copies at x = 200, 500, 800 (y = 200).
	var r = applyImageFills(doc, [{
		assets: [
			{ assetId: 'img0', assetW: 800, assetH: 800, assetU: '', assetP: 'img0.png' },
			{ assetId: 'img1', assetW: 800, assetH: 800, assetU: '', assetP: 'img1.png' },
			{ assetId: 'img2', assetW: 800, assetH: 800, assetU: '', assetP: 'img2.png' }
		],
		copyCount: 3,
		shapeSlot: 2,
		measuredArrayIndex: {
			frames: [0],
			copies: [
				{ c: [200, 200], v: 2, vs: [2] },
				{ c: [500, 200], v: 0, vs: [0] },
				{ c: [800, 200], v: 1, vs: [1] }
			]
		},
		measuredShapeId: {
			frames: [0, 50, 100],
			copies: [
				{ c: [200, 200], v: 2, vs: [2, 0, 2] }, // on -> off -> on
				{ c: [500, 200], v: 0, vs: [0, 1, 3] }, // never slot 2 -> skipped
				{ c: [800, 200], v: 2, vs: [2, 2, 2] }  // always slot 2 -> static 100
			]
		}
	}])
	assert.equal(r.changed, 1)
	var images = doc.assets[1].layers.filter(function (L) { return L.ty === 2 })
	assert.equal(images.length, 2, 'copy never matching shapeSlot 2 is omitted')
	assert.deepEqual(images.map(function (L) { return L.refId }), ['img2', 'img1'])
	assert.equal(images[0].ks.o.a, 1)
	assert.deepEqual(images[0].ks.o.k, [
		{ t: 0, s: [100], h: 1 },
		{ t: 50, s: [0], h: 1 },
		{ t: 100, s: [100], h: 1 }
	])
	assert.deepEqual(images[1].ks.o, { a: 0, k: 100 })
})
