// Measure a subMesh driver's per-copy values inside Cavalry.
//
// A seeded Random (or anything downstream of one, such as a Value with falloffs)
// has per-copy values only Cavalry can compute: api.get always evaluates at the
// default dynamic index, and cavalry.random does not reproduce a node's stream.
// The one per-copy channel the Lottie writer keeps is TIME: a duplicator's
// shapeTimeOffset shifts when each copy samples its input shape. So the node
// that drives the subMesh attribute is routed into the time offset of a deep
// duplicate of the host, in a throwaway comp, whose only input is a rectangle
// with a linear width ramp. Each baked copy's width then encodes the node's
// value for that copy at that frame:
//
//   shapeTimeOffset = value * SCALE + SHIFT          (two math nodes)
//   width(t)        = 100 * t                        (keys 0 -> 0, 2 -> 200)
//   value           = (width(0) / 100 - SHIFT) / SCALE
//
// Measured live (at SCALE 0.005): offsets 0.4 / -3.25 / 17.3 / 43 decode to
// 0.4 / -3.248 / 17.3 / 43. The shift keeps every sample time inside the probe
// comp's range, because the duplicator clamps sample times to it and a negative
// time bakes a broken static path. SCALE 0.004 reads values in ±125 (so a full
// 0..100 opacity fits with room) at a resolution of about 0.0025 (the writer
// rounds path coordinates to 3 decimals).
//
// Always measure the node CONNECTED TO THE SUBMESH, never one further
// upstream: a Random's per-copy roll depends on the layer it feeds, so routing
// it into a math node reads a different stream (measured: a Random feeding an
// oscillator's timeOffset decoded to phases unrelated to the oscillator's real
// per-copy output).
//
// Cavalry only re-evaluates a freshly keyframed sampler in a LATER script
// execution (see duplicatorCompRefs.js), so prepare and collect run in two
// executions: the UI arms an api.Timer between them.
//
// The measured node evaluates at the USER comp's playhead, not at the probe's
// frame (measured: an oscillator read the same value at every probe frame, and
// followed the user comp's playhead from bake to bake). So the probe bakes
// once per playhead frame a target needs, all in the second execution. A
// value is read at the comp's first frame and treated as constant over time,
// which holds for seeded Randoms and static falloffs. An oscillator whose
// timeOffset is driven is read at the first frame and a quarter cycle later,
// which fixes each copy's phase (sine waves only). Layer-seeded Randoms are
// left out: re-wiring may re-roll them, and they are a planned follow-up.

import { compLayers, subMeshHost, driverUsesLayerSeed, oscillatorConfig } from './cavalryExport.js'
import { expressionIsIndexPure, phaseSampleGap } from './submeshVisibility.js'
import { rawBake } from './duplicatorCompRefs.js'

const SCALE = 0.004
const SHIFT = 0.5
const PROBE_NAME = 'lottie-optimiser-submesh-probe'

const srcOf = (id, attr) => String(api.getInConnection(id, attr) || '').split('.')[0]

// What has to be measured for one driven subMesh attribute, or null when the
// driver is evaluated analytically (or is not handled at all). `node` is
// always the node connected to the attribute; `frames` the user comp's
// playhead frames it is read at.
//   kind 'value': a gate or opacity value, constant over time
//   kind 'phase': an oscillator whose timeOffset is driven
export function measureTarget(sm, attr, comp) {
	const conn = srcOf(sm, attr)
	if (!conn) return null
	const type = api.getLayerType(conn)
	if (type === 'visibility') return null
	if (type === 'javaScript' && expressionIsIndexPure(api.get(conn, 'expression'))) return null
	if (driverUsesLayerSeed(sm, attr)) return null
	if (type === 'oscillator') {
		if (attr !== 'shapeOpacity' || !srcOf(conn, 'timeOffset')) return null
		const cfg = oscillatorConfig(conn, comp)
		if (!cfg || Number(cfg.waveType) !== 0 || Number(cfg.trigType) === 2) return null
		const f0 = Number(api.get(comp, 'startFrame')) || 0
		const gap = Math.min(phaseSampleGap(cfg), (Number(api.get(comp, 'endFrame')) || 0) - f0)
		return gap > 0 ? { kind: 'phase', node: conn, frames: [f0, f0 + gap] } : null
	}
	return { kind: 'value', node: conn, frames: [Number(api.get(comp, 'startFrame')) || 0] }
}

// Every subMesh attribute in the comp that needs a measurement.
export function subMeshMeasureTargets(comp) {
	const out = []
	compLayers(comp).forEach((sm) => {
		if (api.getLayerType(sm) !== 'subMesh') return
		const host = subMeshHost(sm, comp)
		if (!host) return
		;['shapeVisibility', 'shapeOpacity'].forEach((attr) => {
			const t = measureTarget(sm, attr, comp)
			if (t) out.push(Object.assign({ sm, attr, host }, t))
		})
	})
	return out
}

export function needsSubMeshMeasurement(comp) {
	return subMeshMeasureTargets(comp).length > 0
}

function disconnectAll(id, prefix) {
	for (let n = 0; n < 64; n++) {
		const a = (api.getInConnectedAttributes(id) || []).filter((x) => x === prefix || x.indexOf(prefix + '.') === 0)
		if (!a.length) return
		api.disconnectInput(id, a[0])
	}
}

export function discardSubMeshMeasurement(state) {
	if (state) cleanup(state)
}

function cleanup(state) {
	// A deep duplicate can clone its upstream graph into a NEW sibling comp, so
	// the probe's leftovers are every comp and layer that did not exist before.
	const comps = new Set(state.compsBefore)
	const layers = new Set(state.layersBefore)
	for (const c of api.getComps()) if (!comps.has(c)) { try { api.deleteLayer(c) } catch (e) {} }
	for (const id of api.getAllSceneLayers()) if (!layers.has(id) && api.layerExists(id)) { try { api.deleteLayer(id) } catch (e) {} }
}

// Execution 1: build the probe. Returns the state collectSubMeshMeasurement
// needs, or null when nothing is measured. `only` overrides the target list.
export function prepareSubMeshMeasurement(comp, only) {
	const targets = only || subMeshMeasureTargets(comp)
	if (!targets.length) return null
	const range = 2
	const state = { comp, targets: [], compsBefore: api.getComps(), layersBefore: api.getAllSceneLayers() }
	try {
		const probe = api.createComp(PROBE_NAME)
		api.set(probe, {
			resolution: api.get(comp, 'resolution'),
			fps: api.get(comp, 'fps'),
			startFrame: 0,
			endFrame: range,
			playbackStart: 0,
			playbackEnd: range,
		})
		state.probe = probe
		targets.forEach((t, i) => {
			const name = PROBE_NAME + '-' + i
			const copy = api.duplicate(t.host, true)
			api.parent(copy, probe)
			api.rename(copy, name)
			// The sampler is the only input; deformers could scale it.
			disconnectAll(copy, 'shapes')
			disconnectAll(copy, 'deformers')
			disconnectAll(copy, 'shapeTimeOffset')
			const rect = api.primitive('rectangle', name + '-sampler')
			api.parent(rect, probe) // never into the duplicator: that breaks its bake
			api.set(rect, { 'generator.dimensions.y': 2, hidden: true })
			api.keyframe(rect, 0, { 'generator.dimensions.x': 0 })
			api.keyframe(rect, range, { 'generator.dimensions.x': 100 * range })
			api.connect(rect, 'id', copy, 'shapes')
			const scale = api.create('math', name + '-scale')
			api.parent(scale, probe)
			api.set(scale, { operation: 2, second: SCALE })
			const shift = api.create('math', name + '-shift')
			api.parent(shift, probe)
			api.set(shift, { operation: 0, second: SHIFT })
			api.connect(t.node, 'id', scale, 'first')
			api.connect(scale, 'id', shift, 'first')
			api.connect(shift, 'id', copy, 'shapeTimeOffset')
			state.targets.push(Object.assign({ name }, t, { frames: t.frames || [0] }))
		})
	} catch (e) {
		cleanup(state)
		throw e
	}
	return state
}

const spanX = (v) => {
	let lo = Infinity, hi = -Infinity
	for (const p of v) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0] }
	return hi - lo
}

// One baked probe layer -> [{ c: [x, y], v, clamped }] in bake order: c the
// copy's centre, v the value it encodes at probe frame 0.
export function decodeProbeLayer(layer) {
	const outer = layer && layer.shapes && layer.shapes[0]
	if (!outer || outer.ty !== 'gr') return null
	const out = []
	for (const g of outer.it || []) {
		if (g.ty !== 'gr') continue
		const sh = (g.it || []).find((it) => it.ty === 'sh')
		if (!sh || !sh.ks) return null
		const ks = sh.ks
		const key = ks.a === 1 ? (ks.k.find((k) => k.t === 0) || ks.k[0]) : null
		const v = key ? key.s && key.s[0] && key.s[0].v : ks.k && ks.k.v
		if (!v || !v.length) return null
		const s = spanX(v) / 100 // sample time at frame 0: SHIFT ± 0.5
		let x = 0, y = 0
		for (const p of v) { x += p[0]; y += p[1] }
		out.push({ c: [x / v.length, y / v.length], v: (s - SHIFT) / SCALE, clamped: s < 0.0005 || s > 0.9995 })
	}
	return out.length ? out : null
}

// Execution 2: bake the probe and decode it. Returns
// { values: { [sm]: { [attr]: { kind, node, frames, copies } } }, notes, stale }
// and always removes the probe. stale means the bake was read before Cavalry
// re-evaluated the sampler, so a rebuilt probe is worth one more try.
export function collectSubMeshMeasurement(state) {
	const result = { values: {}, notes: [] }
	if (!state) return result
	const frame = api.getFrame()
	try {
		// One bake per playhead frame any target needs.
		const want = []
		for (const t of state.targets) for (const f of t.frames) if (want.indexOf(f) < 0) want.push(f)
		const reads = {} // frame -> { [target name]: copies }
		for (const f of want) {
			api.setActiveComp(state.comp)
			api.setFrame(f)
			const bake = rawBake(state.probe)
			reads[f] = {}
			for (const t of state.targets) {
				if (t.frames.indexOf(f) < 0) continue
				reads[f][t.name] = decodeProbeLayer((bake.layers || []).find((L) => L.ty === 4 && L.nm === t.name))
			}
		}
		for (const t of state.targets) {
			const label = api.getNiceName(t.sm) + ' ' + t.attr
			const per = t.frames.map((f) => reads[f][t.name])
			if (per.some((c) => !c) || per.some((c) => c.length !== per[0].length)) {
				result.notes.push('Could not measure ' + label + '; its copies stay visible')
				continue
			}
			// Every copy at the shift is the signature of a bake taken before
			// Cavalry re-evaluated the sampler.
			if (per.every((cs) => cs.every((c) => Math.abs(c.v) < 1e-6))) {
				result.stale = true
				result.notes.push('Measuring ' + label + ' returned no per-copy values; its copies stay visible')
				continue
			}
			if (per.some((cs) => cs.some((c) => c.clamped))) {
				result.notes.push('Measuring ' + label + ': values outside ±125 cannot be read; its copies stay visible')
				continue
			}
			// The probe bakes copies in the same order every time; vs lines up
			// each copy's reads across the frames.
			const copies = per[0].map((c, i) => ({ c: c.c, v: c.v, vs: per.map((cs) => cs[i].v) }))
			if (!result.values[t.sm]) result.values[t.sm] = {}
			result.values[t.sm][t.attr] = { kind: t.kind, node: t.node, frames: t.frames, copies }
		}
	} finally {
		cleanup(state)
		try { api.setActiveComp(state.comp); api.setFrame(frame) } catch (e) {}
	}
	return result
}
