import test from 'node:test'
import assert from 'node:assert/strict'

// Two sampling bugs made _14's mango reveal uneven and off-centre:
// 1. measureTarget sampled the comp's authored range (1200 frames) instead of
//    the playback range (467), so a 24-sample cap left an 53-frame stride and
//    the falloff's 202 -> 221 scale ramp fell between samples.
// 2. chainSampleFrames only followed top-level attributes, so it never saw the
//    Value's `falloffs.0.id` slot connection and never reached the Falloff.

const nodes = (over) => ({
	'subMesh#1': { type: 'subMesh', in: { shapeVisibility: 'value#85.id' } },
	'value#85': {
		type: 'value',
		attrs: ['falloffs', 'id', 'offset', 'strength', 'timeOffset', 'value'],
		children: { falloffs: ['falloffs.0'] },
		in: { 'falloffs.0.id': 'falloff#2.id' },
	},
	'falloff#2': {
		type: 'falloff',
		attrs: ['id', 'position', 'scale.x', 'scale.y', 'size'],
		keyframes: { 'scale.x': [202, 221] },
	},
	...over,
})

const mockApi = (nodesById, comp) => {
	globalThis.api = {
		getLayerType: (id) => nodesById[id] && nodesById[id].type,
		getAttributes: (id) => (nodesById[id] && nodesById[id].attrs) || [],
		getInConnection: (id, attr) => ((nodesById[id] && nodesById[id].in) || {})[attr] || '',
		getInConnectedAttributes: (id) => Object.keys((nodesById[id] && nodesById[id].in) || {}),
		getKeyframeTimes: (id, attr) => ((nodesById[id] && nodesById[id].keyframes) || {})[attr] || [],
		getAttrChildren: (id, attr) => ((nodesById[id] && nodesById[id].children) || {})[attr] || [],
		get: (id, attr) => (id === 'compNode#1' ? comp[attr] : nodesById[id] && nodesById[id][attr]),
	}
}

const comp = { startFrame: 0, endFrame: 1200, playbackStart: 0, playbackEnd: 467 }

test('measureTarget samples the playback range, not the authored range', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(t, 'expected a measurement target')
	assert.ok(t.frames.every((f) => f <= 467), 'sampled past playback end: ' + t.frames.join(','))
	assert.equal(t.frames[0], 0)
	assert.equal(t.frames[t.frames.length - 1], 467)
})

// A chain with no keyframes anywhere has no marked span to concentrate on, so
// it keeps the full coarse grid: nothing says where the value may move.
test('an unkeyed chain still gets the full coarse grid', async () => {
	const unkeyed = nodes({ 'falloff#2': { type: 'falloff', attrs: ['scale.x'], keyframes: {} } })
	mockApi(unkeyed, comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(t.frames.length >= 24, 'lost the coarse grid: ' + t.frames.length)
	for (let i = 1; i < t.frames.length; i++) assert.ok(t.frames[i] - t.frames[i - 1] <= 21)
})

// Once the chain IS keyed, the keyframe spans carry the detail and the coarse
// sweep is only a safety net. Spending the full 24-sample grid on _14 as well
// cost 22 extra bakes to move 0.21% -> 0.17% wrong-gate.
test('a keyed chain samples the span densely and the rest sparsely', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(t.frames.length <= 20, 'keyed chain spent too many bakes: ' + t.frames.length)
	assert.ok(t.frames.includes(0) && t.frames.includes(467), 'range ends missing')
})

test('measureTarget follows a list-slot connection to the falloff keyframes', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(t.frames.includes(202), 'missing falloff key at 202: ' + t.frames.join(','))
	assert.ok(t.frames.includes(221), 'missing falloff key at 221: ' + t.frames.join(','))
})

test('chain sampling ignores falloff keys outside the playback range', async () => {
	const outside = nodes({ 'falloff#2': { type: 'falloff', attrs: ['scale.x'], keyframes: { 'scale.x': [900] } } })
	mockApi(outside, comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(!t.frames.includes(900), 'sampled a frame past playback end')
})

// A baked value is held until the next sample, so a coarse stride reads the
// wrong gate on every frame between samples. _14's falloff ramps over 202..221
// and both ends were sampled, yet the ramp itself was not: the held value
// disagreed with the true per-copy gate on 3.65% of copy-frames, every one of
// them inside the ramp. Sampling the ramp's interior and interpolating between
// samples is what removes that; filling every frame costs more than twice the
// bakes for a quarter-point of extra accuracy.
test('sampling adds interior points inside a keyframe span', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	const inSpan = t.frames.filter((f) => f > 202 && f < 221)
	assert.ok(inSpan.length >= 4, 'no interior samples in the ramp: ' + t.frames.join(','))
	assert.ok(t.frames.includes(202) && t.frames.includes(221), 'span ends missing')
	for (let i = 1; i < inSpan.length; i++) assert.ok(inSpan[i] - inSpan[i - 1] <= 4, 'interior gaps too wide')
})

test('a ramp is sampled sparsely rather than per frame', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(t.frames.length <= 40, 'sampled too many frames for one ramp: ' + t.frames.length)
})

test('a continuous driver is marked for interpolation, a seeded one is not', async () => {
	mockApi(nodes(), comp)
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const cont = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.equal(cont.interp, true)
	// A seeded driver (Random/Noise) re-rolls and then holds, so it must not be
	// interpolated: its crossing frames are measured and the value is held.
	const seeded = nodes({
		'random#7': { type: 'random', attrs: ['seed', 'minimum', 'maximum'], keyframes: { seed: [0, 60] }, in: {} },
		'subMesh#1': { type: 'subMesh', in: { shapeVisibility: 'random#7.id' } },
	})
	mockApi(seeded, { ...comp, startFrame: 0, endFrame: 60, playbackStart: 0, playbackEnd: 60 })
	globalThis.api.hasAttribute = () => false
	globalThis.api.setFrame = () => {}
	const rnd = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	assert.ok(rnd, 'expected a seeded measurement target')
	assert.notEqual(rnd.interp, true, 'a seeded driver must hold, not interpolate')
})

test('dense filling stops at the budget instead of baking a whole long comp', async () => {
	const long = nodes({
		'falloff#2': { type: 'falloff', attrs: ['scale.x'], keyframes: { 'scale.x': [10, 1200] } },
	})
	mockApi(long, { startFrame: 0, endFrame: 1300, playbackStart: 0, playbackEnd: 1290 })
	const { measureTarget } = await import('../src/modules/subMeshMeasure.js')
	const t = measureTarget('subMesh#1', 'shapeVisibility', 'compNode#1', 0)
	// a sparse safety sweep plus at most MAX_DENSE_FRAMES of span points
	assert.ok(t.frames.length < 60, 'sampled too many frames: ' + t.frames.length)
	assert.ok(t.frames.includes(0) && t.frames.includes(1290), 'range ends missing')
})
