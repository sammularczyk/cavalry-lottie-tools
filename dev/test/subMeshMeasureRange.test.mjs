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
	// stride from a 467-frame span is under 21, not 53
	for (let i = 1; i < t.frames.length; i++) assert.ok(t.frames[i] - t.frames[i - 1] <= 21)
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
