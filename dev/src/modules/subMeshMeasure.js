// Measure a subMesh driver's per-copy values inside Cavalry.
//
// A seeded Random (or anything downstream of one, such as a Value with falloffs)
// has per-copy values only Cavalry can compute: api.get always evaluates at the
// default dynamic index, and cavalry.random does not reproduce a node's stream.
// The one per-copy channel the Lottie writer keeps is TIME: a duplicator's
// shapeTimeOffset shifts when each copy samples its input shape. So the node
// that drives the subMesh attribute is routed into the time offset of a mirror
// duplicator, in a throwaway comp, whose only input is a rectangle with a
// linear width ramp. Each baked copy's width then encodes the node's value for
// that copy at that frame:
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

import { compLayers, subMeshHosts, driverUsesLayerSeed, oscillatorConfig } from './cavalryExport.js'
import { findImageFillShapes, assetArrayOf } from './imageBake.js'
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
// `shift` is the comp's time-base shift: authored labels are read at label - shift.
export function measureTarget(sm, attr, comp, shift) {
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
	// A seeded value driver (Random, Noise) re-rolls each copy every time its
	// seed crosses an integer, so its per-copy value is piecewise-constant over
	// time. Detect an animating seed and hand back the crossing frames so the
	// value can be reproduced with hold keys, instead of baking a single frame.
	const f0 = Number(api.get(comp, 'startFrame')) || 0
	const f1 = Number(api.get(comp, 'endFrame')) || f0
	if (type === 'random' || type === 'noise') {
		let seedDriven = ''
		let seedKeys = []
		try { seedDriven = String(api.getInConnection(conn, 'seed') || '').split('.')[0] } catch (e) {}
		try { seedKeys = api.getKeyframeTimes(conn, 'seed') || [] } catch (e) {}
		if (seedDriven || seedKeys.length) {
			const crosses = IntegerCrossings(conn, 'seed', f0 - (shift || 0), f1 - (shift || 0))
			return { kind: 'value', node: conn, frames: crosses.length ? [f0].concat(crosses) : [f0] }
		}
	}
	// Anything else can still change over time: the value-blend rig driving the
	// mango grid reads 279 visible copies at frame 0 and 217 from frame 240 on,
	// with no keyframe on the valueBlend itself — the change comes from further
	// up the chain. So sample evenly across the range, plus the ends.
	return { kind: 'value', node: conn, frames: chainSampleFrames(conn, f0, f1, shift || 0) }
}

// A cap on how many frames one target is sampled at. Each sample is a whole
// probe bake, and the values land as hold keys anyway, so more than a couple of
// dozen samples buys nothing.
const MAX_SAMPLES = 24

// Frames worth sampling for a driver that may animate. Not derivable from
// keyframes: the mango grid's value-blend rig has no keyframe on the valueBlend
// and still flips 279 visible copies to 217 at frame 240, because the change
// comes from an upstream node's evaluation rather than its own curve. So sample
// evenly across the range, and add every keyframe time in the upstream chain so
// a snap on an exact frame is not straddled.
function chainSampleFrames(conn, f0, f1, shift) {
	const seen = { [f0]: 1 }
	const times = [f0]
	const span = Math.max(0, f1 - f0)
	if (span <= 0) return times
	const stride = Math.max(1, Math.ceil(span / (MAX_SAMPLES - 1)))
	for (let t = f0; t <= f1; t += stride) if (!seen[t]) { seen[t] = 1; times.push(t) }
	if (!seen[f1]) times.push(f1)
	if (typeof api.getAttributes !== 'function') return times
	const stack = [conn]
	const visited = {}
	while (stack.length) {
		const id = stack.pop()
		if (!id || visited[id]) continue
		visited[id] = 1
		;(api.getAttributes(id) || []).forEach((attr) => {
			let kt = []
			try { kt = api.getKeyframeTimes(id, attr) || [] } catch (e) { kt = [] }
			// keyframe times are authored labels; sample them in read space
			kt.forEach((t) => { if (typeof t === 'number') { const r = t - shift; if (r > f0 && r < f1 && !seen[r]) { seen[r] = 1; times.push(r) } } })
			let src = ''
			try { src = String(api.getInConnection(id, attr) || '').split('.')[0] } catch (e) { src = '' }
			if (src && src !== id) stack.push(src)
		})
	}
	times.sort((a, b) => a - b)
	return times
}

// Frames f0..f1 (inclusive) where an attribute's floor value just changed —
// the instants a seeded Random re-rolls. Cheap: reads the scalar, not a bake.
function IntegerCrossings(id, attr, f0, f1) {
	const out = []
	let prev = null
	for (let f = f0; f <= f1; f++) {
		api.setFrame(f)
		let s
		try { s = typeof api.get(id, attr) === 'number' ? Math.floor(api.get(id, attr)) : null } catch (e) { s = null }
		if (prev !== null && s !== null && s !== prev) out.push(f)
		prev = s
	}
	return out
}

// Every subMesh attribute in the comp that needs a measurement, plus any
// assetArray-driven imageShader's `arrayIndex` and host `shapeId` drivers.
//
// The comp a user exports is often a shell: the rig sits inside the comps its
// compositionReference layers point at. compLayers() stops at a reference (its
// children are the reference itself, not the inner comp), so the walk descends
// through each reference into the comp it points at. Frame sampling still uses
// the EXPORTED comp's range, because that is the timeline the export covers.
export function subMeshMeasureTargets(comp) {
	const out = []
	const own = {}
	const shift = Number(api.get(comp, 'startFrame')) || 0
	const f0 = Number(api.get(comp, 'startFrame')) || 0
	const f1 = Number(api.get(comp, 'endFrame')) || f0
	const p0 = Number(api.get(comp, 'playbackStart'))
	const p1 = Number(api.get(comp, 'playbackEnd'))
	const sampleF0 = isFinite(p0) ? p0 : f0
	const sampleF1 = isFinite(p1) && p1 >= sampleF0 ? p1 : f1
	deepSubMeshes(comp, own).forEach((hit) => {
		const hosts = subMeshHosts(hit.sm, hit.comp)
		if (!hosts.length) return
		;['shapeVisibility', 'shapeOpacity'].forEach((attr) => {
			const t = measureTarget(hit.sm, attr, comp, shift)
			// evalComp is the comp the driver chain lives in: a rig inside a
			// referenced comp only evaluates against ITS comp, so the frame has to
			// be set there, not on the shell comp the user exports.
			if (t) {
				hosts.forEach((host) => {
					out.push(Object.assign({ sm: hit.sm, attr, host, evalComp: hit.comp }, t))
				})
			}
		})
	})
	// Multi-image assetArray fills: measure `assetArray.arrayIndex` (which image
	// each copy shows) and `duplicator.shapeId` (which copies show the image-
	// filled shape at each frame). Restore the playhead after IntegerCrossings.
	const savedFrame = typeof api.getFrame === 'function' ? api.getFrame() : null
	const seenNodeAttr = {}
	const addDriverTarget = (ownerId, attr, host, evalComp, allowLayerSeed) => {
		const key = ownerId + ':' + attr + ':' + host
		if (seenNodeAttr[key]) return
		const conn = srcOf(ownerId, attr)
		if (!conn) return
		if (!allowLayerSeed && driverUsesLayerSeed(ownerId, attr)) return
		const type = api.getLayerType(conn)
		let frames = [sampleF0]
		if (type === 'random' || type === 'noise') {
			let seedDriven = ''
			let seedKeys = []
			let timeOffDriven = ''
			try { seedDriven = String(api.getInConnection(conn, 'seed') || '').split('.')[0] } catch (e) {}
			try { seedKeys = api.getKeyframeTimes(conn, 'seed') || [] } catch (e) {}
			try { timeOffDriven = String(api.getInConnection(conn, 'timeOffset') || '').split('.')[0] } catch (e) {}
			if (seedDriven || seedKeys.length) {
				const crosses = IntegerCrossings(conn, 'seed', sampleF0 - shift, sampleF1 - shift)
				const all = crosses.length ? [sampleF0].concat(crosses) : [sampleF0]
				if (all.length > MAX_SAMPLES) {
					const picked = [all[0]]
					for (let k = 1; k < MAX_SAMPLES - 1; k++) {
						const idx = Math.round((k * (all.length - 1)) / (MAX_SAMPLES - 1))
						if (picked[picked.length - 1] !== all[idx]) picked.push(all[idx])
					}
					if (picked[picked.length - 1] !== all[all.length - 1]) picked.push(all[all.length - 1])
					frames = picked
				} else {
					frames = all
				}
			} else if (timeOffDriven) {
				frames = chainSampleFrames(conn, sampleF0, sampleF1, shift)
			}
		} else {
			frames = chainSampleFrames(conn, sampleF0, sampleF1, shift)
		}
		seenNodeAttr[key] = 1
		out.push({ sm: ownerId, attr, host, evalComp, kind: 'value', node: conn, frames })
	}
	try {
		findImageFillShapes(comp).forEach((hit) => {
			const arr = assetArrayOf(hit.shader)
			if (!arr) return
			// Measure `arrayIndex` even when `useLayerAsSeed` is true: the probe
			// mirrors the host duplicator and produces a stable per-copy index.
			addDriverTarget(arr.node, 'arrayIndex', hit.host, hit.comp, true)
			addDriverTarget(hit.host, 'shapeId', hit.host, hit.comp, false)
		})
	} catch (e) {
	} finally {
		if (savedFrame !== null && typeof api.setFrame === 'function') {
			try { api.setFrame(savedFrame) } catch (e) {}
		}
	}
	return out
}

// Sub-meshes reachable from a comp, each paired with the comp that OWNS it (the
// comp its host duplicator lives in), following composition references.
function deepSubMeshes(comp, seen) {
	const out = []
	if (!comp || seen[comp]) return out
	seen[comp] = 1
	compLayers(comp).forEach((id) => {
		const ty = api.getLayerType(id)
		if (ty === 'subMesh') {
			out.push({ sm: id, comp })
			return
		}
		if (ty !== 'compositionReference') return
		let inner = ''
		try { inner = String(api.getInConnection(id, 'composition') || '').replace(/\.id$/, '') } catch (e) { inner = '' }
		if (inner) out.push.apply(out, deepSubMeshes(inner, seen))
	})
	return out
}

export function needsSubMeshMeasurement(comp) {
	return subMeshMeasureTargets(comp).length > 0
}

export function discardSubMeshMeasurement(state) {
	if (state) cleanup(state)
}

function cleanup(state) {
	// A deep duplicate can clone its upstream graph into a NEW sibling comp, so
	// the probe's leftovers are every comp and layer that did not exist before.
	// The snapshots MUST be real arrays: a malformed state (compsBefore/layersBefore
	// missing or not an array) would make every exclusion set empty and delete the
	// user's own layers. Refuse to touch anything rather than risk that.
	const compsBefore = state && state.compsBefore
	const layersBefore = state && state.layersBefore
	if (!Array.isArray(compsBefore) || !Array.isArray(layersBefore)) {
		console.warn('[subMeshMeasure] cleanup skipped: state snapshots missing/invalid; nothing deleted')
		return
	}
	const comps = new Set(compsBefore)
	const layers = new Set(layersBefore)
	// Deleting the comp that is currently ACTIVE crashes Cavalry, and the probe
	// comp can easily be the active one when a previous run left it selected.
	// Park the active comp on a survivor before removing anything.
	const doomedComps = api.getComps().filter((c) => !comps.has(c))
	const active = api.getActiveComp()
	if (doomedComps.indexOf(active) >= 0) {
		const survivors = api.getComps().filter((c) => comps.has(c))
		const park = state.comp && survivors.indexOf(state.comp) >= 0 ? state.comp : survivors[0]
		if (park) { try { api.setActiveComp(park) } catch (e) {} }
		else {
			console.warn('[subMeshMeasure] cleanup skipped: no surviving comp to park the active comp on')
			return
		}
	}
	for (const c of doomedComps) { try { api.deleteLayer(c) } catch (e) {} }
	for (const id of api.getAllSceneLayers()) if (!layers.has(id) && api.layerExists(id)) { try { api.deleteLayer(id) } catch (e) {} }
}

// Execution 1: build the probe. Returns the state collectSubMeshMeasurement
// needs, or null when nothing is measured. `only` overrides the target list.
// A duplicator that produces copies, set up to behave like `host` but with no
// input of its own. A DUPLICATE of a duplicator bakes NOTHING through the
// Lottie writer (measured: a duplicate of duplicator#24 exports no shape layer
// at all, while a fresh duplicator with the same generator attributes exports
// all 280 copy groups), so the probe builds a fresh one and copies the
// generator config across.
const GENERATOR_ATTRS = [
	'generator.count',
	'generator.size',
	'generator.offset',
	'generator.direction',
	'generator.distributionMode',
	'useIndex',
	'indexContext',
	'position',
	'rotation',
	'scale',
]

function mirrorHost(host, probe, name) {
	const copy = api.create('duplicator', name)
	api.parent(copy, probe)
	// Match wrapped generator stacks (e.g. sortDistribution wrapping gridDistribution
	// on generator.input) before copying attributes.
	if (typeof api.getCurrentGeneratorType === 'function' && typeof api.setGenerator === 'function') {
		;['generator', 'generator.input'].forEach((slot) => {
			if (!api.hasAttribute(host, slot) || !api.hasAttribute(copy, slot)) return
			let genType = ''
			try { genType = api.getCurrentGeneratorType(host, slot) || '' } catch (e) {}
			if (genType) { try { api.setGenerator(copy, slot, genType) } catch (e) {} }
		})
	}
	const attrs = typeof api.getAttributes === 'function'
		? (api.getAttributes(host) || []).filter((a) => a.indexOf('generator.') === 0 || a === 'useIndex' || a === 'indexContext' || a === 'position' || a === 'rotation' || a === 'scale')
		: GENERATOR_ATTRS
	attrs.forEach((a) => {
		if (!api.hasAttribute(host, a) || !api.hasAttribute(copy, a)) return
		let v
		try { v = api.get(host, a) } catch (e) { return }
		if (v === null || v === undefined) return
		try { api.set(copy, { [a]: v }) } catch (e) {}
	})
	return copy
}

export function prepareSubMeshMeasurement(comp, only) {
	const targets = only || subMeshMeasureTargets(comp)
	if (!targets.length) return null
	const range = 2
	const state = { comp, shift: Number(api.get(comp, 'startFrame')) || 0, targets: [], compsBefore: api.getComps(), layersBefore: api.getAllSceneLayers() }
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
			const copy = mirrorHost(t.host, probe, name)
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
	// The target frames are authored labels; the eval comp reads them at label - shift.
	const shift = Number(state.shift) || 0
	try {
		// One bake per playhead frame any target needs.
		const want = []
		for (const t of state.targets) for (const f of t.frames) if (want.indexOf(f) < 0) want.push(f)
		const reads = {} // frame -> { [target name]: copies }
		for (const f of want) {
			// Two frames are in play. The driver chain has to be evaluated at the
			// export's frame f, but the sampler ramp lives in the probe's own 0..2
			// range, so the probe always bakes at frame 0. Reading a copy's rect
			// at probe frame 0 still yields its encoded value, because
			// shapeTimeOffset shifts the time the copy samples the ramp. Measured
			// across f0/120/240/360/460 this returns 18/18 copies shown at f0 and
			// 18/0 at f240, so the chain really resolves at f and is not frozen.
			// The rig may live in a referenced comp, which only evaluates while
			// that comp is active, so every comp holding a target is stepped.
			const comps = []
			for (const t of state.targets) {
				if (t.frames.indexOf(f) < 0) continue
				const c = t.evalComp || state.comp
				if (comps.indexOf(c) < 0) comps.push(c)
			}
			for (const c of comps) {
				api.setActiveComp(c)
				api.setFrame(f - shift)
			}
			api.setActiveComp(state.probe)
			api.setFrame(0)
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
			const entry = { kind: t.kind, node: t.node, frames: t.frames, copies }
			if (!result.values[t.sm]) result.values[t.sm] = {}
			result.values[t.sm][t.attr] = entry
			if (t.host) {
				const hk = t.host + ':' + t.sm
				if (!result.values[hk]) result.values[hk] = {}
				result.values[hk][t.attr] = entry
			}
		}
	} finally {
		cleanup(state)
		try { api.setActiveComp(state.comp); api.setFrame(frame) } catch (e) {}
	}
	return result
}
