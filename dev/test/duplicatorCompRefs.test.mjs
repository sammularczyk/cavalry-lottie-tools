import test from 'node:test'
import assert from 'node:assert/strict'

// The module reads the Cavalry `api` global at call time, so a stub scene is enough.
// These tests cover the parts that decide whether a measurement can be trusted:
// decoding a baked width series, and refusing a marker that no longer matches the
// scene. Both were the site of the reported failure — a stale marker aborted the
// export, and an unseen sampler shipped silent zero offsets.

const rect = (w) => [[0, 0], [w, 0], [w, 1], [0, 1]]

// A baked rectangle whose width is w(t) = clamp(t + off, 0, last) · 100/last.
function series(off, last, step = 1) {
	const out = []
	for (let t = 0; t <= last; t += step) {
		const w = Math.max(0, Math.min(last, t + off)) * (100 / last)
		out.push({ t, s: [{ v: rect(w) }] })
	}
	return { a: 1, k: out }
}

const active = { comp: 'compNode#1', frame: 0 }

const scene = (layers, files = {}) => {
	const set = new Set(layers)
	return {
		getAllSceneLayers: () => [...set],
		layerExists: (id) => set.has(id),
		getTempFolder: () => '/tmp',
		filePathExists: (f) => files[f] != null,
		readFromFile: (f) => files[f],
		writeToFile: (f, v) => { files[f] = v },
		deleteFilePath: (f) => { delete files[f]; return true },
		// Cavalry returns an array of ids; two keys for a live sampler, none for a dead one
		getKeyframeIdsForAttribute: (id) =>
			Array.from({ length: files.__keys && files.__keys[id] != null ? files.__keys[id] : 2 }, (_, i) => 'kf#' + i),
		getNiceName: (id) => id,
		deleteLayer: (id) => { set.delete(id) },
		// the measurement renders the probe comp, so the comp Cavalry has open is
		// restored afterwards; these record that
		getFrame: () => 17,
		getActiveComp: () => active.comp,
		setActiveComp: (id) => { active.comp = id },
		setFrame: (f) => { active.frame = f },
	}
}

test('offsetFromWidth recovers the per-copy offset from an interior sweep', async () => {
	const { offsetFromWidth, widthSeries } = await import('../src/modules/duplicatorCompRefs.js')
	for (const off of [0, 7.74, -7.87, 0.23, 17.8, -6.52]) {
		const decoded = offsetFromWidth(widthSeries(series(off, 90)), 90)
		assert.ok(Math.abs(decoded - off) < 0.02, `offset ${off} decoded as ${decoded}`)
	}
})

test('offsetFromWidth falls back to the hold edges when the copy is clamped', async () => {
	const { offsetFromWidth, widthSeries } = await import('../src/modules/duplicatorCompRefs.js')
	// a copy sampled past the end starts already full width: only the exit edge is left
	const late = widthSeries(series(200, 90))
	assert.equal(offsetFromWidth(late, 90), 90 - 0)
	// a copy sampled before the start stays at zero: the first rise is at t ≈ -off
	// (one frame of quantisation, since the 0.5% threshold sits just inside it)
	const early = widthSeries(series(-40, 90))
	assert.ok(Math.abs(offsetFromWidth(early, 90) - -40) <= 1.5)
})

test('widthSeries reads a static path as a single frame', async () => {
	const { widthSeries, offsetFromWidth } = await import('../src/modules/duplicatorCompRefs.js')
	const ws = widthSeries({ a: 0, k: { v: rect(50) } })
	assert.deepEqual(ws, [{ t: 0, w: 50 }])
	// at half width the copy sits mid-sweep, so the offset reads off the interior formula
	assert.equal(offsetFromWidth(ws, 100), 50)
})

test('widthSeries rejects a shape with no path', async () => {
	const { widthSeries } = await import('../src/modules/duplicatorCompRefs.js')
	assert.equal(widthSeries({ a: 1, k: [{ t: 0, s: [null] }] }), null)
	assert.equal(widthSeries({}), null)
})

test('readProbeState rejects a marker whose sampler is gone', async () => {
	const { readProbeState } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	const marker = '/tmp/lottie-optimiser-timing.json'
	files[marker] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90, created: [],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	// the sampler the marker names has been deleted from the scene
	globalThis.api = scene(['compNode#25', 'compNode#99', 'duplicator#60'], files)
	assert.equal(readProbeState(), null, 'a deleted sampler must not be trusted')
})

test('readProbeState rejects a sampler that lost its keyframes', async () => {
	const { readProbeState } = await import('../src/modules/duplicatorCompRefs.js')
	const files = { __keys: {} }
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90, created: [],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(['compNode#25', 'compNode#99', 'duplicator#60', 'basicShape#315'], files)
	assert.ok(readProbeState(), 'a live sampler with two keys is usable')
	files.__keys['basicShape#315'] = 0
	assert.equal(readProbeState(), null, 'a keyframe-less sampler must not be trusted')
})

test('readProbeState rejects a missing or malformed marker', async () => {
	const { readProbeState } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	globalThis.api = scene(['compNode#25'], files)
	assert.equal(readProbeState(), null, 'no marker file')
	files['/tmp/lottie-optimiser-timing.json'] = 'not json'
	assert.equal(readProbeState(), null, 'unparseable marker')
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({ comp: 'compNode#25', probes: [] })
	assert.equal(readProbeState(), null, 'a marker with no probes')
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#999', probeComp: 'compNode#99', probes: [{ dup: 'd#1', rect: 'r#1' }],
	})
	assert.equal(readProbeState(), null, 'a marker for a comp that is gone')
})

test('timingMeasurementPending follows readProbeState', async () => {
	const { timingMeasurementPending } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	globalThis.api = scene(['compNode#25'], files)
	assert.equal(timingMeasurementPending(), false)
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90, created: [],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(['compNode#25', 'compNode#99', 'duplicator#60', 'basicShape#315'], files)
	assert.equal(timingMeasurementPending(), true)
})

test('collectTimingMeasurement returns empty results and clears a stale marker instead of throwing', async () => {
	const { collectTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	// a marker naming a sampler that no longer exists — the reported failure
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90, created: [],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(['compNode#25'], files) // nothing else survives
	const r = collectTimingMeasurement()
	assert.deepEqual(r.timing, {})
	assert.deepEqual(r.points, {})
	assert.equal(files['/tmp/lottie-optimiser-timing.json'], undefined, 'the dead marker is deleted')
})

test('collectTimingMeasurement puts the open comp back when there is nothing to read', async () => {
	const { collectTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	globalThis.api = scene(['compNode#25', 'compNode#99'], files)
	// the probe comp was left open by an interrupted measurement
	active.comp = 'compNode#99'
	active.frame = 0
	collectTimingMeasurement('compNode#25')
	// the export that follows captures the active comp as the one to restore, so a
	// deleted or wrong comp left here makes the scene end up on the wrong comp
	assert.equal(active.comp, 'compNode#25')
	assert.equal(active.frame, 17)
})

test('needsTimingMeasurement is false when the scene cannot be read', async () => {
	const { needsTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	globalThis.api = { getAllSceneLayers: () => { throw new Error('no scene') } }
	assert.equal(needsTimingMeasurement('compNode#25'), false)
})

test('readProbeState refuses a measurement set up for a different comp', async () => {
	const { readProbeState, timingMeasurementPending } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90, created: [],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(['compNode#25', 'compNode#99', 'duplicator#60', 'basicShape#315'], files)
	assert.ok(readProbeState('compNode#25'), 'the comp it was built for')
	assert.equal(readProbeState('compNode#26'), null, 'a different comp must not spend it')
	assert.equal(timingMeasurementPending('compNode#26'), false)
})

test('discardTimingMeasurement removes the probe comp, its layers and the marker', async () => {
	const { discardTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	const marker = '/tmp/lottie-optimiser-timing.json'
	files[marker] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90,
		created: ['compNode#99', 'duplicator#60', 'basicShape#315'],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(['compNode#25', 'duplicator#32', 'compNode#99', 'duplicator#60', 'basicShape#315'], files)
	discardTimingMeasurement()
	assert.deepEqual(globalThis.api.getAllSceneLayers().sort(), ['compNode#25', 'duplicator#32'])
	assert.equal(files[marker], undefined)
})

test('discardTimingMeasurement is safe when nothing is pending', async () => {
	const { discardTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	globalThis.api = scene(['compNode#25'], {})
	assert.doesNotThrow(() => discardTimingMeasurement())
})

test('the measurement cleanup leaves layers the user added between the two clicks alone', async () => {
	const { discardTimingMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	const files = {}
	files['/tmp/lottie-optimiser-timing.json'] = JSON.stringify({
		comp: 'compNode#25', probeComp: 'compNode#99', start: 0, last: 90,
		// only what the probe created — the user's new layer is not in here
		created: ['compNode#99', 'duplicator#60', 'basicShape#315'],
		probes: [{ src: 'duplicator#32', dup: 'duplicator#60', rect: 'basicShape#315' }],
	})
	globalThis.api = scene(
		['compNode#25', 'duplicator#32', 'compNode#99', 'duplicator#60', 'basicShape#315', 'textShape#900'],
		files,
	)
	discardTimingMeasurement()
	assert.ok(globalThis.api.layerExists('textShape#900'), 'a layer added after click 1 must survive')
	assert.ok(globalThis.api.layerExists('duplicator#32'), 'the user duplicator must survive')
	assert.equal(globalThis.api.layerExists('compNode#99'), false, 'the probe comp goes')
	assert.equal(globalThis.api.layerExists('basicShape#315'), false, 'the sampler goes')
})

// --- deferred measurement retry policy ---------------------------------------
// The one-click export finishes from a Timer callback. If that render landed
// before the panel went idle the bake reads all zeros, which is the failure the
// report must never ship silently; one retry on a longer delay covers it, and
// two attempts is the hard ceiling so a hopeless driver cannot loop.

test('shouldRetryMeasurement retries once when nothing was measured', async () => {
	const { shouldRetryMeasurement, MAX_MEASUREMENT_ATTEMPTS } = await import(
		'../src/modules/duplicatorCompRefs.js'
	)
	assert.equal(MAX_MEASUREMENT_ATTEMPTS, 2)
	assert.equal(shouldRetryMeasurement({ timing: {}, points: {}, notes: [] }, 1), true)
})

test('shouldRetryMeasurement never exceeds two attempts', async () => {
	const { shouldRetryMeasurement, MAX_MEASUREMENT_ATTEMPTS } = await import(
		'../src/modules/duplicatorCompRefs.js'
	)
	assert.equal(shouldRetryMeasurement({ timing: {} }, MAX_MEASUREMENT_ATTEMPTS), false)
	assert.equal(shouldRetryMeasurement({ timing: {} }, 5), false)
})

test('shouldRetryMeasurement keeps a real measurement', async () => {
	const { shouldRetryMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	const good = { timing: { 'duplicator#32': [7.74, -7.87, 0.23, 17.8, -6.52] }, points: {}, notes: [] }
	assert.equal(shouldRetryMeasurement(good, 1), false)
})

test('shouldRetryMeasurement treats a missing measurement as retryable', async () => {
	const { shouldRetryMeasurement } = await import('../src/modules/duplicatorCompRefs.js')
	assert.equal(shouldRetryMeasurement(null, 1), true)
	assert.equal(shouldRetryMeasurement(undefined, 1), true)
})
