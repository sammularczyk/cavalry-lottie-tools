import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePng, cropPixels, cropPng } from '../src/modules/png.js'
import { deflateRaw, crc32 } from '../src/modules/zip.js'

// Build a PNG the same way the exporter does, so the tests exercise the real
// encoder rather than a fixture produced by another tool.
function encodeForTest(rgba, w, h) {
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

// A 4x3 image with a distinct colour per pixel and a transparent corner.
function sample() {
	const w = 4
	const h = 3
	const rgba = new Uint8Array(w * h * 4)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const at = (y * w + x) * 4
			rgba[at] = x * 40
			rgba[at + 1] = y * 60
			rgba[at + 2] = 200
			rgba[at + 3] = x === 0 && y === 0 ? 0 : 255
		}
	}
	return { w, h, rgba }
}

test('decodePng round-trips a generated PNG', () => {
	const { w, h, rgba } = sample()
	const img = decodePng(encodeForTest(rgba, w, h))
	assert.equal(img.w, w)
	assert.equal(img.h, h)
	assert.deepEqual(Array.from(img.rgba), Array.from(rgba))
})

test('decodePng keeps the alpha channel, including a fully transparent pixel', () => {
	const { w, h, rgba } = sample()
	const img = decodePng(encodeForTest(rgba, w, h))
	assert.equal(img.rgba[3], 0)
	assert.equal(img.rgba[7], 255)
})

test('decodePng rejects data that is not a PNG', () => {
	assert.equal(decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), null)
})

test('cropPixels returns the requested rectangle', () => {
	const { w, h, rgba } = sample()
	const img = { w, h, rgba }
	const cell = cropPixels(img, 1, 1, 2, 2)
	assert.equal(cell.w, 2)
	assert.equal(cell.h, 2)
	// Top-left of the crop is source pixel (1,1).
	assert.equal(cell.rgba[0], 40)
	assert.equal(cell.rgba[1], 60)
})

test('cropPixels clamps a rectangle that runs past the edge', () => {
	const { w, h, rgba } = sample()
	const cell = cropPixels({ w, h, rgba }, 3, 2, 10, 10)
	assert.equal(cell.w, 1)
	assert.equal(cell.h, 1)
})

test('cropPixels never returns a zero-sized image', () => {
	const { w, h, rgba } = sample()
	assert.equal(cropPixels({ w, h, rgba }, 2, 1, 0, 0).w, 1)
})

test('cropPng produces a standalone PNG of the cropped size', () => {
	const { w, h, rgba } = sample()
	const out = cropPng(encodeForTest(rgba, w, h), 1, 1, 2, 2)
	assert.equal(out.w, 2)
	assert.equal(out.h, 2)
	const back = decodePng(out.bytes)
	assert.equal(back.w, 2)
	assert.equal(back.h, 2)
	assert.deepEqual(Array.from(back.rgba), Array.from(cropPixels({ w, h, rgba }, 1, 1, 2, 2).rgba))
})

test('cropPng returns null for undecodable input', () => {
	assert.equal(cropPng(Uint8Array.from([0, 0, 0, 0]), 0, 0, 1, 1), null)
})

test('a large crop stays much smaller than the source frame', () => {
	// A flat-colour 1080x2400 frame stands in for a Cavalry capture: the point is
	// that cropping emits a cell-sized PNG, not a full frame.
	const w = 1080
	const h = 2400
	const rgba = new Uint8Array(w * h * 4)
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = 20
		rgba[i + 1] = 20
		rgba[i + 2] = 20
		rgba[i + 3] = 0
	}
	const src = encodeForTest(rgba, w, h)
	const out = cropPng(src, 100, 200, 144, 144)
	assert.equal(out.w, 144)
	assert.equal(out.h, 144)
	assert.ok(out.bytes.length < src.length)
})
