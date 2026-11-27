import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latticeOf, copyGridOf, assetArrayOf, pngDimensionsOf, bakeImageFills } from '../src/modules/imageBake.js'
import { cropPng, decodePng } from '../src/modules/png.js'
import { base64, deflateRaw, crc32 } from '../src/modules/zip.js'

function encodeRgba(rgba, w, h) {
	const raw = []
	for (let y = 0; y < h; y++) {
		raw.push(0)
		for (let x = 0; x < w; x++) {
			const at = (y * w + x) * 4
			raw.push(rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3])
		}
	}
	const body = Uint8Array.from(raw)
	const deflated = deflateRaw(body)
	let a = 1
	let b = 0
	for (const v of body) {
		a = (a + v) % 65521
		b = (b + a) % 65521
	}
	const zlib = [0x78, 0x01, ...deflated, (b >> 8) & 255, b & 255, (a >> 8) & 255, a & 255]
	const chunk = (type, bytes) => {
		const len = bytes.length
		const typed = [...type].map((c) => c.charCodeAt(0)).concat(bytes)
		const out = [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]
		const crc = crc32(typed)
		return out.concat(typed, [(crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255])
	}
	const ihdr = [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0]
	return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', [])))
}

test('latticeOf crops from gutter midpoint to gutter midpoint so padded artwork stays centred in its cell', () => {
	// 4x4 grid of cells on pitch 100, canvas 420x420 starting at cell origin 10.
	// Each copy's artwork is 60x50 centred inside its 100x100 cell (20px X pad,
	// 25px Y pad, so gutters are 40px wide in X and 50px tall in Y). Cropping
	// from `gapEnd + 1` used to place the artwork at (0, 0) of the 100x100 crop;
	// cropping between gutter midpoints keeps it centred at (50, 50).
	const w = 420
	const h = 420
	const pitch = 100
	const origin = 10
	const artW = 60
	const artH = 50
	const rgba = new Uint8Array(w * h * 4)
	for (let gy = 0; gy < 4; gy++) {
		for (let gx = 0; gx < 4; gx++) {
			const cx = origin + gx * pitch + pitch / 2
			const cy = origin + gy * pitch + pitch / 2
			const x0 = Math.round(cx - artW / 2)
			const y0 = Math.round(cy - artH / 2)
			for (let y = y0; y < y0 + artH; y++) {
				for (let x = x0; x < x0 + artW; x++) {
					const at = (y * w + x) * 4
					rgba[at] = 220
					rgba[at + 1] = 80
					rgba[at + 2] = 30
					rgba[at + 3] = 255
				}
			}
		}
	}
	const pngBytes = encodeRgba(rgba, w, h)
	const prevApi = globalThis.api
	globalThis.api = {
		encodeBinary: () => base64(pngBytes)
	}
	try {
		const lat = latticeOf('synthetic.png')
		assert.ok(lat)
		assert.equal(lat.pitchX, pitch)
		assert.equal(lat.pitchY, pitch)
		const x0 = Math.round(lat.cx - lat.pitchX / 2)
		const y0 = Math.round(lat.cy - lat.pitchY / 2)
		const cropped = decodePng(cropPng(pngBytes, x0, y0, lat.pitchX, lat.pitchY).bytes)
		let minX = cropped.w, maxX = -1, minY = cropped.h, maxY = -1
		for (let y = 0; y < cropped.h; y++) {
			for (let x = 0; x < cropped.w; x++) {
				if (cropped.rgba[(y * cropped.w + x) * 4 + 3] > 24) {
					if (x < minX) minX = x
					if (x > maxX) maxX = x
					if (y < minY) minY = y
					if (y > maxY) maxY = y
				}
			}
		}
		const artCx = (minX + maxX + 1) / 2
		const artCy = (minY + maxY + 1) / 2
		assert.ok(Math.abs(artCx - pitch / 2) <= 1, 'artwork X centre ' + artCx + ' matches cell centre ' + (pitch / 2))
		assert.ok(Math.abs(artCy - pitch / 2) <= 1, 'artwork Y centre ' + artCy + ' matches cell centre ' + (pitch / 2))
	} finally {
		globalThis.api = prevApi
	}
})

test('latticeOf ignores wide frame margins when measuring pitch on a narrow grid', () => {
	// 3-column grid centred on a wide canvas: left/right margins are 160px
	// while the true inter-copy pitch is 100px (60px artwork + 40px gutter).
	// Including the frame-edge margins in pitchOf skewed the median to ~160px
	// and offset the artwork inside the cropped cell.
	const w = 620
	const h = 420
	const pitch = 100
	const originX = 160
	const originY = 10
	const artW = 60
	const artH = 50
	const rgba = new Uint8Array(w * h * 4)
	for (let gy = 0; gy < 4; gy++) {
		for (let gx = 0; gx < 3; gx++) {
			const cx = originX + gx * pitch + pitch / 2
			const cy = originY + gy * pitch + pitch / 2
			const x0 = Math.round(cx - artW / 2)
			const y0 = Math.round(cy - artH / 2)
			for (let y = y0; y < y0 + artH; y++) {
				for (let x = x0; x < x0 + artW; x++) {
					const at = (y * w + x) * 4
					rgba[at] = 220
					rgba[at + 1] = 80
					rgba[at + 2] = 30
					rgba[at + 3] = 255
				}
			}
		}
	}
	const pngBytes = encodeRgba(rgba, w, h)
	const prevApi = globalThis.api
	globalThis.api = {
		encodeBinary: () => base64(pngBytes)
	}
	try {
		const lat = latticeOf('narrow.png')
		assert.ok(lat)
		assert.equal(lat.pitchX, pitch)
		assert.equal(lat.pitchY, pitch)
		const x0 = Math.round(lat.cx - lat.pitchX / 2)
		const y0 = Math.round(lat.cy - lat.pitchY / 2)
		const cropped = decodePng(cropPng(pngBytes, x0, y0, lat.pitchX, lat.pitchY).bytes)
		let minX = cropped.w, maxX = -1
		for (let y = 0; y < cropped.h; y++) {
			for (let x = 0; x < cropped.w; x++) {
				if (cropped.rgba[(y * cropped.w + x) * 4 + 3] > 24) {
					if (x < minX) minX = x
					if (x > maxX) maxX = x
				}
			}
		}
		const artCx = (minX + maxX + 1) / 2
		assert.ok(Math.abs(artCx - pitch / 2) <= 1, 'artwork X centre ' + artCx + ' matches cell centre ' + (pitch / 2))
	} finally {
		globalThis.api = prevApi
	}
})

test('copyGridOf falls back to generator.input.count on wrapped distributions', () => {
	const prevApi = globalThis.api
	globalThis.api = {
		get: (id, attr) => {
			if (attr === 'generator.count') throw new Error('no attr')
			if (attr === 'generator.input.count') return { x: 5, y: 17 }
			return null
		}
	}
	try {
		assert.deepEqual(copyGridOf('duplicator#24'), { x: 5, y: 17 })
	} finally {
		globalThis.api = prevApi
	}
})

test('assetArrayOf and pngDimensionsOf read an assetArray feeding an imageShader', () => {
	const pngA = encodeRgba(new Uint8Array(8 * 6 * 4), 8, 6)
	const pngB = encodeRgba(new Uint8Array(12 * 10 * 4), 12, 10)
	const files = { '/tmp/a.png': base64(pngA), '/tmp/b.png': base64(pngB) }
	const prevApi = globalThis.api
	globalThis.api = {
		getInConnection: (id, attr) => {
			if (id === 'imageShader#1' && attr === 'image') return 'assetArray#7.id'
			if (id === 'assetArray#7' && attr === 'array.0') return 'asset#1.id'
			if (id === 'assetArray#7' && attr === 'array.1') return 'asset#2.id'
			return ''
		},
		getLayerType: (id) => (id === 'assetArray#7' ? 'assetArray' : ''),
		getAssetFilePath: (id) => (id === 'asset#1' ? '/tmp/a.png' : '/tmp/b.png'),
		getNiceName: (id) => (id === 'asset#1' ? 'Product_A' : 'Product_B'),
		encodeBinary: (p) => files[p] || ''
	}
	try {
		const arr = assetArrayOf('imageShader#1')
		assert.ok(arr)
		assert.equal(arr.node, 'assetArray#7')
		assert.equal(arr.entries.length, 2)
		assert.deepEqual(pngDimensionsOf('/tmp/a.png'), { w: 8, h: 6 })
		assert.deepEqual(pngDimensionsOf('/tmp/b.png'), { w: 12, h: 10 })
	} finally {
		globalThis.api = prevApi
	}
})

test('bakeImageFills emits a multi-asset job for an assetArray-driven imageShader without rendering', () => {
	const pngA = encodeRgba(new Uint8Array(8 * 8 * 4), 8, 8)
	const pngB = encodeRgba(new Uint8Array(16 * 12 * 4), 16, 12)
	const files = { '/tmp/a.png': base64(pngA), '/tmp/b.png': base64(pngB) }
	let rendered = false
	const prevApi = globalThis.api
	globalThis.api = {
		getChildren: (id) => {
			if (id === 'comp#1') return ['duplicator#24']
			if (id === 'duplicator#24') return ['basicShape#353']
			return []
		},
		getParent: (id) => (id === 'basicShape#353' ? 'duplicator#24' : 'comp#1'),
		getLayerType: (id) => ({
			'duplicator#24': 'duplicator',
			'basicShape#353': 'basicShape',
			'imageShader#35': 'imageShader',
			'assetArray#7': 'assetArray'
		}[id] || ''),
		getInConnectedAttributes: (id) => (id === 'basicShape#353' ? ['material.colorShaders.0.shader'] : []),
		getInConnection: (id, attr) => {
			if (id === 'basicShape#353' && attr === 'material.colorShaders.0.shader') return 'imageShader#35.id'
			if (id === 'imageShader#35' && attr === 'image') return 'assetArray#7.id'
			if (id === 'assetArray#7' && attr === 'array.0') return 'asset#1.id'
			if (id === 'assetArray#7' && attr === 'array.1') return 'asset#2.id'
			return ''
		},
		get: (id, attr) => {
			if (id === 'duplicator#24' && attr === 'generator.input.count') return { x: 5, y: 17 }
			return null
		},
		getAssetFilePath: (id) => (id === 'asset#1' ? '/tmp/a.png' : '/tmp/b.png'),
		getNiceName: (id) => id,
		filePathExists: (p) => Boolean(files[p]),
		encodeBinary: (p) => files[p] || '',
		renderPNGFrame: () => { rendered = true }
	}
	try {
		const out = bakeImageFills('comp#1', 0)
		assert.equal(rendered, false, 'assetArray path reads source PNGs directly without rendering')
		assert.equal(out.length, 1)
		assert.equal(out[0].copyCount, 85)
		assert.equal(out[0].spansPitch, false)
		assert.equal(out[0].assets.length, 2)
		assert.deepEqual(out[0].assets.map((a) => [a.assetId, a.assetW, a.assetH, a.assetP]), [
			['img0', 8, 8, 'img0.png'],
			['img1', 16, 12, 'img1.png']
		])
	} finally {
		globalThis.api = prevApi
	}
})

test('bakeImageFills reuses one baked cell image when two duplicators share the same source asset and shader settings', () => {
	// Build a 3x4 grid PNG so captureShaderOnly succeeds once for the first duplicator.
	const w = 320, h = 420, pitch = 100, origin = 10, artW = 60, artH = 50
	const rgba = new Uint8Array(w * h * 4)
	for (let gy = 0; gy < 4; gy++) {
		for (let gx = 0; gx < 3; gx++) {
			const x0 = Math.round(origin + gx * pitch + (pitch - artW) / 2)
			const y0 = Math.round(origin + gy * pitch + (pitch - artH) / 2)
			for (let y = y0; y < y0 + artH; y++) {
				for (let x = x0; x < x0 + artW; x++) {
					const at = (y * w + x) * 4
					rgba[at] = 220; rgba[at + 1] = 80; rgba[at + 2] = 30; rgba[at + 3] = 255
				}
			}
		}
	}
	const captureB64 = base64(encodeRgba(rgba, w, h))
	const files = {}
	let renderCalls = 0
	const prevApi = globalThis.api
	globalThis.api = {
		getActiveComp: () => 'comp#1',
		setActiveComp: () => {},
		layerExists: () => true,
		getFrame: () => 0,
		setFrame: () => {},
		getTempFolder: () => '/tmp',
		isDirectory: () => true,
		makeFolder: () => {},
		getChildren: (id) => ({
			'comp#1': ['dup#1', 'dup#2'],
			'dup#1': ['shape#1'],
			'dup#2': ['shape#2']
		}[id] || []),
		getParent: (id) => ({
			'shape#1': 'dup#1',
			'shape#2': 'dup#2',
			'dup#1': 'comp#1',
			'dup#2': 'comp#1'
		}[id] || null),
		getLayerType: (id) => ({
			'dup#1': 'duplicator',
			'dup#2': 'duplicator',
			'shape#1': 'basicShape',
			'shape#2': 'basicShape',
			'shader#1': 'imageShader',
			'shader#2': 'imageShader',
			'asset#53': 'imageAsset'
		}[id] || ''),
		getInConnectedAttributes: (id) => (id === 'shape#1' || id === 'shape#2' ? ['material.colorShaders.0.shader'] : []),
		getInConnection: (id, attr) => {
			if (id === 'shape#1' && attr === 'material.colorShaders.0.shader') return 'shader#1.id'
			if (id === 'shape#2' && attr === 'material.colorShaders.0.shader') return 'shader#2.id'
			if ((id === 'shader#1' || id === 'shader#2') && attr === 'image') return 'asset#53.id'
			return ''
		},
		get: (id, attr) => {
			if (id === 'comp#1' && attr === 'resolution') return { x: w, y: h }
			if (id === 'comp#1' && attr === 'backgroundColor') return { r: 0, g: 0, b: 0, a: 255 }
			if (id === 'dup#1' && attr === 'generator.count') return { x: 3, y: 6 }
			if (id === 'dup#2' && attr === 'generator.count') return { x: 14, y: 20 }
			if ((id === 'shader#1' || id === 'shader#2') && attr === 'scaleMode') return 0
			if ((id === 'shader#1' || id === 'shader#2') && attr === 'scale') return { x: 1.12, y: 1.12 }
			if ((id === 'shader#1' || id === 'shader#2') && attr === 'offset') return { x: 4.35, y: 15.34 }
			if ((id === 'shape#1' || id === 'shape#2') && attr === 'generator.dimensions') return { x: 314.416, y: 314.416 }
			if (attr === 'material.materialColor') return { r: 255, g: 255, b: 255, a: 255 }
			if (attr === 'hidden') return false
			return null
		},
		set: () => {},
		renderPNGFrame: (path) => {
			renderCalls++
			files[path] = captureB64
		},
		filePathExists: (p) => Boolean(files[p]),
		encodeBinary: (p) => files[p] || '',
		writeEncodedToBinaryFile: (p, data) => {
			files[p] = data
			return true
		}
	}
	try {
		const out = bakeImageFills('comp#1', 0)
		assert.equal(out.length, 2)
		assert.equal(renderCalls, 2, 'only the first duplicator is rendered (two settle frames)')
		assert.equal(out[0].assetId, 'img0')
		assert.equal(out[1].assetId, 'img0')
		assert.equal(out[0].assetP, 'img0.png')
		assert.equal(out[1].assetP, 'img0.png')
		assert.equal(out[0].assetFile, out[1].assetFile)
		assert.equal(out[0].copyCount, 18)
		assert.equal(out[1].copyCount, 280)
	} finally {
		globalThis.api = prevApi
	}
})
