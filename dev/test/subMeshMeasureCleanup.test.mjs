import test from 'node:test'
import assert from 'node:assert/strict'

// Deleting the comp that is currently active crashes Cavalry, and probe teardown
// is exactly the code that deletes comps. These tests pin the guard that parks
// the active comp on a survivor first.

const scene = ({ comps, layers = [], active, comp }) => {
	const live = new Set(comps)
	const liveLayers = new Set(layers)
	const st = { active, deletes: [], parked: null }
	globalThis.api = {
		getComps: () => [...live],
		getAllSceneLayers: () => [...liveLayers],
		layerExists: (id) => live.has(id) || liveLayers.has(id),
		getActiveComp: () => st.active,
		setActiveComp: (id) => {
			assert.ok(live.has(id), 'parked on a comp that does not exist: ' + id)
			st.parked = id
			st.active = id
		},
		deleteLayer: (id) => {
			assert.notEqual(id, st.active, 'tried to delete the ACTIVE comp ' + id)
			st.deletes.push(id)
			live.delete(id)
			liveLayers.delete(id)
		},
	}
	return { st, live, liveLayers }
}

const state = (compsBefore, comp) => ({ comp, compsBefore, layersBefore: [] })

test('cleanup parks the active comp on the source comp before deleting the probe', async () => {
	const { discardSubMeshMeasurement } = await import('../src/modules/subMeshMeasure.js')
	const s = scene({ comps: ['compNode#1', 'compNode#2', 'compNode#90'], active: 'compNode#90' })
	discardSubMeshMeasurement(state(['compNode#1', 'compNode#2'], 'compNode#1'))
	assert.equal(s.st.parked, 'compNode#1')
	assert.deepEqual(s.st.deletes, ['compNode#90'])
})

test('cleanup falls back to any surviving comp when the source is gone', async () => {
	const { discardSubMeshMeasurement } = await import('../src/modules/subMeshMeasure.js')
	const s = scene({ comps: ['compNode#1', 'compNode#2', 'compNode#90'], active: 'compNode#90' })
	discardSubMeshMeasurement(state(['compNode#1', 'compNode#2'], 'compNode#7'))
	assert.equal(s.st.parked, 'compNode#1')
	assert.deepEqual(s.st.deletes, ['compNode#90'])
})

test('cleanup deletes without parking when the active comp is a keeper', async () => {
	const { discardSubMeshMeasurement } = await import('../src/modules/subMeshMeasure.js')
	const s = scene({ comps: ['compNode#1', 'compNode#90'], active: 'compNode#1' })
	discardSubMeshMeasurement(state(['compNode#1'], 'compNode#1'))
	assert.equal(s.st.parked, null)
	assert.deepEqual(s.st.deletes, ['compNode#90'])
})

test('cleanup refuses to run when every comp is doomed', async () => {
	const { discardSubMeshMeasurement } = await import('../src/modules/subMeshMeasure.js')
	const s = scene({ comps: ['compNode#90'], active: 'compNode#90' })
	discardSubMeshMeasurement({ comp: 'compNode#90', compsBefore: [], layersBefore: [] })
	assert.deepEqual(s.st.deletes, [])
	assert.equal(s.st.active, 'compNode#90')
})

test('cleanup refuses to touch anything when the snapshots are missing', async () => {
	const { discardSubMeshMeasurement } = await import('../src/modules/subMeshMeasure.js')
	const s = scene({ comps: ['compNode#1', 'compNode#90'], active: 'compNode#90' })
	discardSubMeshMeasurement({ comp: 'compNode#1' })
	assert.deepEqual(s.st.deletes, [])
	assert.equal(s.st.active, 'compNode#90')
})
