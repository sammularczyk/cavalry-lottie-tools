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

// Full mask for an expression across count indices: truthy → 1, else 0.
// Returns null when the expression is unpure or fails to evaluate — unknown.
export function expressionMask(expr, count) {
	if (!expressionIsIndexPure(expr)) return null
	const mask = new Array(count).fill(0)
	for (let i = 0; i < count; i++) {
		let v
		try {
			v = evalIndexExpression(expr, i, count)
		} catch (e) {
			return null
		}
		mask[i] = v ? 1 : 0
	}
	return mask
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
export function maskToOpacityProp(mask, frames) {
	const keys = []
	for (let f = 0; f < mask.length; f++) {
		keys.push({
			t: frames[f].frame,
			s: [mask[f] ? 100 : 0],
			i: { x: [1], y: [1] },
			o: { x: [0], y: [0] },
		})
	}
	return { a: 1, k: keys }
}

// Apply per-index masks to shape groups.
// masksByGroup: Map (or plain object) groupIndex → mask array (aligned with `frames`).
// groups: the ordered group list the indices refer to. Mutates groups in place.
// Returns the number of groups changed.
export function applyMasksToGroups(groups, masksByGroup, frames) {
	let changed = 0
	groups.forEach(function (g, gi) {
		const mask = masksByGroup[gi]
		if (!mask) return
		if (mask.length && mask.every(function (v) { return v === 1 })) return
		const tr = trOf(g)
		if (!tr) return
		if (mask.length && mask.every(function (v) { return v === 0 })) {
			g.hd = true
			changed++
			return
		}
		if (tr.o && tr.o.a === 1) return // already animated — leave it alone
		tr.o = maskToOpacityProp(mask, frames)
		changed++
	})
	return changed
}

function trOf(g) {
	const it = g.it || []
	for (let i = 0; i < it.length; i++) if (it[i].ty === 'tr') return it[i]
	return null
}
