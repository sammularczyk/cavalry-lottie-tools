import test from 'node:test'
import assert from 'node:assert/strict'
import { glyphOpacity, glyphDelays } from '../src/modules/cavalryExport.js'

test('appear holds 0 until the start frame', () => {
	assert.deepEqual(glyphOpacity(5, [], 'appear').k.map((k) => [k.t, k.s[0]]), [[0, 0], [5, 100]])
})

test('fade up and down follow the progress curve from the start frame', () => {
	assert.deepEqual(glyphOpacity(3, [10, 60, 100], 'up').k.map((k) => [k.t, k.s[0]]), [[0, 0], [3, 10], [4, 60], [5, 100]])
	assert.deepEqual(glyphOpacity(3, [10, 100], 'down').k.map((k) => [k.t, k.s[0]]), [[0, 100], [3, 90], [4, 0]])
})

const aa = { automatic: true, offset: -8, timing: 0, groupByParent: false, level: 2, reverse: false }

test('word delays spread the offset evenly, listed last glyph first', () => {
	assert.deepEqual(glyphDelays('Craft in ProSuite.', aa), [8, 8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 0, 0, 0, 0, 0])
	assert.deepEqual(glyphDelays('Craft in ProSuite.', { ...aa, reverse: true })[0], 0)
})

test('anything but the plain case falls back to null', () => {
	assert.equal(glyphDelays('a b', { ...aa, offset: 8 }), null)
	assert.equal(glyphDelays('a b', { ...aa, timing: 1 }), null)
})
