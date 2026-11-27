import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { timeBase, readFrame, labelFrame } from '../src/modules/cavalryExport.js'

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

// A comp whose playback range is narrower than its authored range. Cropping used to set
// startFrame = playbackStart, which shifted Cavalry's time base so every read landed 30
// frames late: a colour cycle starting teal exported its first key as the purple 30 frames in.
test('readFrame converts an authored label to the frame setFrame reads', () => {
	assert.equal(readFrame(30, 0), 30)
	assert.equal(readFrame(30, 30), 0)
	assert.equal(readFrame(179, 30), 149)
	assert.equal(labelFrame(0, 30), 30)
	assert.equal(labelFrame(149, 30), 179)
})

test('timeBase is the comp startFrame, and 0 when it is absent or not finite', () => {
	const api = { get: (id, attr) => (attr === 'startFrame' ? 30 : undefined) }
	const saved = globalThis.api
	globalThis.api = api
	try {
		assert.equal(timeBase('compNode#1'), 30)
		api.get = () => undefined
		assert.equal(timeBase('compNode#1'), 0)
		api.get = () => 'abc'
		assert.equal(timeBase('compNode#1'), 0)
	} finally {
		globalThis.api = saved
	}
})

test('exportComp crops through the render queue Custom Range, never through startFrame', () => {
	const text = src('../src/modules/cavalryExport.js')
	// The crop path must request Custom Range (2) with the label range.
	assert.match(text, /frameRangeMode: 2, frameRange: \{ x: opts\.crop\.from, y: opts\.crop\.to \}/)
	// The uncropped path keeps Composition Start.
	assert.match(text, /frameRangeMode: 0/)
	// Nothing in the exporter sets the comp's startFrame or endFrame.
	assert.doesNotMatch(text, /startFrame:/)
	assert.doesNotMatch(text, /endFrame:/)
	assert.doesNotMatch(text, /api\.set\(compId, \{/)
})

test('exportSelected leaves the comp range alone and passes the crop to the exporter', () => {
	const text = src('../src/Lottie Optimiser.js')
	const start = text.indexOf('function exportSelected(')
	const end = text.indexOf('function exportRange(')
	assert.ok(start > 0 && end > start, 'exportSelected and exportRange are present')
	const body = text.slice(start, end)
	// The crop is computed from the playback range and handed down.
	assert.match(body, /crop = narrow \? \{ from: range\.playbackStart, to: range\.playbackEnd \} : null/)
	assert.match(body, /exportRange\(measured, crop\)/)
	// It no longer sets the comp's range, and no longer needs to restore it.
	assert.doesNotMatch(body, /startFrame: /)
	assert.doesNotMatch(body, /endFrame: /)
})

test('exportWithPrecomps does not shadow the module shift(prop, dx, dy) helper', () => {
	const text = src('../src/modules/precomps.js')
	const start = text.indexOf('export function exportWithPrecomps(')
	assert.ok(start > 0, 'exportWithPrecomps is present')
	const body = text.slice(start)
	assert.doesNotMatch(body, /\b(?:const|let|var)\s+shift\b/)
	assert.match(body, /\bshift\(L\.ks && L\.ks\.a, w \/ 2, h \/ 2\)/)
})
