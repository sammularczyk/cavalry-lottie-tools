// Export duplicators whose input shapes are composition references.
//
// Cavalry's Lottie writer inlines each duplicator copy as a baked shape group and,
// when the input shape is a composition reference, the fill/animation of the
// referenced comp is lost (the copies come out as unfilled paths). This pass finds
// such duplicators, exports the referenced comp once as a precomp asset (via the
// regular precomp build) and replaces the baked layer with one precomp layer per
// copy: positioned at the distribution's points, timed from the duplicator's
// shapeTimeOffset (st, in frames, the convention the Cavalry writer and Cavalry
// files use and that players already accept from Cavalry exports).
//
// Copy positions come from a sampler bake, which works for EVERY distribution
// type (linear, grid, fibonacci, circle, ... and animated ones): at export time
// the duplicator's input shapes are swapped out for a tiny rectangle, the parent
// comp is rendered once, and each baked copy's rectangle path centre is the
// distribution point for that copy (per frame, when the distribution moves).
// The swap is undone before the exporter returns. A duplicator with several
// input shapes places ONE input per point (cycled), so swapping all of them for
// the rectangle is safe: the rectangle only ever exists inside the throwaway
// bake, and each baked group's content corresponds to shapes[i % numShapes].

import { compLayers, inputSources } from './cavalryExport.js'

const compOf = (ref) => String(api.getInConnection(ref, 'composition') || '').replace(/\.id$/, '')

// --- timing -----------------------------------------------------------------
// Empirical law, verified against Cavalry's own writer bakes (linear 3x1 and
// 5x1, grids 3x3 and 5x1, static and stagger-driven offsets, mixed inputs): a
// composition reference inside a duplicator samples the referenced comp at
// TWICE the nominal per-copy offset, while plain shape inputs sample at 1x.
// (Likely an internal seconds/frames round-trip; whatever the cause, the bakes
// are unambiguous — a static shapeTimeOffset of 15 samples at +30.) The
// nominal value is the duplicator's shapeTimeOffset: its static value, or,
// when a stagger drives it (the stagger overrides the static value), the
// ladder min + (max−min)·graph(i/(count−1))·strength/100 + offset. The ladder
// index runs along the distribution's index order (i = 0 at the axis start:
// left/bottom; grids row-major bottom-first), and the writer's bake emits the
// copies in REVERSE index order, so the offsets are reversed here to match the
// baked copy order the sampler bake hands us.
const COMP_REF_TIME_SCALE = 2

// --- the sampler bake -------------------------------------------------------
// One raw render of the parent comp with the sampler rectangle in the
// duplicator's shapes slot; every copy group's rectangle path centre is a
// distribution point (Lottie space, y-down, the duplicator's shape* attributes
// already baked into the path coordinates).

// Reuse one temp folder across bakes instead of minting a new one per render,
// and delete the rendered json as soon as it is parsed. Date.now() in the name
// left 39 orphaned dcr-sampler-* folders in the temp dir.
export function rawBake(compId) {
	const dir = api.getTempFolder() + '/dcr-sampler'
	if (!api.isDirectory(dir)) api.makeFolder(dir)
	// a stale export from a crashed run must not be mistaken for this render
	try { if (api.filePathExists(dir + '/export.json')) api.deleteFilePath(dir + '/export.json') } catch (e) {}
	const rq = api.addRenderQueueItem(compId)
	try {
		api.setGenerator(rq, 'generator', 'renderLottie')
		api.set(rq, { filePath: dir, fileName: 'export', frameRangeMode: 0 })
		// The duplicator's per-copy evaluation (index broadcast → stagger →
		// shapeTimeOffset) only works while the comp is the ACTIVE comp; without
		// this every copy evaluates at index 0 and the bake collapses to a
		// uniform offset (seen as a uniform min value across all copies).
		api.setActiveComp(compId)
		api.render(rq)
	} finally {
		api.deleteLayer(rq)
	}
	const file = dir + '/export.json'
	const json = JSON.parse(api.readFromFile(file))
	try { api.deleteFilePath(file) } catch (e) {}
	return json
}

// Remove every current input from the duplicator's shapes slot. Disconnecting
// 'shapes.0' repeatedly works because the list recompacts after each removal.
// The list is enumerated from the serialised scene graph rather than by probing
// slot indices: getInConnection on an index past the last entry logs
// "Couldn't find attribute with path: <dup>.shapes.N", which is the console
// spam this pass used to produce on every export.
function clearShapes(dup) {
	for (const src of inputSources(dup) || []) {
		try { api.disconnect(src, 'id', dup, 'shapes.0') } catch (e) { break }
	}
}

// The centre of a path value at one keyframe (mean of its vertices).
function pathCentre(v) {
	let x = 0, y = 0
	for (const p of v) { x += p[0]; y += p[1] }
	return [x / v.length, y / v.length]
}


// Per-copy path centres from a sampler bake: one frame series per copy, in the
// bake's copy order — [{ t, c: [x, y] }, ...]
function samplerSeries(bake, dup, ids) {
	const layer = (bake.layers || []).find((L) => L.ty === 4 && sceneId(L.mn, ids) === dup)
	if (!layer || !layer.shapes || !layer.shapes.length) return null
	return copySeries(layer)
}

// Per-copy path series from a baked duplicator layer (one outer group with a
// child group per copy): the first shape of each copy, as [{ t, c: [x, y] }].
function copySeries(layer) {
	const outer = layer.shapes && layer.shapes[0]
	if (!outer || outer.ty !== 'gr') return null
	const groups = outer.it.filter((it) => it.ty === 'gr')
	if (groups.length < 2) return null

	const series = []
	for (const g of groups) {
		const sh = (g.it || []).filter((it) => it.ty === 'sh')[0]
		if (!sh || !sh.ks) return null
		const ks = sh.ks
		const frames = []
		if (ks.a === 1 && Array.isArray(ks.k)) {
			for (const kf of ks.k) {
				if (!kf.s || !kf.s[0] || !kf.s[0].v) return null
				frames.push({ t: kf.t, c: pathCentre(kf.s[0].v) })
			}
		} else if (ks.k && ks.k.v) {
			frames.push({ t: 0, c: pathCentre(ks.k.v) })
		} else return null
		if (!frames.length) return null
		series.push(frames)
	}
	return series
}

// Collapse per-frame series into the position format for the precomp layers:
// static { a:0, k:[x,y,0] } or per-frame split keys { s:true, x, y }.
function seriesToPoints(series) {
	const moving = series.some((frames) => frames.some((f) =>
		Math.abs(f.c[0] - frames[0].c[0]) > 0.01 || Math.abs(f.c[1] - frames[0].c[1]) > 0.01))
	if (!moving) {
		return { moving: false, points: series.map((frames) => ({ a: 0, k: [frames[0].c[0], frames[0].c[1], 0] })) }
	}
	const key = (t, v) => ({ t, s: [v], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } })
	return {
		moving: true,
		points: series.map((frames) => ({
			s: true,
			x: { a: 1, k: frames.map((f) => key(f.t, f.c[0])) },
			y: { a: 1, k: frames.map((f) => key(f.t, f.c[1])) },
		})),
	}
}

// The timing signal comes from a SECOND sampler bake in which the rectangle is
// nested inside a group and its position.x is keyframed to the frame number
// (0 → lastFrame). The writer ignores a top-level input shape's own transform
// animation, but animation on shapes nested inside a group input survives the
// bake — each copy's rectangle then bakes as x(t) = sample(t) + point_x(i),
// where sample(t) is the time the duplicator samples that copy at, already
// clamped to the referenced comp's frame range (holds included). Comparing the
// two bakes cancels the rectangle's geometry offset and the distribution point:
//
//   sample_i(t) = xB_i(t) − xA_i(t).x − t
//
// which is the per-copy time offset measured, not modelled — stagger, static
// shapeTimeOffset, driven drivers and animated distributions all just work.
// A constant sample time becomes the copy's Lottie st (frames, negated); a
// varying one becomes a per-frame time remap (tm, seconds).

// Per-copy sample times (frames): the nominal offsets reversed into the bake's
// copy order (the writer emits copies in reverse distribution-index order).
function sampleTimes(seriesA, nominal) {
	if (!nominal) return null
	return { constant: nominal.slice().reverse() }
}

// --- timing measurement in a throwaway comp ---------------------------------
// A driver that is not a stagger (random, noise, ...) cannot be decoded: its
// per-index values live inside the driver and the duplicator gives its inputs
// no index context to read them with. They CAN be measured. A rectangle whose
// width is keyframed 0→100 across the comp's range, used as the duplicator's
// input, bakes each copy at that copy's sample time, and each copy's path
// centre at frame 0 is that copy's distribution point.
//
// A freshly keyframed sampler only reaches such a bake when the render happens
// in a LATER script execution. Cavalry evaluates a duplicator's per-copy input
// at a scene boundary no single script can force: double renders, awaits and
// render-queue setup scripts all bake it frozen, and every one reads back as a
// uniform all-zero offset. So the measurement spans two Export clicks.
//
// The measurement runs entirely in a THROWAWAY comp holding deep duplicates of
// the duplicators. It never touches the user's own layers, so neither click can
// leave the scene broken — the only visible trace is one scratch comp that is
// deleted once the measurement is read. Deep duplicates were verified to
// reproduce the original exactly: the duplicated driver keeps every setting
// (minimum, maximum, seed, strength, index mode) and two independent duplicates
// of the same duplicator measure identical offsets.

const timingMarkerFile = () => api.getTempFolder() + '/lottie-optimiser-timing.json'

// Duplicators whose timing cannot be decoded analytically: a comp reference
// inside and a shapeTimeOffset driven by something other than a stagger.
function compRefDuplicators(comp) {
	const out = []
	for (const dup of compLayers(comp).filter((id) => api.getLayerType(id) === 'duplicator')) {
		const sources = inputSources(dup)
		if (!sources || !sources.length) continue
		if (!sources.some((s) => api.getLayerType(s) === 'compositionReference')) continue
		let raw = null
		try { raw = api.getInConnection(dup, 'shapeTimeOffset') } catch (e) { raw = null }
		if (raw == null || raw === '') continue // static: decoded analytically
		const driver = String(raw).replace(/\.id$/, '')
		let type = ''
		try { type = api.getLayerType(driver) } catch (e) { type = '' }
		if (type === 'stagger') continue // decoded analytically
		out.push({ dup, sources })
	}
	return out
}

export function needsTimingMeasurement(comp) {
	try { return compRefDuplicators(comp).length > 0 } catch (e) { return false }
}

// Every layer id in the scene, so a cleanup can find the orphans that deleting a
// comp leaves behind (deleting a comp does not remove everything created inside
// it; the remainder becomes parentless scene debris).
function sceneLayerIds() {
	try { return api.getAllSceneLayers().slice() } catch (e) { return null }
}

// Remove exactly the layers the measurement created. `created` is the ledger the
// prepare step recorded, so this never touches anything else in the scene — a
// "everything that appeared since click 1" sweep would also delete layers the
// user added between the two clicks.
function cleanupProbe(created) {
	for (const id of created || []) {
		try { if (api.layerExists(id)) api.deleteLayer(id) } catch (e) {}
	}
}

// The layers that exist now but did not before — the measurement's own debris.
function newLayersSince(before) {
	if (!before) return []
	const keep = new Set(before)
	try { return api.getAllSceneLayers().filter((id) => !keep.has(id)) } catch (e) { return [] }
}

// Put the user's comp and frame back after a measurement. Rendering makes the
// probe comp active, and the probe is deleted straight after, so anything that
// reads the active comp later (the export capturing what to restore) would
// otherwise see a comp that no longer exists. The frame is set first: setting
// it can itself move the playhead of whatever comp is open.
function restoreActive(compId, frame) {
	if (compId) {
		try { if (api.layerExists(compId)) api.setActiveComp(compId) } catch (e) {}
	}
	if (frame != null) {
		try { api.setFrame(frame) } catch (e) {}
	}
}

// A marker is only usable when every id it names still exists AND the sampler
// still carries its two keyframes. A stale marker (scene reopened, edited, or
// the probe half-deleted) must trigger a fresh measurement rather than a throw.
// `comp` scopes it further: a measurement set up for one comp must never be
// spent on another.
export function readProbeState(comp) {
	let state = null
	try {
		const file = timingMarkerFile()
		if (!api.filePathExists(file)) return null
		state = JSON.parse(api.readFromFile(file))
	} catch (e) { return null }
	if (!state || !state.comp || !Array.isArray(state.probes) || !state.probes.length) return null
	if (!api.layerExists(state.comp)) return null
	if (comp && state.comp !== comp) return null
	for (const p of state.probes) {
		if (!p || !p.dup || !api.layerExists(p.dup)) return null
		if (!p.rect || !api.layerExists(p.rect)) return null
		let keys = 0
		try { keys = api.getKeyframeIdsForAttribute(p.rect, 'generator.dimensions.x').length } catch (e) { keys = 0 }
		if (keys !== 2) return null
	}
	return state
}

// True when a measurement set up by an earlier click is ready to be read.
export function timingMeasurementPending(comp) {
	return readProbeState(comp) != null
}

// Drop a pending measurement without using it: the probe comp, its samplers and
// the marker all go. Safe to call when nothing is pending.
export function discardTimingMeasurement() {
	// read the marker even when it no longer validates: it still names the debris
	let raw = null
	try { raw = api.filePathExists(timingMarkerFile()) ? JSON.parse(api.readFromFile(timingMarkerFile())) : null } catch (e) { raw = null }
	if (raw && (raw.created || raw.probeComp)) cleanupProbe(raw.created || [raw.probeComp])
	try { api.deleteFilePath(timingMarkerFile()) } catch (e) {}
}

// Click 1: build the throwaway measurement comp. The user's comp and its
// duplicators are only READ here — nothing is connected, cleared or reparented.
export function prepareTimingMeasurement(comp) {
	const cfg = {}
	for (const a of ['resolution', 'fps', 'startFrame', 'endFrame', 'playbackStart', 'playbackEnd']) {
		try { cfg[a] = api.get(comp, a) } catch (e) {}
	}
	const start = Number(cfg.startFrame) || 0
	const last = (Number(cfg.endFrame) || start) - start
	const before = sceneLayerIds()
	let probeComp = null
	const probes = []
	let created = []
	try {
		probeComp = api.createComp('dcr-probe')
		if (!probeComp || !api.layerExists(probeComp)) throw new Error('could not create the measurement comp')
		api.set(probeComp, cfg)
		api.setActiveComp(probeComp)
		for (const { dup } of compRefDuplicators(comp)) {
			const copy = api.duplicate(dup, true)
			if (!copy || !api.layerExists(copy)) throw new Error('could not duplicate ' + (api.getNiceName(dup) || dup))
			api.parent(copy, probeComp)
			// the sampler lives in the comp, never on the duplicator: parenting a
			// sampler into the duplicator breaks its bake entirely
			const rect = api.primitive('rectangle', 'dcr-probe-sampler')
			if (!rect || !api.layerExists(rect)) throw new Error('could not create the sampler shape')
			api.parent(rect, probeComp)
			api.set(rect, { 'generator.dimensions.x': 0, 'generator.dimensions.y': 2 })
			api.keyframe(rect, start, { 'generator.dimensions.x': 0 })
			api.keyframe(rect, start + last, { 'generator.dimensions.x': 100 })
			if (api.getKeyframeIdsForAttribute(rect, 'generator.dimensions.x').length !== 2) throw new Error('sampler keyframes missing')
			clearShapes(copy)
			api.connect(rect, 'id', copy, 'shapes')
			probes.push({ src: dup, dup: copy, rect })
		}
		if (!probes.length) throw new Error('no duplicator to measure')
		created = newLayersSince(before)
		api.writeToFile(timingMarkerFile(), JSON.stringify({ comp, probeComp, start, last, created, probes }), true)
	} catch (e) {
		cleanupProbe(created.length ? created : newLayersSince(before))
		try { api.deleteFilePath(timingMarkerFile()) } catch (err) {}
		throw e
	} finally {
		try { api.setActiveComp(comp) } catch (e) {}
	}
	return probes.length
}

// The x span of a path value at one keyframe (the baked rectangle's width).
function spanX(v) {
	let lo = Infinity, hi = -Infinity
	for (const p of v) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0] }
	return hi - lo
}

// Width series of one copy's first shape: [{ t, w }, ...]
export function widthSeries(ks) {
	const out = []
	if (ks.a === 1 && Array.isArray(ks.k)) {
		for (const kf of ks.k) {
			if (!kf.s || !kf.s[0] || !kf.s[0].v) return null
			out.push({ t: kf.t, w: spanX(kf.s[0].v) })
		}
	} else if (ks.k && ks.k.v) out.push({ t: 0, w: spanX(ks.k.v) })
	else return null
	return out.length ? out : null
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1] }

// One copy's sample-time offset from its baked width series: the rectangle is
// w(t) = clamp(t + off, 0, last) · 100/last, so interior frames give
// off = w·last/100 − t directly. When the sweep is clipped, only one edge
// survives: a copy sampled past the end is at full width on frame 0 (off ≥ last),
// one sampled before the start first rises at t = −off.
export function offsetFromWidth(ws, last) {
	const mid = ws.filter((f) => f.w > 0.5 && f.w < 99.5).map((f) => (f.w * last) / 100 - f.t)
	if (mid.length) return Math.round(median(mid) * 100) / 100
	if (!ws.length) return null
	// full width from the first frame means the whole sweep happened before frame 0
	if (ws[0].w > 99.5) return Math.round(last * 100) / 100
	const rise = ws.find((f) => f.w > 0.5)
	if (rise) return Math.round(-rise.t * 100) / 100
	return null
}

// Click 2: render the throwaway comp (its keyframed samplers survive across the
// script boundary), decode each duplicate's per-copy offsets, then delete the
// probe comp and every layer it created. Returns { comp, timing, points, notes }.
// timing maps ORIGINAL duplicator id → per-copy offsets in the bake's copy order
// at the 1x shape-input scale; points maps the same to per-copy path centres.
export function collectTimingMeasurement(comp) {
	const state = readProbeState(comp)
	// Rendering makes the probe comp active and the probe is deleted below, so the
	// comp Cavalry has open is put back before this returns. The export that
	// follows captures the active comp as the one to restore, and a deleted comp
	// cannot be reopened.
	const userFrame = api.getFrame()
	if (!state) {
		// no usable measurement: never throw out of here, and never leave a marker
		// behind that would send the next click down the same dead end
		restoreActive(comp, userFrame)
		try { api.deleteFilePath(timingMarkerFile()) } catch (e) {}
		return { comp: null, timing: {}, points: {}, notes: [] }
	}
	const notes = []
	const timing = {}
	const points = {}
	try {
		const bake = rawBake(state.probeComp)
		const ids = new Set(compLayers(state.probeComp))
		for (const e of state.probes) {
			const name = api.getNiceName(e.src) || e.src
			const layer = (bake.layers || []).find((L) => L.ty === 4 && sceneId(L.mn, ids) === e.dup)
			const outer = layer && layer.shapes && layer.shapes[0]
			const groups = outer && outer.ty === 'gr' ? outer.it.filter((it) => it.ty === 'gr') : []
			if (!groups.length) {
				notes.push('The timing of ' + name + ' could not be measured; its copies export without time offsets')
				continue
			}
			const offs = []
			const pts = []
			for (const g of groups) {
				const sh = (g.it || []).filter((it) => it.ty === 'sh')[0]
				const ws = sh && sh.ks ? widthSeries(sh.ks) : null
				const off = ws ? offsetFromWidth(ws, state.last) : null
				if (off == null) break
				offs.push(off)
				pts.push(sh && sh.ks ? pathCentreOf(sh.ks) : null)
			}
			// a real driver (stagger, random, keyed) nearly never lands every copy on
			// the same offset; all-zero is the signature of a bake that never saw the
			// sampler (a sampler created in the same run as the render does exactly
			// that) — refuse it rather than shipping silent copies
			if (offs.length === groups.length && offs.some((o) => o !== 0)) {
				timing[e.src] = offs
				if (pts.every(Boolean)) points[e.src] = pts
			} else {
				notes.push('The timing of ' + name + ' could not be measured; its copies export without time offsets')
			}
		}
		return { comp: state.comp, timing, points, notes }
	} finally {
		cleanupProbe(state.created || [state.probeComp])
		try { api.deleteFilePath(timingMarkerFile()) } catch (e) {}
		restoreActive(comp, userFrame)
	}
}

// The centre of a baked shape's path at its first keyframe.
export function pathCentreOf(ks) {
	let v = null
	if (ks.a === 1 && Array.isArray(ks.k) && ks.k.length) v = ks.k[0].s && ks.k[0].s[0] && ks.k[0].s[0].v
	else if (ks.k && ks.k.v) v = ks.k.v
	return v ? pathCentre(v) : null
}

// How many attempts a deferred measurement gets before it gives up and exports
// without offsets. A deferred render bakes correctly on the first try, so a
// second attempt only helps when the render landed before the panel went idle.
// Never retry more than once: a driver that really cannot be measured must not
// turn one Export click into a loop.
export const MAX_MEASUREMENT_ATTEMPTS = 2

export function shouldRetryMeasurement(measurement, attempt) {
	const timing = (measurement && measurement.timing) || {}
	const measured = Object.keys(timing).length > 0
	return !measured && attempt < MAX_MEASUREMENT_ATTEMPTS
}

// The nominal per-copy offset (frames, distribution index order) from the
// duplicator's shapeTimeOffset: its static value, or the ladder decoded from a
// connected stagger (the stagger overrides the static value). Animated or
// unknown drivers return null — a driver's per-index values cannot be read
// from the scene (the duplicator gives its inputs no index context).
function nominalOffsets(dup, count, warn, name) {
	let raw = null
	try { raw = api.getInConnection(dup, 'shapeTimeOffset') } catch (e) { raw = null }
	if (raw == null || raw === '') {
		const v = Number(api.get(dup, 'shapeTimeOffset')) || 0
		return new Array(count).fill(COMP_REF_TIME_SCALE * v)
	}
	const driver = String(raw).replace(/\.id$/, '')
	// Only a stagger can be decoded: other indexed behaviours (random, noise)
	// serialise with a graph attribute too, but their per-index values come from
	// a seed and cannot be read from the scene.
	let driverType = ''
	try { driverType = api.getLayerType(driver) } catch (e) { driverType = '' }
	if (driverType !== 'stagger') {
		warn('The time offset driver of ' + name + ' is not a stagger; its copies export without time offsets')
		return null
	}
	// serialise returns an array of JSON strings (chunks) that must be joined
	let nodes = null
	try { nodes = JSON.parse([].concat(api.serialise([driver], false)).join('')) } catch (e) { nodes = null }
	const attrs = nodes && nodes.nodes && nodes.nodes[0] && nodes.nodes[0].attributes
	if (!attrs || !attrs.graph) return null
	const sampler = graphSampler(attrs.graph)
	const min = Number(api.get(driver, 'minimum')), max = Number(api.get(driver, 'maximum'))
	if (isNaN(min) || isNaN(max)) return null
	const lo = Math.min(min, max), hi = Math.max(min, max)
	const strength = Number(api.get(driver, 'strength')) / 100
	const offset = Number(api.get(driver, 'offset')) || 0
	const ladder = []
	for (let i = 0; i < count; i++) {
		const g = count > 1 ? i / (count - 1) : 0
		ladder.push(COMP_REF_TIME_SCALE * ((lo + (hi - lo) * sampler(g)) * strength + offset))
	}
	return ladder
}

// Decode a serialised stagger graph into f(u) for u in [0, 1]: polyline through
// its points, the first point implicit at the origin when the serialisation
// omits it, clamped outside the graph's span.
function graphSampler(graphAttr) {
	const list = graphAttr && graphAttr.list || []
	const pts = list
		.map((p) => p.compound && p.compound.position && p.compound.position.value)
		.filter(Boolean)
		.map((v) => [v.x, v.y])
	if (!pts.length || pts[0][0] !== 0) pts.unshift([0, 0])
	pts.sort((a, b) => a[0] - b[0])
	return (u) => {
		if (u <= pts[0][0]) return pts[0][1]
		for (let i = 1; i < pts.length; i++) {
			if (u <= pts[i][0]) {
				const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
				const w = (x1 - x0) || 1
				return y0 + (y1 - y0) * (u - x0) / w
			}
		}
		return pts[pts.length - 1][1]
	}
}

// Swap the duplicator's input shapes for a tiny rectangle and render the parent
// comp once; each baked copy's rectangle path centre is a distribution point.
function sampleDistribution(comp, dup, sources, ids, warn, name) {
	// api.primitive only accepts a string name; the object-literal overload crashes
	const rect = api.primitive('rectangle', 'dcr-sampler')
	if (!rect) { warn('Could not create a sampler shape for ' + name + '; it exports as baked shapes'); return null }
	try {
		api.set(rect, { 'generator.dimensions.x': 4, 'generator.dimensions.y': 4 })
		clearShapes(dup)
		api.connect(rect, 'id', dup, 'shapes')
		const bake = rawBake(comp)
		const series = samplerSeries(bake, dup, ids)
		if (!series || !series.length) {
			warn('The distribution points of ' + name + ' could not be read from the sampler bake; it exports as baked shapes')
			return null
		}
		return series
	} finally {
		// restore the original inputs in their original order, whatever happened
		clearShapes(dup)
		for (const src of sources) {
			try { api.connect(src, 'id', dup, 'shapes') } catch (e) {}
		}
		try { api.deleteLayer(rect) } catch (e) {}
	}
}

// --- the pass ---------------------------------------------------------------
// Returns { refs, warnings } after rewriting exported.layers in place; newComp is
// called to build each referenced comp once (it must return { fr, w, h, layers? }).
// measuredTiming (from a prior collectTimingMeasurement, when present) maps a
// duplicator id → per-copy offsets in the bake's copy order at the 1x scale;
// comp-ref copies sample at 2x, so those are doubled here.
export function duplicatorCompRefs(comp, exported, sceneOf, newComp, measuredTiming, measuredPoints) {
	const warnings = []
	const warn = warnings.push.bind(warnings)
	const frame = api.getFrame()
	try {
		const ids = new Set(compLayers(comp))
		const dups = compLayers(comp).filter((id) => api.getLayerType(id) === 'duplicator')
		const made = []

		for (const dup of dups) {
			try {
				// which input shapes feed this duplicator? (its private shapes slot,
				// read from the scene graph so a short list never logs an attribute error)
				const sources = inputSources(dup)
				if (!sources || !sources.length) continue
				const isCompSource = sources.map((s) => api.getLayerType(s) === 'compositionReference')
				if (!isCompSource.some(Boolean)) continue // nothing for this pass to do
				const inners = [...new Set(sources.filter((s, i) => isCompSource[i]).map(compOf))]
				if (inners.some((c) => !c)) continue
				const name = api.getNiceName(dup) || dup

				// find the writer's baked layer for this duplicator
				const layer = exported.layers.find((L) => L.ty === 4 && sceneOf.get(L) === dup)
					|| exported.layers.find((L) => L.ty === 4 && sceneId(L.mn, ids) === dup)
				if (!layer) continue

				// distribution points: prefer the throwaway-comp measurement (it also
				// carries the timing), else one sampler bake works for every
				// distribution type, animated or not
				const measuredPts = measuredPoints && measuredPoints[dup]
				let seriesA = null
				if (!measuredPts) {
					seriesA = sampleDistribution(comp, dup, sources, ids, warn, name)
					if (!seriesA) continue
				}
				const count = measuredPts ? measuredPts.length : seriesA.length
				if (count < 2 || count > 4096) continue // degenerate: leave the bake
				const sample = measuredPts
					? { moving: false, points: measuredPts.map((c) => ({ a: 0, k: [c[0], c[1], 0] })) }
					: seriesToPoints(seriesA)

				// static shape* attributes other than position still apply to the
				// precomp layers (the sampler bake only encodes position)
				const ss = api.get(dup, 'shapeScale') || { x: 1, y: 1 }
				const sr = Number(api.get(dup, 'shapeRotation')) || 0
				const so = Number(api.get(dup, 'shapeOpacity'))
				const shapeStatic = (api.getAnimatedAttributes(dup) || []).filter((a) => a.indexOf('shape') === 0).length === 0

				// one precomp asset per referenced comp (newComp builds/registers it and
				// returns { id, w, h, layers? }) — when it hands back the asset's layer
				// list, extend it for the hold-on-first/last-frame behaviour (below)
				const built = inners.map((inner) => newComp(inner, dup))

				// per-copy sample times (frames): measured offsets (two-click flow,
				// shape-input 1x scale → 2x for comp refs) when available, else the
				// analytic ladder (see the timing note), reversed into the bake's copy
				// order
				const measured = measuredTiming && measuredTiming[dup]
				const timing = measured
					? { constant: measured.map((o) => COMP_REF_TIME_SCALE * o) }
					: seriesA ? sampleTimes(seriesA, nominalOffsets(dup, count, warn, name)) : null
				if (!timing) {
					warn('The timing of ' + name + ' could not be decoded; the copies export without time offsets')
				}

				// Cavalry holds a precomp on its first/last frame when the sample time
				// falls outside it; Lottie players instead hide the inner layers there.
				// Extending the asset's layers' in/out to cover the offsets makes the
				// players' own value clamping (first/last keyframe) act as the hold.
				const pad = timing ? Math.ceil(Math.max(0, ...[].concat(timing.constant || [], (timing.rows || []).flatMap((r) => r.vals)).map(Math.abs))) : 0
				if (pad > 0) {
					for (const asset of built) {
						for (const L of asset.layers || []) {
							L.ip = Math.max(-pad, (L.ip || 0) - pad)
							L.op = (L.op || 0) + pad
						}
					}
				}

				// Mixed inputs: the baked layer keeps one group per point, cycling
				// sources[i % sources.length] in point order. Strip the groups at the
				// points that show a composition reference (their content is the broken
				// fill-less bake) and keep the groups that render fine on their own.
				const allCompRefs = isCompSource.every(Boolean)
				if (!allCompRefs) {
					if (!layer.shapes || !layer.shapes.length || layer.shapes[0].ty !== 'gr') {
						warn('The mixed duplicator ' + name + ' has an unexpected bake structure; it exports as baked shapes')
						continue
					}
					const outerIt = layer.shapes[0].it
					const groupCount = outerIt.filter((it) => it.ty === 'gr').length
					if (groupCount !== count) {
						warn('The mixed duplicator ' + name + ' has ' + groupCount + ' baked groups for ' + count + ' points; it exports as baked shapes')
						continue
					}
					let gi = 0
					for (let k = 0; k < outerIt.length; k++) {
						if (outerIt[k].ty !== 'gr') continue
						if (isCompSource[gi % sources.length]) { outerIt.splice(k, 1); k-- }
						gi++
					}
				}

				const copies = []
				for (let i = 0; i < count; i++) {
					if (!isCompSource[i % sources.length]) continue // ordinary shape: stays baked
					const src = sources[i % sources.length]
					const inner = compOf(src)
					const asset = built[inners.indexOf(inner)]
					const L = {
						ind: 0, // assigned below
						ty: 0,
						nm: name + '_' + i,
						refId: asset.id,
						w: asset.w,
						h: asset.h,
						ip: layer.ip,
						op: layer.op,
						st: 0,
						sr: 1,
						ks: JSON.parse(JSON.stringify(layer.ks || {})),
					}
					L.ks = L.ks || {}
					L.ks.a = { a: 0, k: [asset.w / 2, asset.h / 2, 0] }
					L.ks.p = addP(L.ks.p, sample.points[i])
					if (shapeStatic) {
						if (ss && (ss.x !== 1 || ss.y !== 1)) L.ks.s = mulS(L.ks.s, ss.x * 100, ss.y * 100)
						if (sr) L.ks.r = { a: 0, k: sr }
					}
					if (so != null && so !== 100) L.ks.o = { a: 0, k: so }
					// per-copy sample time: Cavalry shows the copy at parent + offset;
					// Lottie's st shows the asset at parent − st, so st = −offset
					// (frames — the writer's and Cavalry files' convention).
					if (timing && timing.constant) L.st = Math.round(-timing.constant[i] * 100) / 100
					copies.push(L)
				}

				// give the copies fresh inds above the existing ones (other layers' inds
				// and any parent references stay valid)
				const base = Math.max(0, ...exported.layers.map((q) => q.ind || 0))
				copies.forEach((q, j) => { q.ind = base + 1 + j })

				if (allCompRefs) {
					// replace the baked layer entirely, keeping its slot in the draw order
					const at = exported.layers.indexOf(layer)
					exported.layers.splice(at, 1, ...copies)
				} else {
					// keep the trimmed baked layer; slot the precomp copies in next to it
					const at = exported.layers.indexOf(layer)
					exported.layers.splice(at, 0, ...copies)
				}
				sceneOf.delete(layer)
				made.push(dup)
			} catch (err) {
				warnings.push('The duplicator ' + (api.getNiceName(dup) || dup) + ' could not be exported as precomps (' + (err && err.message) + '); it exports as baked shapes')
			}
		}

		// the referenced comps were registered by newComp; nothing to concat here
		return { refs: made.length, warnings }
	} finally {
		api.setFrame(frame)
	}
}

// the writer inlines a duplicator layer's mn as the node id with the layer's ind
// appended (duplicator#26 + 3 -> "duplicator#263"); match the longest prefix, as
// precomps.js's sceneId does
function sceneId(mn, ids) {
	if (!mn) return null
	if (ids.has(mn)) return mn
	for (let s = mn.slice(0, -1); /#\d+$/.test(s); s = s.slice(0, -1)) if (ids.has(s)) return s
	return null
}

// Evaluate a 1D Lottie property at time t with linear interpolation.
function propValue1D(q, t) {
	if (!q) return 0
	if (q.a === 0 || typeof q.k === 'number') return typeof q.k === 'number' ? q.k : 0
	const ks = q.k || []
	if (!ks.length) return 0
	if (t <= ks[0].t) return ks[0].s[0]
	if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].s[0]
	for (let i = 1; i < ks.length; i++) {
		if (t <= ks[i].t) {
			const a = ks[i - 1], b = ks[i]
			const u = (t - a.t) / ((b.t - a.t) || 1)
			return a.s[0] + (b.s[0] - a.s[0]) * u
		}
	}
	return ks[ks.length - 1].s[0]
}

// The layer's own position offset at time t, [x, y].
function offsetAt(p, t) {
	if (!p) return [0, 0]
	if (p.s) return [propValue1D(p.x, t), propValue1D(p.y, t)]
	if (p.a === 0 || !Array.isArray(p.k)) return [p.k[0] || 0, p.k[1] || 0]
	const ks = p.k
	if (!ks.length) return [0, 0]
	const evalAt = (kf) => kf.s || [0, 0]
	if (t <= ks[0].t) return evalAt(ks[0])
	if (t >= ks[ks.length - 1].t) return evalAt(ks[ks.length - 1])
	for (let i = 1; i < ks.length; i++) {
		if (t <= ks[i].t) {
			const a = ks[i - 1], b = ks[i]
			const u = (t - a.t) / ((b.t - a.t) || 1)
			const sa = evalAt(a), sb = evalAt(b)
			return [sa[0] + (sb[0] - sa[0]) * u, sa[1] + (sb[1] - sa[1]) * u]
		}
	}
	return evalAt(ks[ks.length - 1])
}

// Merge a distribution point into a layer position. point is either a static
// { a: 0, k: [x, y, 0] } or a split-dimension { s: true, x, y } property; p (the
// layer's existing position) may be absent, static, animated or split.
function addP(p, point) {
	if (!point) return p
	if (!p) return JSON.parse(JSON.stringify(point))
	if (!point.s) {
		const [dx, dy] = point.k
		if (p.s) {
			const shift = (q, d) => {
				if (!q) return { a: 0, k: d }
				if (q.a === 0) return Object.assign({}, q, { k: q.k + d })
				return Object.assign({}, q, {
					k: q.k.map((kf) => Object.assign({}, kf, kf.s != null ? { s: kf.s + d } : {}, kf.e != null ? { e: kf.e + d } : {})),
				})
			}
			return Object.assign({}, p, { x: shift(p.x, dx), y: shift(p.y, dy) })
		}
		if (p.a === 0) return Object.assign({}, p, { k: [p.k[0] + dx, p.k[1] + dy, 0] })
		const add = (v) => [v[0] + dx, v[1] + dy]
		return Object.assign({}, p, {
			k: p.k.map((kf) => Object.assign({}, kf, kf.s ? { s: add(kf.s) } : {}, kf.e ? { e: add(kf.e) } : {})),
		})
	}
	// moving point: start from the sampled per-frame property and fold the
	// layer's own position in as a per-frame offset
	const out = JSON.parse(JSON.stringify(point))
	const shiftFrames = (q, axis) => {
		for (const kf of q.k) {
			const [ox, oy] = offsetAt(p, kf.t)
			kf.s[0] += axis === 'x' ? ox : oy
		}
	}
	shiftFrames(out.x, 'x')
	shiftFrames(out.y, 'y')
	return out
}

function mulS(s, mx, my) {
	const base = s && s.a === 0 ? s.k : [100, 100, 100]
	return { a: 0, k: [base[0] * mx / 100, base[1] * my / 100, 100] }
}
