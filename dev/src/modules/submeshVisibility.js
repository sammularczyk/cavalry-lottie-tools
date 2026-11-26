// Per-submesh (per-copy) visibility reproduction for the Lottie exporter.
//
// Cavalry's Lottie writer drops a subMesh's driven shapeVisibility: every copy of a
// duplicator exports as if always visible. This module reproduces the drivers we can
// read from the scene graph and turns them into per-frame 0/1 visibility masks per
// copy index, which the exporter injects into the Lottie JSON.
//
// Pure functions over plain data (no `api.` calls) so they run in Node tests.
//
// Polarity (measured in Cavalry): shapeVisibility truthy → visible, falsy → hidden.
// A driven shapeVisibility is strictly 0/1 — a hidden copy is skipped entirely.

// ------------------------------------------------------------------
// Driver 1: Visibility Sequence — exact reproduction of the documented
// algorithm (nodes/behaviours/visibility-sequence).
//
// A window of `start`%..`end`% of Count is visible; `travel` shifts the window
// forward by one sub-mesh per step, `invert` flips visible/hidden, and
// alwaysOn / alwaysOff lists ("1,3,5:8") force indices on/off after that.
// ------------------------------------------------------------------

// "1,3,5:8" → [1,3,5,6,7,8] (1-based, inclusive ranges). Invalid parts ignored.
export function parseIndexList(text) {
	if (typeof text !== 'string') return []
	const out = []
	String(text)
		.split(',')
		.forEach(function (part) {
			part = part.trim()
			if (!part) return
			const m = part.match(/^(\d+)\s*:\s*(\d+)$/)
			if (m) {
				const a = parseInt(m[1], 10)
				const b = parseInt(m[2], 10)
				for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i)
				return
			}
			const n = parseInt(part, 10)
			if (!isNaN(n)) out.push(n)
		})
	return out
}

// The visibility mask for one frame: arr[index] = 1 visible / 0 hidden.
// `seq` is the attribute bag of a visibility node (all values already resolved
// for the frame by the caller).
export function visibilitySequenceMask(seq, count) {
	const mask = new Array(count).fill(0)
	if (count <= 0) return mask
	const start = clamp01(num(seq.start) / 100)
	const end = clamp01(num(seq.end) / 100)
	const travel = num(seq.travel) || 0
	const invert = !!seq.invert

	// Window in index units: start% * count .. end% * count, shifted by travel.
	// The window WRAPS around the copy list (measured in Cavalry): with count 4,
	// start 0 / end 50 and travel 4 the window [4,6) lands on copies 0,1 again —
	// a copy is visible when its signed distance from the window start, taken
	// modulo count, is less than the window width.
	const a = Math.round(start * count) + Math.floor(travel)
	const b = Math.round(end * count) + Math.floor(travel)
	const offset = Math.min(a, b)
	const width = Math.abs(b - a)
	for (let i = 0; i < count; i++) {
		const rel = (((i - offset) % count) + count) % count
		const visible = rel < width ? 1 : 0
		mask[i] = invert ? 1 - visible : visible
	}

	parseIndexList(seq.alwaysOn).forEach(function (n) {
		const i = n - 1
		if (i >= 0 && i < count) mask[i] = 1
	})
	parseIndexList(seq.alwaysOff).forEach(function (n) {
		const i = n - 1
		if (i >= 0 && i < count) mask[i] = 0
	})
	return mask
}

function num(v) {
	return typeof v === 'number' && isFinite(v) ? v : 0
}
function clamp01(v) {
	return Math.max(0, Math.min(1, v))
}

// ------------------------------------------------------------------
// Driver 2: JavaScript utility expressions on shapeVisibility.
//
// Cavalry evaluates the expression once per copy per frame with ctx.index /
// ctx.count in scope (declaration-free, one persistent global context). We
// evaluate the same expression per index in a bare Function scope that
// provides a ctx-shaped context. Only expressions that behave as pure
// functions of ctx are safe; anything touching ctx.saveObject or Cavalry
// globals makes the mask unknowable and the caller should skip the driver.
// ------------------------------------------------------------------

// The ctx surface an expression may rely on for a per-index visibility read.
// saveObject/loadObject/hasObject break purity (state leaks across copies).
export function expressionIsIndexPure(expr) {
	return !/\bctx\s*\.\s*(saveObject|loadObject|hasObject)\b/.test(String(expr || ''))
}

// Evaluate `expr` for one index. Returns the raw value (may be falsy/NaN).
// Throws on syntax errors — callers treat a throwing expression as unknown.
export function evalIndexExpression(expr, index, count) {
	const ctx = {
		index: index,
		count: count,
		positionX: 0,
		positionY: 0,
		attributeId: '',
		layerId: '',
		niceName: '',
	}
	// Cavalry expressions are usually bare values ('ctx.index % 2;'), sometimes
	// multi-statement with the last line as the result. Evaluate the whole body
	// as an expression first; on syntax error, fall back to returning the last
	// statement's value by wrapping everything but a trailing expression.
	const src = String(expr || '')
	try {
		const fn = new Function('ctx', '"use strict";\nreturn (' + src.replace(/;\s*$/, '') + ');')
		return fn(ctx)
	} catch (e) {
		const fn = new Function('ctx', '"use strict";\n' + src + '\n')
		return fn(ctx)
	}
}

// Raw per-index values of an expression, or null when it is unpure or fails to
// evaluate — unknown.
export function expressionValues(expr, count) {
	if (!expressionIsIndexPure(expr)) return null
	const out = new Array(count)
	for (let i = 0; i < count; i++) {
		try {
			out[i] = evalIndexExpression(expr, i, count)
		} catch (e) {
			return null
		}
	}
	return out
}

// shapeVisibility is a bool fed by a number: measured against Cavalry renders,
// 0.49 hides a copy and 0.5 shows it (it rounds).
export function gateOf(v) {
	return typeof v === 'boolean' ? v : Number(v) >= 0.5
}

// Full mask for an expression across count indices: visible → 1, else 0.
export function expressionMask(expr, count) {
	const vals = expressionValues(expr, count)
	return vals ? vals.map((v) => (gateOf(v) ? 1 : 0)) : null
}

// shapeOpacity is hard-clamped to 0..100 (attribute definition, and renders:
// -50 draws as 0, 150 as 100).
export function clampOpacity(v) {
	return v < 0 ? 0 : v > 100 ? 100 : v
}

// ------------------------------------------------------------------
// Driver 3: Oscillator — evaluated analytically.
//
// Cavalry's writer drops a driven shapeOpacity exactly as it drops
// shapeVisibility, so an oscillator fading copies exports as a constant 100.
// Unlike a seeded Random, an oscillator is a closed-form function of time, so
// its per-copy value can be computed rather than measured: only its per-copy
// timeOffset (when that input is itself driven) has to come from the scene.
//
// Semantics measured against live Cavalry (attached through the one working
// scalar tap, shapeRotation, then read with api.get):
//   value(t) = centre + amplitude * wave(phase(t))
//   centre    = (maximum + minimum) / 2
//   amplitude = (maximum - minimum) / 2
//   phase(t)  = (t / fps + timeOffset) * cyclesPerSecond * timeScale
//   timeMode 0 (Seconds)  -> cyclesPerSecond = frequency
//   timeMode 1 (BPM)      -> cyclesPerSecond = frequency / 60
// Verified: min 0 / max 100 / frequency 1 / fps 60 / sine gives exactly 50 at
// frame 0, 100 at 15, 0 at 45; min -50 / max 50 gives 0 / 50 / -50. A cosine is
// the same wave a quarter cycle early, and timeOffset 0.25 s at 1 Hz matches
// trigType 1 exactly, confirming timeOffset is in SECONDS for timeMode 0.
// Number of waves, stagger and separateChannels only matter on polyMesh outputs
// (shapes deformed along a path), not on a scalar opt-in like shapeOpacity.
// ------------------------------------------------------------------

const TAU = Math.PI * 2

// One oscillator's output at time `t` (frames), on the raw min..max scale.
// `waveType` selects the wave shape; `trigType` its phase offset.
// One oscillator's output at time `t` (frames), on the raw min..max scale.
// `extraOffset` (seconds) adds to the config's own timeOffset — that is how a
// per-copy phase (a Random feeding timeOffset) enters the wave.
//
// Measured against live Cavalry by routing the oscillator into a subMesh's
// shapeRotation (the one driven attribute api.get will read) and sampling every
// frame. Wave shapes, all at frequency 1 / fps 60 / min 0 / max 100, with p the
// wave phase in cycles:
//   Normal   plane = 0.5 + 0.5*sin(2*pi*p)         -> 0.5 at p=0, 1 at p=.25
//   Square   plane = p-frac < 0.5 ? 1 : 0           -> 1 for the first half cycle
//   Triangle plane = 1 - |2*frac(p+0.25) - 1|       -> 0.5 at p=0, 1 at p=.25
//   Sawtooth plane = frac(p + 0.5)                  -> 0.5 at p=0, ramps to 1
//   value = minimum + (maximum - minimum) * plane
// Every wave's phase is aligned with the sine (rising through its midpoint at
// p=0), which is why triangle peaks where the sine does and the sawtooth starts
// half way up its ramp. Cosine (trigType 1) advances p by a quarter cycle; at
// the square wave that flips it half a cycle early, at the others it is the same
// mid-point-preserving shift. timeOffset is in SECONDS: at 0.5 Hz a timeOffset
// of 0.5 lands a quarter cycle in (measured 100 on a -100..100 sine) and 0.25
// lands an eighth in (70.71). timeMode 1 (BPM) divides frequency by 60.
export function oscillatorValueAt(cfg, t, extraOffset) {
	const c = cfg || {}
	const fps = num(c.fps) || 60
	const min = num(c.minimum)
	const max = num(c.maximum)
	const span = max - min

	// Frequency is cycles per second (timeMode 0) or cycles per minute (1).
	const cps =
		(num(c.timeMode) === 1 ? num(c.frequency) / 60 : num(c.frequency)) *
		(c.timeScale ? num(c.timeScale) : 1)
	let p = (t / fps + num(c.timeOffset) + num(extraOffset)) * cps
	const trig = num(c.trigType)
	if (trig === 2) return null // Tangent is unbounded: not reproducible as an opacity
	if (trig === 1) p += 0.25

	// `plane` is the wave's 0..1 progress; every wave is phase-aligned to the
	// sine, so only the shaping differs.
	let plane
	switch (num(c.waveType)) {
		case 0: // Normal
			plane = 0.5 + 0.5 * Math.sin(TAU * p)
			break
		case 1: { // Square
			const h = p - Math.floor(p)
			plane = h < 0.5 ? 1 : 0
			break
		}
		case 2: { // Triangle: peaks a quarter cycle in, like the sine
			const h = p + 0.25 - Math.floor(p + 0.25)
			plane = 1 - Math.abs(2 * h - 1)
			break
		}
		case 3: { // Sawtooth: starts half way up its own ramp
			const h = p + 0.5 - Math.floor(p + 0.5)
			plane = h
			break
		}
		default: return null // Custom (graph) and unknown styles: not evaluable here
	}

	// `base` is the wave's own min..max output. Strength then selects which
	// interpolation it scales toward, measured at minimum 20 / maximum 100:
	//   Strength Fades to Zero ON  -> value = base * (strength/100)
	//   Strength Fades to Zero OFF -> value = minimum + (base - minimum) * (strength/100)
	// Strength 0 with the option ON is 0 everywhere, OFF is the minimum everywhere.
	const base = min + span * plane
	const s = (c.strength == null ? 100 : num(c.strength)) / 100
	const v = c.strengthToZero ? base * s : min + (base - min) * s
	return v + num(c.offset)
}

// Per-frame oscillator values with a per-copy time offset (seconds) added.
// Returns null when the config is not analytically evaluable.
export function oscillatorSeries(cfg, frames, extraOffset) {
	if (!cfg || !frames || !frames.length) return null
	const out = []
	for (let i = 0; i < frames.length; i++) {
		const v = oscillatorValueAt(cfg, frames[i].frame, extraOffset)
		if (v == null) return null
		out.push(v)
	}
	return out
}

// ------------------------------------------------------------------
// Mask application to the Lottie JSON.
//
// A baked duplicator copy is a shape group (ty 'gr') whose tr.p is either
// static [x,y] or keyframed. `groupCentres` supplies the comp-space centre of
// each group the caller matched to copy indices; the mask maps index → 0/1.
//
// Injection mirrors injectVisibilityOpacity: a group visible at every frame
// is left untouched; a group hidden at every frame gets hd:true (removeHidden
// strips it); otherwise its tr.o becomes animated opacity keys holding 0/100.
// ------------------------------------------------------------------

// Lottie opacity property for a per-frame 0/1 mask.
//
// Hold interpolation means a key only needs to exist where the value CHANGES:
// each key holds until the next one. Emitting one key per frame wasted ~40
// bytes on every unchanged frame, so consecutive equal values collapse into a
// single key at the frame where that run begins. A frame series that never
// flips ends up with one key instead of `frames.length`.
export function maskToOpacityProp(mask, frames) {
	const keys = []
	for (let f = 0; f < mask.length; f++) {
		const v = mask[f] ? 100 : 0
		const prev = keys.length ? keys[keys.length - 1].s[0] : null
		if (prev === v) continue
		keys.push({
			t: frames[f].frame,
			s: [v],
			i: { x: [1], y: [1] },
			o: { x: [0], y: [0] },
		})
	}
	return { a: 1, k: keys }
}

// Lottie opacity property for a continuous per-frame series (0..100), with
// LINEAR interpolation and the key list thinned to the frames that carry the
// curve. A driven opacity (an oscillator fade) is a smooth function, so one key
// per frame would repeat the wave's shape hundreds of times per copy — on a
// 476-copy rig that is megabytes for no visible gain. Thinning is a
// Ramer–Douglas–Peucker pass in (frame, value) space with `tolerance` on the
// 0..100 opacity scale, so the emitted curve never deviates from the sampled
// one by more than that.
export function valuesToOpacityProp(values, frames, tolerance) {
	const tol = tolerance == null ? 0.75 : tolerance
	const pts = []
	for (let i = 0; i < values.length; i++) pts.push({ x: frames[i].frame, y: values[i] })
	if (!pts.length) return { a: 1, k: [] }
	const keep = new Array(pts.length).fill(false)
	keep[0] = true
	keep[pts.length - 1] = true
	const stack = [[0, pts.length - 1]]
	const lin = { x: [0.5], y: [0.5] }
	while (stack.length) {
		const seg = stack.pop()
		const a = seg[0]
		const b = seg[1]
		let worst = -1
		let worstD = tol
		for (let i = a + 1; i < b; i++) {
			const t = pts[b].x === pts[a].x ? 0 : (pts[i].x - pts[a].x) / (pts[b].x - pts[a].x)
			const d = Math.abs(pts[i].y - (pts[a].y + (pts[b].y - pts[a].y) * t))
			if (d > worstD) {
				worstD = d
				worst = i
			}
		}
		if (worst >= 0) {
			keep[worst] = true
			stack.push([a, worst])
			stack.push([worst, b])
		}
	}
	const keys = []
	for (let i = 0; i < pts.length; i++) {
		if (!keep[i]) continue
		keys.push({
			t: pts[i].x,
			s: [round2(pts[i].y)],
			i: lin,
			o: lin,
		})
	}
	return { a: 1, k: keys }
}

function round2(v) {
	return Math.round(v * 100) / 100
}

// ------------------------------------------------------------------
// Reading an existing opacity curve, so a computed visibility value can be
// MULTIPLIED into it rather than replacing it.
//
// A baked copy usually arrives with a static tr.o of 100, but a rig can carry
// its own animated opacity (a fade authored on the layer, or a hand-built
// export). A hidden copy with an animated opacity still needs to be hidden, and
// a visible copy should keep its authored curve. Multiplying per frame does
// both: the product is 0 wherever the computed value is 0, and follows the
// authored curve wherever the copy is fully visible.
// ------------------------------------------------------------------

// First component of a keyframe's value. Opacity is scalar, so the array holds
// one entry; tolerate a bare number as well.
function keyValue(key) {
	if (!key) return 100
	const s = key.s
	if (typeof s === 'number') return s
	if (Array.isArray(s) && typeof s[0] === 'number') return s[0]
	return 100
}

// Cubic-bezier ease solved by bisection, matching how players read keyframe
// eases. Mirrors the solver in precomps.js valueAt.
function easeValue(ox, oy, ix, iy, x) {
	const bz = (p1, p2, t) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
	let lo = 0
	let hi = 1
	let t = x
	for (let i = 0; i < 30; i++) {
		t = (lo + hi) / 2
		if (bz(ox, ix, t) < x) lo = t
		else hi = t
	}
	return bz(oy, iy, t)
}

// Sample a Lottie opacity property at a frame. Returns 100 when the property is
// absent or malformed, so a caller that only has a computed series still works.
export function opacityValueAt(prop, t) {
	if (!prop) return 100
	if (prop.a !== 1) {
		const v = Array.isArray(prop.k) ? prop.k[0] : prop.k
		return typeof v === 'number' ? v : 100
	}
	const k = prop.k
	if (!Array.isArray(k) || !k.length) return 100
	if (t <= k[0].t) return keyValue(k[0])
	for (let j = 0; j < k.length - 1; j++) {
		const a = k[j]
		const b = k[j + 1]
		if (t >= b.t) continue
		if (a.h === 1) return keyValue(a)
		const u = (t - a.t) / (b.t - a.t)
		const c = (q, f) => (q == null ? f : Array.isArray(q) ? (q[0] != null ? q[0] : f) : q)
		const ox = c(a.o && a.o.x, 0)
		const oy = c(a.o && a.o.y, 0)
		const ix = c(a.i && a.i.x, 1)
		const iy = c(a.i && a.i.y, 1)
		const e = easeValue(ox, oy, ix, iy, u)
		return keyValue(a) + (keyValue(b) - keyValue(a)) * e
	}
	return keyValue(k[k.length - 1])
}

// Apply per-index VALUE series (0..100 opacity, already combined from the
// deformers' visibility and opacity drivers) to shape groups.
//
// A series that only ever takes the values 0 and 100 is a gate, so it keeps the
// exact hold-key encoding (one key per flip, no interpolation between states).
// A series with intermediate values is a fade and gets the linear, thinned
// curve instead.
export function applyValuesToGroups(groups, valuesByGroup, frames, tolerance) {
	let changed = 0
	groups.forEach(function (g, gi) {
		const vals = valuesByGroup[gi]
		if (!vals || !vals.length) return
		let allFull = true
		let allZero = true
		let isGate = true
		for (let i = 0; i < vals.length; i++) {
			const v = vals[i]
			if (v === null || v === undefined) return // unknown sample: leave the copy alone
			if (v !== 100) allFull = false
			if (v !== 0) allZero = false
			if (v !== 0 && v !== 100) isGate = false
		}
		if (allFull) return
		const tr = trOf(g)
		if (!tr) return
		if (allZero) {
			g.hd = true
			changed++
			return
		}
		// An authored animated opacity is multiplied into, not replaced: the
		// computed value scales the existing curve per frame, so a hidden copy
		// goes to 0 and a visible copy keeps its authored fade.
		if (tr.o && tr.o.a === 1) {
			const combined = vals.map(function (v, i) {
				return (v * opacityValueAt(tr.o, frames[i].frame)) / 100
			})
			// The authored curve may itself be zero throughout, so the product can
			// be zero even when the computed series is not. That copy can never draw.
			let combinedZero = true
			let combinedGate = true
			for (let i = 0; i < combined.length; i++) {
				if (combined[i] !== 0) combinedZero = false
				if (combined[i] !== 0 && combined[i] !== 100) combinedGate = false
			}
			if (combinedZero) {
				g.hd = true
				changed++
				return
			}
			tr.o = combinedGate
				? maskToOpacityProp(combined.map(function (v) { return v === 100 ? 1 : 0 }), frames)
				: valuesToOpacityProp(combined, frames, tolerance)
			changed++
			return
		}
		tr.o = isGate
			? maskToOpacityProp(vals.map(function (v) { return v === 100 ? 1 : 0 }), frames)
			: valuesToOpacityProp(vals, frames, tolerance)
		changed++
	})
	return changed
}

// Compose one mask per deformer into the effective per-copy mask.
//
// A duplicator can carry several subMeshes in its `deformers` list, each
// driving shapeVisibility for the same copies. Measured against Cavalry's own
// renders (36 copies x 91 frames): a copy is visible only when EVERY driving
// deformer reports it visible — AND, not OR. Any deformer can cull a copy.
//
// masks: array of mask arrays (each `count` long). Returns null for an empty
// list (no deformer drives visibility, so nothing is known and nothing is
// injected).
function trOf(g) {
	const it = g.it || []
	for (let i = 0; i < it.length; i++) if (it[i].ty === 'tr') return it[i]
	return null
}

// Map copy index → baked group index by matching centres in comp space.
//
// The writer does NOT bake copies in the duplicator's index order. Measured on a
// plain 3x2 grid with no Sort node: the subMesh index order runs left→right
// within each row (x ascending), while the baked groups run right→left within
// each row (x descending). So pairing by ordinal position mis-assigns every copy
// of a horizontal row — 276/276 groups wrong on the Quiz BG rig.
//
// Any distribution that reorders ids (Sort, Shuffle, Array) makes ordinal
// pairing wrong by construction, so position is the only stable key.
//
// copyCentres: comp-space [x, y] per copy index (length = copy count).
// groupCentres: comp-space [x, y] per baked group, in JSON order.
// Returns an array `map` where map[index] = group index, or null when no group
// is close enough (a copy that was culled from the bake). Accuracy is checked
// greedily: the nearest unused group wins, so duplicates cannot claim one group.
export function pairByCentre(copyCentres, groupCentres) {
	if (!copyCentres || !groupCentres) return null
	const used = new Array(groupCentres.length).fill(false)
	const map = new Array(copyCentres.length).fill(null)
	for (let i = 0; i < copyCentres.length; i++) {
		const c = copyCentres[i]
		if (!c) continue
		let best = -1
		let bestD = Infinity
		for (let gi = 0; gi < groupCentres.length; gi++) {
			if (used[gi]) continue
			const g = groupCentres[gi]
			if (!g) continue
			const dx = g[0] - c[0]
			const dy = g[1] - c[1]
			const d = dx * dx + dy * dy
			if (d < bestD) {
				bestD = d
				best = gi
			}
		}
		if (best >= 0) {
			used[best] = true
			map[i] = best
		}
	}
	return map
}

// Pair centres from two coordinate frames. The Lottie writer flips y (a copy at
// Cavalry y -75 bakes at Lottie path y +75) and paths are relative to a layer
// anchor, so live Cavalry centres need flipY and both sets are shifted onto a
// common centroid before the nearest-centre match.
export function alignedPairs(src, dst, flipY) {
	if (!src || !dst) return null
	const mean = (pts) => {
		let x = 0, y = 0, n = 0
		for (const p of pts) if (p) { x += p[0]; y += p[1]; n++ }
		return n ? [x / n, y / n] : null
	}
	const s = src.map((p) => (p ? [p[0], flipY ? -p[1] : p[1]] : null))
	const ms = mean(s)
	const md = mean(dst)
	if (!ms || !md) return null
	const moved = s.map((p) => (p ? [p[0] - ms[0] + md[0], p[1] - ms[1] + md[1]] : null))
	return pairByCentre(moved, dst)
}

// Cycles per second of an oscillator config (BPM divides by 60, timeScale multiplies).
export function oscillatorCps(cfg) {
	const c = cfg || {}
	return (num(c.timeMode) === 1 ? num(c.frequency) / 60 : num(c.frequency)) * (c.timeScale ? num(c.timeScale) : 1)
}

// Recover a copy's oscillator timeOffset (seconds) from two measured outputs,
// v0 at frame 0 and v1 at frame dt. Only the Normal (sine) wave inverts
// uniquely, so anything else returns null. The returned value REPLACES
// cfg.timeOffset: it is the whole phase at t = 0.
export function oscillatorPhaseFromSamples(cfg, v0, v1, dt) {
	const c = cfg || {}
	if (num(c.waveType) !== 0 || num(c.trigType) === 2) return null
	const cps = oscillatorCps(c)
	const fps = num(c.fps) || 60
	const min = num(c.minimum)
	const span = num(c.maximum) - min
	const s = (c.strength == null ? 100 : num(c.strength)) / 100
	if (!cps || !span || !s || !dt) return null
	const plane = (v) => {
		const w = v - num(c.offset)
		return c.strengthToZero ? (w / s - min) / span : (w - min) / (span * s)
	}
	const unit = (v) => Math.max(-1, Math.min(1, 2 * plane(v) - 1))
	const d = (TAU * cps * dt) / fps
	if (Math.abs(Math.sin(d)) < 0.15) return null
	const y0 = unit(v0)
	const y1 = unit(v1)
	const theta = Math.atan2(y0, (y1 - y0 * Math.cos(d)) / Math.sin(d))
	const p0 = theta / TAU - (num(c.trigType) === 1 ? 0.25 : 0)
	return p0 / cps
}

// Frames between the two phase samples: a quarter cycle, capped so a slow
// oscillator does not make the probe bake long.
export function phaseSampleGap(cfg) {
	const cps = Math.abs(oscillatorCps(cfg))
	const fps = num(cfg && cfg.fps) || 60
	if (!cps) return 0
	return Math.max(1, Math.min(240, Math.round(fps / (4 * cps))))
}
