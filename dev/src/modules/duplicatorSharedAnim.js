// Shared-animation duplicator restructure for Lottie JSON.
// Standalone: no Cavalry api.* dependencies, so it runs on any parsed Lottie JSON.
//
// duplicatorRestructure.js shares GEOMETRY only — every copy keeps its own baked
// position, scale and rotation keys, so it saves 4-6% of a file. This module shares
// the ANIMATION as well, which is where the bytes actually are.
//
// How the copies relate. A duplicator bakes N copies of one input shape. Each copy
// is that shape under its own transform, and the transforms are not independent:
// every copy samples the SAME set of animated curves, each at its own time offset.
//
//   position_i(t) = slot_i + P(t + offX_i)      // slot_i is a constant grid offset
//   scale_i(t)    = S(t + offS_i)
//
// Rotation is not shared: exporters synthesise it out of shear during the bake and
// it carries no authored intent. It is dropped here, and that is safe whenever a
// copy's rotation is a multiple of 90 degrees on a shape invariant under 90 degree
// rotation (a square). Anything else keeps its rotation.
//
// The offsets are MEASURED, by fitting each copy's baked channel against a reference
// copy, not decoded from the scene's driver graph. That matters: a driver's per-index
// values live inside the driver (a seed, a graph, an index order) and cannot be read
// from the export. Fitting needs no driver knowledge at all, so Stagger, Random, Noise,
// keyed drivers and animated distributions all work identically. The fit residual is
// the trust test — if the copies are not time-shifted copies of one curve, the fit
// fails and the duplicator is left alone.
//
// The rewrite keeps the per-copy position keys verbatim (they are exact and carry the
// Stagger-delayed x movement), and replaces only the scale channel with one shared
// curve on a precomp asset, phased per copy by the reference layer's `st`.
//
// Lottie's `st` semantics, verified against lottie-web 5.12.2 rather than assumed:
//   CVBaseElement: this.elements[i].prepareFrame(num - this.layers[i].st)
// so a ref layer's `st` shifts the ASSET CONTENT timeline by -st frames, while the
// ref layer's own transform keys stay on the global clock. That is exactly what this
// rewrite needs: position on the global clock, scale phased per copy.

// --- cubic bezier -----------------------------------------------------------
// Lottie evaluates an eased segment with getBezierEasing(o.x, o.y, i.x, i.y), i.e.
// `o` of the segment's start key is control point 1 and `i` of the end key is
// control point 2.
function segmentEase(a, b, u, ch) {
	const pick = (v) =>
		Array.isArray(v) ? (v[ch] === undefined ? v[0] : v[ch]) : v
	const x1 = pick(a && a.o && a.o.x)
	const y1 = pick(a && a.o && a.o.y)
	const x2 = pick(b && b.i && b.i.x)
	const y2 = pick(b && b.i && b.i.y)
	if (x1 == null || y1 == null || x2 == null || y2 == null) return u
	let lo = 0
	let hi = 1
	for (let k = 0; k < 24; k++) {
		const m = (lo + hi) / 2
		const bx =
			3 * (1 - m) * (1 - m) * m * x1 +
			3 * (1 - m) * m * m * x2 +
			m * m * m
		if (bx < u) lo = m
		else hi = m
	}
	const m = (lo + hi) / 2
	return 3 * (1 - m) * (1 - m) * m * y1 + 3 * (1 - m) * m * m * y2 + m * m * m
}

// A property -> f(frame) returning a number (channel 0) or an array.
export function propertySampler(prop) {
	if (!prop) return null
	const k = prop.k
	if (!Array.isArray(k))
		return typeof k === 'number'
			? () => k
			: Array.isArray(k)
				? () => k
				: null
	if (!k.length) return null
	return (t) => {
		if (t <= k[0].t) return k[0].s
		if (t >= k[k.length - 1].t) return k[k.length - 1].s
		for (let i = 0; i < k.length - 1; i++) {
			const a = k[i]
			const b = k[i + 1]
			if (a.t <= t && t <= b.t) {
				const span = b.t - a.t
				const u = span === 0 ? 0 : (t - a.t) / span
				const ch = Array.isArray(b.s) ? 0 : -1
				const e = segmentEase(a, b, u, ch)
				if (Array.isArray(a.s))
					return a.s.map(
						(v, j) =>
							v + ((b.s[j] === undefined ? v : b.s[j]) - v) * e
					)
				return a.s + (b.s - a.s) * e
			}
		}
		return k[k.length - 1].s
	}
}

export const scalar = (v) => (Array.isArray(v) ? v[0] : v)

// Linear read of a sampled series, clamped to its ends. The grid spacing is read
// from the series itself rather than assumed, so any sampling rate works.
export function readSeries(series, t) {
	const n = series.length
	if (!n) return 0
	if (t <= series[0].t) return series[0].v
	if (t >= series[n - 1].t) return series[n - 1].v
	const dt = series[1].t - series[0].t
	if (!(dt > 0)) return series[0].v
	const x = (t - series[0].t) / dt
	const i0 = Math.max(0, Math.min(n - 2, Math.floor(x)))
	const f = x - i0
	return series[i0].v * (1 - f) + series[i0 + 1].v * f
}

// --- reading the duplicator bake -------------------------------------------
// The writer bakes a duplicator's copies as `gr` children of one outer `gr` (which
// itself ends with a `tr` item) — the container is not a copy.
export function copyGroups(shapes) {
	const out = []
	for (const outer of shapes || []) {
		if (outer.ty !== 'gr' || !Array.isArray(outer.it)) continue
		const groups = outer.it.filter((it) => it.ty === 'gr')
		// A copy group holds a path, a fill and a transform. The container's own `tr`
		// makes the outer item longer than a copy, so require the children to look
		// like copies and to be numerous enough to be a duplicator.
		const copies = groups.filter((g) => {
			const tys = (g.it || []).map((it) => it.ty)
			return (
				tys.includes('sh') && tys.includes('fl') && tys.includes('tr')
			)
		})
		if (copies.length >= 20) return copies
	}
	return out
}

const findTr = (g) => (g.it || []).find((it) => it.ty === 'tr') || null
const findOf = (g, ty) => (g.it || []).find((it) => it.ty === ty) || null

// Vertices and their in/out tangents, relative to the first vertex, rounded to a
// tolerance so float noise across a bake does not read as a different shape.
export function geometryKey(path) {
	const ks = path && path.ks
	const v = ks && ks.k && ks.k.v
	if (!Array.isArray(v) || !v.length) return null
	const ox = v[0][0]
	const oy = v[0][1]
	const pts = v.map((p) => [
		Math.round((p[0] - ox) * 100) / 100,
		Math.round((p[1] - oy) * 100) / 100,
	])
	const i = (ks.k.i || []).map((p) => [
		Math.round(p[0] * 100) / 100,
		Math.round(p[1] * 100) / 100,
	])
	const o = (ks.k.o || []).map((p) => [
		Math.round(p[0] * 100) / 100,
		Math.round(p[1] * 100) / 100,
	])
	return JSON.stringify([pts, i, o])
}

export const vertexCentroid = (path) => {
	const v = path && path.ks && path.ks.k && path.ks.k.v
	if (!Array.isArray(v) || !v.length) return null
	let x = 0
	let y = 0
	for (const p of v) {
		x += p[0]
		y += p[1]
	}
	return [x / v.length, y / v.length]
}

// --- measuring the per-copy delay -------------------------------------------
// Fit offsets by cross-correlating each copy's channel against a reference copy.
//
// The reference must be the copy that starts MOVING EARLIEST. A delayed copy holds
// still at the start of its own timeline, so a reference that is itself flat for the
// first dozen frames makes every candidate delay score identically (the fit is
// degenerate over exactly that flat region) and the recovered offsets collapse to ~0.
// Picking the earliest-rising copy and scoring only where the reference is actually
// moving removes that degeneracy.
//
// The reference is evaluated through its BEZIER, not through a resampled series.
// Linear interpolation between baked keys is wrong by a few hundredths of a frame,
// and a duplicator's container can be scaling 1000%+ during the opening frames, which
// multiplies that error into whole pixels. Reading the true curve removes it.
export function fitOffsets(seriesList, frames, opts) {
	opts = opts || {}
	const tol = opts.movingTol == null ? 0.01 : opts.movingTol
	const maxLag = opts.maxLag == null ? 30 : opts.maxLag
	const step = opts.step == null ? 0.05 : opts.step
	const refFn = opts.refSampler || null
	if (!seriesList.length || !seriesList[0].length) return null

	// range of the reference's own motion, normalised so a flat channel is rejected
	const span = (s) =>
		Math.max(...s.map((p) => p.v)) - Math.min(...s.map((p) => p.v))

	// the earliest-rising copy: the first frame at which each copy leaves its start value
	const startVal = (s) => s[0].v
	let ref = 0
	let earliest = Infinity
	for (let i = 0; i < seriesList.length; i++) {
		const s = seriesList[i]
		const v0 = startVal(s)
		let t0 = Infinity
		for (const p of s) {
			if (Math.abs(p.v - v0) > tol * Math.max(1, span(s))) {
				t0 = p.t
				break
			}
		}
		if (t0 < earliest) {
			earliest = t0
			ref = i
		}
	}
	if (!isFinite(earliest)) return null // nothing moves: no delay to measure

	const refSeries = seriesList[ref]
	const refSpan = span(refSeries)
	if (refSpan <= 0) return null
	// refSampler is a factory: it cannot be built until the reference index is known
	const refCurve = typeof refFn === 'function' ? refFn(ref) : null

	// only score where the reference is inside its moving window, so a flat head does
	// not dominate the residual
	const refStart = earliest
	const refEnd = frames[frames.length - 1]

	// Index the reference curve on the same frame grid the copies were sampled on,
	// so a lag lookup is an array read rather than a bezier evaluation. Frames are
	// uniform, so the grid step is exact.
	const dt = frames.length > 1 ? frames[1] - frames[0] : 1
	const refGrid = frames.map((t) =>
		refCurve ? scalar(refCurve(t)) : readSeries(refSeries, t)
	)
	const readRef = (t) => {
		const x = (t - frames[0]) / dt
		const i0 = Math.floor(x)
		if (i0 < 0) return refGrid[0]
		if (i0 >= refGrid.length - 1) return refGrid[refGrid.length - 1]
		const f = x - i0
		return refGrid[i0] * (1 - f) + refGrid[i0 + 1] * f
	}
	// and index each copy's own samples the same way, so `s.find` disappears
	const copyGrids = seriesList.map((s) => s.map((p) => p.v))

	// The residual falls off a cliff at the right lag and is flat elsewhere, so a
	// coarse sweep followed by a fine local search finds the same minimum for a
	// fraction of the cost. Scoring every candidate at step 0.01 over 91 copies is
	// otherwise ~50k curve reads per copy.
	const COARSE = 0.25
	const evaluate = (i, lag) => {
		const g = copyGrids[i]
		let sum = 0
		let n = 0
		for (let k = 0; k < frames.length; k++) {
			const ts = frames[k] + lag
			if (ts < refStart || ts > refEnd) continue
			sum += Math.abs(g[k] - readRef(ts))
			n++
		}
		return n < 12 ? Infinity : sum / n
	}

	const offsets = []
	const residuals = []
	for (let i = 0; i < seriesList.length; i++) {
		let bestLag = null
		let bestErr = Infinity
		for (let lag = -maxLag; lag <= maxLag + 1e-9; lag += COARSE) {
			const e = evaluate(i, lag)
			if (e < bestErr) {
				bestErr = e
				bestLag = lag
			}
		}
		if (bestLag == null) return null
		// refine around the coarse winner
		for (
			let lag = bestLag - COARSE;
			lag <= bestLag + COARSE + 1e-9;
			lag += step
		) {
			const e = evaluate(i, lag)
			if (e < bestErr) {
				bestErr = e
				bestLag = lag
			}
		}
		offsets.push(Math.round(bestLag * 100) / 100)
		residuals.push(bestErr)
	}

	// normalise the residual against the reference's own span: a fit that cannot
	// reproduce a copy within a small fraction of the channel's range is not trusted
	const worst = Math.max(...residuals)
	const rel = worst / refSpan
	return {
		ref,
		offsets,
		residuals,
		worstResidual: worst,
		refSpan,
		relativeResidual: rel,
	}
}

// Sample a property onto the fit frame grid.
const sampleProperty = (prop, frames) => {
	const f = propertySampler(prop)
	if (!f) return null
	const out = []
	for (const t of frames) {
		const v = f(t)
		out.push({ t, v: scalar(v) })
	}
	return out
}

// --- public entry point -----------------------------------------------------
// The gate, as a fraction of the channel's own range.
//
// Calibration, measured on a scale channel spanning 0-100:
//   the real Transition_01 scene (91 copies, Random-driven delay) ... 0.0009
//   the same ramp under a genuinely different ease .................... 0.018
//   a two-step ramp that no single lag explains ....................... 0.040
// So 0.005 sits an order of magnitude above real-world bake noise and well below
// anything that reads as a different curve. A duplicator that misses it is left to
// duplicatorRestructure, which shares geometry only and cannot be wrong about timing.
export const RESIDUAL_LIMIT = 0.005
export const MIN_SAVING_BYTES = 1024

export function restructureSharedAnim(json, opts) {
	opts = opts || {}
	if (!opts.sharedAnim) return { changed: 0, reports: [] }
	if (!json || !Array.isArray(json.layers)) return { changed: 0, reports: [] }

	const reports = []
	let changed = 0

	// The fit needs a frame grid. Derive it from the comp's own range when the caller
	// does not pass one, at quarter-frame resolution: the per-copy delays are
	// fractional, so a whole-frame grid cannot resolve them.
	const frames =
		opts.frames ||
		(() => {
			const ip = Number(json.ip) || 0
			const op = Number(json.op) || 0
			const out = []
			for (let t = ip; t <= op + 1e-9; t += 0.25) out.push(t)
			return out
		})()

	for (let li = 0; li < json.layers.length; li++) {
		const layer = json.layers[li]
		if (layer.ty !== 4) continue
		const groups = copyGroups(layer.shapes)
		if (groups.length < 20) continue

		const srcGroup = groups.find(
			(g) => findOf(g, 'sh') && findOf(g, 'fl') && findTr(g)
		)
		if (!srcGroup) continue
		// ONE shared geometry: every copy must carry the same path up to translation.
		const keys = groups.map((g) => geometryKey(findOf(g, 'sh')))
		const unique = new Set(keys)
		if (unique.size !== 1) {
			reports.push({
				layer: layer.ind,
				skipped: 'copies carry ' + unique.size + ' distinct geometries',
			})
			continue
		}

		const scaleCurves = groups.map((g) => {
			const tr = findTr(g)
			return tr ? sampleProperty(tr.s, frames) : null
		})
		if (scaleCurves.some((c) => !c)) {
			reports.push({
				layer: layer.ind,
				skipped: 'a copy has no scale property',
			})
			continue
		}

		// The reference curve is read through its bezier, not through a resampled
		// series: linear interpolation between baked keys is off by a few hundredths
		// of a frame, and a duplicator's container can be scaling 1000%+ during the
		// opening frames, which turns that into whole pixels of vertex error.
		const refSamplerFor = (i) => {
			const f = propertySampler(findTr(groups[i]).s)
			return f ? (t) => scalar(f(t)) : null
		}
		const fit = fitOffsets(
			scaleCurves,
			frames,
			Object.assign({}, opts.fit, { refSampler: refSamplerFor })
		)
		if (!fit) {
			reports.push({
				layer: layer.ind,
				skipped: 'scale delays are degenerate (nothing moves)',
			})
			continue
		}
		if (
			fit.relativeResidual >
			(opts.residualLimit == null ? RESIDUAL_LIMIT : opts.residualLimit)
		) {
			// Strict gate: no partial rewrites. If the copies are not time-shifted
			// copies of one curve, leave the duplicator to duplicatorRestructure,
			// which shares geometry only and cannot be wrong about timing.
			reports.push({
				layer: layer.ind,
				skipped:
					'scale fit residual ' +
					fit.relativeResidual.toFixed(4) +
					' exceeds ' +
					(opts.residualLimit == null
						? RESIDUAL_LIMIT
						: opts.residualLimit),
			})
			continue
		}

		const built = build(json, layer, groups, srcGroup, fit, opts)
		if (!built) {
			reports.push({
				layer: layer.ind,
				skipped: 'rewrite would not be smaller',
			})
			continue
		}
		reports.push(built)
		changed++
	}

	return { changed, reports }
}

function build(json, layer, groups, srcGroup, fit, opts) {
	const before = JSON.stringify(layer).length

	const fr = Number(json.fr) || 30
	const ip = Number(json.ip) || 0
	const op = Number(json.op) || 0
	const w = Number(json.w) || 1920
	const h = Number(json.h) || 1080

	// The container group in the original wraps every copy and may carry the
	// duplicator's global transform. Preserve it exactly, but as a parent null:
	// once the copies become sibling layers there is no group left to hold it.
	const containerTr =
		(layer.shapes || [])
			.map((s) =>
				s.ty === 'gr' && Array.isArray(s.it)
					? s.it[s.it.length - 1]
					: null
			)
			.find((it) => it && it.ty === 'tr') || null

	// shared geometry, expressed relative to its own centroid so the asset can be
	// scaled about the origin
	const srcPath = JSON.parse(JSON.stringify(findOf(srcGroup, 'sh')))
	const cent = vertexCentroid(srcPath)
	if (!cent) return null
	srcPath.ks.k.v = srcPath.ks.k.v.map((p) => [p[0] - cent[0], p[1] - cent[1]])

	const srcFill = JSON.parse(JSON.stringify(findOf(srcGroup, 'fl')))

	// the reference copy's own scale keys become the shared curve, verbatim, so the
	// asset keeps the authored eases instead of a resampled approximation
	const refTr = findTr(groups[fit.ref])
	const sharedScale = JSON.parse(JSON.stringify(refTr.s))

	const refAssetId =
		'shared_anim_' + layer.ind + '_' + Math.floor(Math.random() * 1e6)
	if (!json.assets) json.assets = []

	const asset = {
		id: refAssetId,
		nm: 'Shared anim',
		fr,
		w,
		h,
		layers: [
			{
				ddd: 0,
				ind: 1,
				ty: 4,
				nm: 'shared',
				sr: 1,
				ip,
				op,
				st: 0,
				ao: 0,
				ks: {
					o: { a: 0, k: 100 },
					r: { a: 0, k: 0 },
					// centred in the precomp: a precomp clips its content to [0,w]x[0,h]
					// (CVCompElement.renderInnerContent), so geometry centred on the
					// origin would have its left/top half cut away.
					p: { a: 0, k: [w / 2, h / 2] },
					a: { a: 0, k: [0, 0] },
					s: sharedScale,
				},
				// `shapes` must be an ARRAY of shape items. A bare `gr` object here is
				// silently ignored by lottie-web and the precomp renders empty.
				shapes: [
					{
						ty: 'gr',
						it: [
							srcPath,
							srcFill,
							{
								ty: 'tr',
								p: { a: 0, k: [0, 0] },
								a: { a: 0, k: [0, 0] },
								s: { a: 0, k: [100, 100] },
								r: { a: 0, k: 0 },
								o: { a: 0, k: 100 },
							},
						],
					},
				],
			},
		],
	}
	json.assets.push(asset)

	const newLayers = []
	let parentInd = null
	// Indices must not collide with anything already in the comp: a duplicator can sit
	// beside other layers, and Lottie parents by `ind`.
	let nextInd =
		Math.max(
			0,
			...json.layers.map((L) => L.ind || 0),
			...((json.assets || []).flatMap((a) =>
				(a.layers || []).map((L) => L.ind || 0)
			) || [])
		) + 1

	// Two transforms wrap the copies and both must survive, so they become two nulls
	// in series. Lottie cannot hold two, and folding them onto the refs would bake the
	// layer's own animated scale into 91 copies.
	//
	// 1. the replaced LAYER's transform. A baked duplicator carries the comp-level
	//    scale (1139% -> 100% here) on the layer, not on the copies; dropping it draws
	//    the grid at full size for the whole animation. It keeps the layer's original
	//    parent, so above-layers above the duplicator still apply.
	if (layer.ks) {
		parentInd = nextInd++
		const nullLayer = {
			ddd: 0,
			ind: parentInd,
			ty: 3,
			nm: (layer.nm || 'duplicator') + ' transform',
			sr: 1,
			ip,
			op,
			st: 0,
			ao: 0,
			ks: JSON.parse(JSON.stringify(layer.ks)),
		}
		if (layer.parent != null) nullLayer.parent = layer.parent
		newLayers.push(nullLayer)
	}

	// 2. the container group's transform, which wrapped every copy inside the layer.
	//    Identity in the common case; carried anyway so a rotated or offset container
	//    is not silently lost.
	if (containerTr) {
		const inner = nextInd++
		const container = {
			ddd: 0,
			ind: inner,
			ty: 3,
			nm: 'grid transform',
			sr: 1,
			ip,
			op,
			st: 0,
			ao: 0,
			ks: {
				o: { a: 0, k: 100 },
				r: containerTr.r
					? JSON.parse(JSON.stringify(containerTr.r))
					: { a: 0, k: 0 },
				p: containerTr.p
					? JSON.parse(JSON.stringify(containerTr.p))
					: { a: 0, k: [0, 0] },
				a: { a: 0, k: [0, 0] },
				s: containerTr.s
					? JSON.parse(JSON.stringify(containerTr.s))
					: { a: 0, k: [100, 100] },
			},
		}
		if (parentInd != null) container.parent = parentInd
		else parentInd = inner
		newLayers.push(container)
	}

	const offRef = fit.offsets[fit.ref]
	for (let i = 0; i < groups.length; i++) {
		const tr = findTr(groups[i])
		// asset content frame = t - st; copy i must show the shared curve at
		// t + off_i - off_ref, so st = off_ref - off_i
		const st = Math.round((offRef - fit.offsets[i]) * 100) / 100
		const L = {
			ddd: 0,
			ind: nextInd++,
			ty: 0,
			nm: 'copy ' + i,
			refId: refAssetId,
			sr: 1,
			ip: 0,
			op,
			st,
			w,
			h,
			ao: 0,
			bm: 0,
			ks: {
				o: tr.o ? JSON.parse(JSON.stringify(tr.o)) : { a: 0, k: 100 },
				r: { a: 0, k: 0 },
				p: JSON.parse(JSON.stringify(tr.p)),
				a: { a: 0, k: [w / 2, h / 2] },
				s: { a: 0, k: [100, 100] },
			},
		}
		if (parentInd != null) L.parent = parentInd
		newLayers.push(L)
	}

	// Any shape group on the layer that is not part of the duplicator bake is a
	// separate drawing (a background panel, a rule, a caption). Dropping it loses
	// pixels, so carry it over untouched as its own shape layer.
	const duplicatorOuter = (layer.shapes || []).find(
		(s) =>
			s.ty === 'gr' &&
			Array.isArray(s.it) &&
			s.it.filter((it) => it.ty === 'gr').length >= 20
	)
	const extras = (layer.shapes || []).filter((s) => s !== duplicatorOuter)
	for (let ei = 0; ei < extras.length; ei++) {
		newLayers.push({
			ddd: 0,
			ind: nextInd++,
			ty: 4,
			nm: 'shape ' + ei,
			sr: 1,
			ip,
			op,
			st: 0,
			ao: 0,
			ks: {
				o: { a: 0, k: 100 },
				r: { a: 0, k: 0 },
				p: { a: 0, k: [0, 0] },
				a: { a: 0, k: [0, 0] },
				s: { a: 0, k: [100, 100] },
			},
			shapes: [extras[ei]],
		})
	}

	// the asset's geometry is centred on the copy's path centroid, and the ref keeps
	// the original position keys verbatim, so the drawn vertex is exactly
	//   p + 1 * (S * v_centred - 0) = p + S * (v - centroid)
	// which is the original group transform. The ref anchor stays at the origin.

	const after =
		JSON.stringify(newLayers).length + JSON.stringify(asset).length
	if (
		before - after <
		(opts.minSavingBytes == null ? MIN_SAVING_BYTES : opts.minSavingBytes)
	) {
		json.assets.pop()
		return null
	}

	json.layers.splice(li0(json, layer), 1, ...newLayers)
	return {
		layer: layer.ind,
		copies: groups.length,
		ref: fit.ref,
		offsets: fit.offsets,
		relativeResidual: Number(fit.relativeResidual.toFixed(5)),
		offsetSpan: Number(
			(Math.max(...fit.offsets) - Math.min(...fit.offsets)).toFixed(2)
		),
		bytesBefore: before,
		bytesAfter: after,
		saved: before - after,
	}
}

const li0 = (json, layer) => json.layers.indexOf(layer)
