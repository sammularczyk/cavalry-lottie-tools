import test from 'node:test'
import assert from 'node:assert/strict'
import { taperOutlines, trimWindows, widthCurve } from '../src/modules/taper.js'

const line = { c: false, v: [[-30, 0], [30, 0]], i: [[0, 0], [-20, 0]], o: [[20, 0], [0, 0]] }
const flat = widthCurve([{ x: 0, y: 1, lx: 0, ly: 0, rx: 0.3, ry: 0 }, { x: 1, y: 1, lx: -0.3, ly: 0, rx: 0, ry: 0 }])
const ramp = widthCurve([{ x: 1, y: 1, lx: -0.3, ly: -0.3, rx: 0, ry: 0 }, { x: 0, y: 0, lx: 0, ly: 0, rx: 0.3, ry: 0.3 }]) // out of order, as stored

test('taperOutlines: width × curve across the line, round caps half a width past the ends', () => {
	const [o] = taperOutlines(line, 10, flat, null, true)
	const ys = o.v.map((p) => p[1]), xs = o.v.map((p) => p[0])
	assert.ok(Math.abs(Math.max(...ys) - 5) < 1e-6 && Math.abs(Math.min(...ys) + 5) < 1e-6)
	assert.ok(Math.abs(Math.max(...xs) - 35) < 0.1 && Math.abs(Math.min(...xs) + 35) < 0.1)
	const mid = taperOutlines(line, 10, ramp, null, false)[0].v.filter((p) => Math.abs(p[0]) < 1e-6)
	assert.deepEqual(mid.map((p) => Math.abs(p[1]).toFixed(3)), ['2.500', '2.500']) // half of 10 × 0.5
})

test('trimWindows: travel wraps; the taper stays on the whole contour', () => {
	assert.deepEqual(trimWindows({ start: 20, end: 70, travel: 40 }).map((w) => w.map((x) => +x.toFixed(6))), [[0.6, 1], [0, 0.1]])
	assert.deepEqual(trimWindows({ start: 30, end: 30, travel: 0 }), [])
	const [o] = taperOutlines(line, 10, ramp, { start: 50, end: 100, travel: 0 }, false)
	const xs = o.v.map((p) => p[0])
	assert.ok(Math.abs(Math.min(...xs)) < 1e-6) // starts mid-line, where the ramp is already at 0.5
	assert.ok(o.v.some((p) => Math.abs(p[0]) < 1e-6 && Math.abs(Math.abs(p[1]) - 2.5) < 1e-6))
})
