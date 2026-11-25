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

import { compLayers } from './cavalryExport.js'

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

function rawBake(compId) {
	const dir = api.getTempFolder() + '/dcr-sampler-' + Date.now()
	api.makeFolder(dir)
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
	return JSON.parse(api.readFromFile(file))
}

// Remove every current input from the duplicator's shapes slot. Disconnecting
// 'shapes.0' repeatedly works because the list recompacts after each removal.
function clearShapes(dup) {
	for (let guard = 0; guard < 512; guard++) {
		let raw = null
		try { raw = api.getInConnection(dup, 'shapes.0') } catch (e) { break }
		if (raw == null || raw === '') break
		try { api.disconnect(String(raw).replace(/\.id$/, ''), 'id', dup, 'shapes.0') } catch (e) { break }
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
	// serialise returns an array of JSON strings (chunks) that must be joined
	let nodes = null
	try { nodes = JSON.parse([].concat(api.serialise([driver], false)).join('')) } catch (e) { nodes = null }
	const attrs = nodes && nodes.nodes && nodes.nodes[0] && nodes.nodes[0].attributes
	if (!attrs || !attrs.graph) {
		warn('The time offset driver of ' + name + ' is not a stagger; its copies export without time offsets')
		return null
	}
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
export function duplicatorCompRefs(comp, exported, sceneOf, newComp) {
	const warnings = []
	const warn = warnings.push.bind(warnings)
	const frame = api.getFrame()
	try {
		const ids = new Set(compLayers(comp))
		const dups = compLayers(comp).filter((id) => api.getLayerType(id) === 'duplicator')
		const made = []

		for (const dup of dups) {
			try {
				// which input shapes feed this duplicator? (private slot; probe per entry;
				// a missing entry throws and getInConnection answers "")
				const sources = []
				for (let s = 0; s < 16; s++) {
					let raw = null
					try { raw = api.getInConnection(dup, 'shapes.' + s) } catch (e) { break }
					if (raw == null || raw === '') break
					sources.push(String(raw).replace(/\.id$/, ''))
				}
				if (!sources.length) continue
				const isCompSource = sources.map((s) => api.getLayerType(s) === 'compositionReference')
				if (!isCompSource.some(Boolean)) continue // nothing for this pass to do
				const inners = [...new Set(sources.filter((s, i) => isCompSource[i]).map(compOf))]
				if (inners.some((c) => !c)) continue
				const name = api.getNiceName(dup) || dup

				// find the writer's baked layer for this duplicator
				const layer = exported.layers.find((L) => L.ty === 4 && sceneOf.get(L) === dup)
					|| exported.layers.find((L) => L.ty === 4 && sceneId(L.mn, ids) === dup)
				if (!layer) continue

				// distribution points: one sampler bake works for every distribution
				// type, animated or not. The baked positions already include the
				// duplicator's shape* position, so they are used as-is.
				const seriesA = sampleDistribution(comp, dup, sources, ids, warn, name)
				if (!seriesA) continue
				const count = seriesA.length
				if (count < 2 || count > 4096) continue // degenerate: leave the bake
				const sample = seriesToPoints(seriesA)

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

				// per-copy sample times (frames) from the empirical 2x law (see the
				// timing note): nominal offsets reversed into the bake's copy order
				const timing = sampleTimes(seriesA, nominalOffsets(dup, count, warn, name))
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
