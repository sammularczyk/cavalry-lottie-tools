import test from 'node:test'
import assert from 'node:assert/strict'
import {
	parseIndexList,
	visibilitySequenceMask,
	expressionMask,
	expressionIsIndexPure,
	maskToOpacityProp,
	applyMasksToGroups,
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

test('maskToOpacityProp writes 0/100 keys per frame', () => {
	const prop = maskToOpacityProp([1, 0, 1], frames)
	assert.equal(prop.a, 1)
	assert.deepEqual(prop.k.map((k) => [k.t, k.s[0]]), [[0, 100], [1, 0], [2, 100]])
})

test('applyMasksToGroups injects opacity, marks all-hidden, skips all-visible', () => {
	const groups = [group(0, 0), group(10, 0), group(20, 0)]
	const masks = { 0: [1, 1, 1], 1: [0, 0, 0], 2: [1, 0, 1] }
	const n = applyMasksToGroups(groups, masks, frames)
	assert.equal(n, 2)
	assert.equal(groups[0].hd, undefined) // all visible → untouched
	assert.equal(groups[1].hd, true) // never visible → culled
	const tr = groups[2].it.find((i) => i.ty === 'tr')
	assert.equal(tr.o.a, 1)
	assert.deepEqual(tr.o.k.map((k) => k.s[0]), [100, 0, 100])
})

test('applyMasksToGroups leaves already-animated opacity alone', () => {
	const g = group(0, 0)
	g.it.find((i) => i.ty === 'tr').o = { a: 1, k: [{ t: 0, s: [50] }] }
	const n = applyMasksToGroups([g], { 0: [0, 1, 0] }, frames)
	assert.equal(n, 0)
	assert.deepEqual(g.it.find((i) => i.ty === 'tr').o.k, [{ t: 0, s: [50] }])
})
