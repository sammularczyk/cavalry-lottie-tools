// Cavalry's Lottie writer drops an imageShader fill completely: a shape whose
// material.colorShaders holds one bakes as a flat `fl` of the material colour,
// and the file gets no image asset at all (measured on 2.8.1 under every
// forceLottieBake mode).
//
// The shader contributes only the image's own pixels, with the image's own
// alpha. Whatever sits behind a cell in a Cavalry render is the shape's material
// fill, which the writer already exports correctly as a vector fill. So the
// repair is additive: leave the baked shape layer exactly as written — it keeps
// its cells, transforms, parents and masks — and lay the shader's pixels over
// each copy as a real Lottie image.
//
// The image is not the source file: the shader scales, offsets and tiles it, and
// those parameters evaluate differently per comp (the same asset draws 2.8x
// larger in a throwaway comp than in the real one — measured). So the exporter
// captures the Shader fill IN CONTEXT at 1:1 and crops one lattice cell out of
// that capture (see imageBake.js), and this module repeats that cell over every
// copy. The cell is already clipped to the lattice, so no mask is needed here.
//
// One image layer per copy, all parented to a null that carries the original
// layer's transform: a group's `tr` lives in the shape layer's own space, so the
// copies are siblings of the shape layer inside a carrier with identical `ks`.
// The carrier and its images are inserted immediately before the shape layer,
// because Lottie paints the first array entry on top.
//
// This module works on parsed Lottie JSON only.

function trOf(group) {
	var it = (group && group.it) || []
	for (var i = 0; i < it.length; i++) if (it[i].ty === 'tr') return it[i]
	return null
}

// The `sh` path item of a baked copy group, or null.
function shOf(group) {
	var it = (group && group.it) || []
	for (var i = 0; i < it.length; i++) if (it[i].ty === 'sh') return it[i]
	return null
}

// Every copy group of a baked shape layer. The writer puts the copies straight
// into the layer's shape list as sibling `gr` items; a single container group
// that holds groups is unwrapped.
export function copyGroups(layer) {
	var shapes = (layer && layer.shapes) || []
	var groups = shapes.filter(function (g) { return g.ty === 'gr' })
	if (groups.length === 1 && (groups[0].it || []).some(function (s) { return s.ty === 'gr' })) {
		return groups[0].it.filter(function (s) { return s.ty === 'gr' })
	}
	return groups
}

function pair(v) {
	if (v && Array.isArray(v.k) && typeof v.k[0] === 'number') return [v.k[0], v.k[1] == null ? 0 : v.k[1]]
	return null
}

function clone(o) {
	return o == null ? o : JSON.parse(JSON.stringify(o))
}

// Bbox of a vertex list, or null.
function verticesBBox(v) {
	if (!Array.isArray(v) || !v.length) return null
	var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (var i = 0; i < v.length; i++) {
		if (!Array.isArray(v[i])) return null
		if (v[i][0] < x0) x0 = v[i][0]
		if (v[i][1] < y0) y0 = v[i][1]
		if (v[i][0] > x1) x1 = v[i][0]
		if (v[i][1] > y1) y1 = v[i][1]
	}
	return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

// Reference bbox of a copy's outline, in the group's own space.
//
// A keyframed path holds `ks.k[i].s = [{ i, o, v, c }]` — the vertex list is
// `s[0].v`, not `s` itself — while a static path holds `ks.k = { i, o, v, c }`.
//
// When a subMesh animates `shapeScale` (e.g. a spring pop-in from 0), Cavalry's
// writer bakes the scale into `sh.ks` vertices instead of `tr.s`: the first key
// is 0x0, a mid key overshoots (331.76), and the final key settles at the rest
// size (314.42). Prefer the LAST non-zero key so the reference size is the
// settled rest size rather than the spring overshoot; fall back to the largest
// key if the copy shrinks to 0 at the end.
function pathBBox(sh) {
	var ks = sh && sh.ks
	if (!ks) return null
	if (ks.a !== 1) {
		var sb = verticesBBox(ks.k && ks.k.v)
		return sb && sb.w * sb.h > 0 ? sb : null
	}
	var keys = ks.k || []
	var best = null
	var bestArea = -1
	var lastNonZero = null
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i]
		var list = [].concat((key && key.s) || [], (key && key.e) || [])
		for (var j = 0; j < list.length; j++) {
			var box = verticesBBox(list[j] && list[j].v)
			if (!box) continue
			var area = box.w * box.h
			if (area > bestArea) {
				bestArea = area
				best = box
			}
			if (area > 1e-3) lastNonZero = box
		}
	}
	return lastNonZero || (bestArea > 0 ? best : null)
}

// When `tr.s` is static 100% yet `sh.ks` animates its bbox size (subMesh
// `shapeScale` baked into path vertices by Cavalry's writer), synthesise the
// equivalent scale curve as `{ a: 1, k: [...] }` relative to `refBox` so the
// overlaid image grows and settles in lockstep with its cell instead of sitting
// at 100% over a 0-sized cell. Returns null when the path size is constant.
function pathScaleProp(sh, refBox) {
	var ks = sh && sh.ks
	if (!ks || ks.a !== 1 || !refBox || !(refBox.w > 0) || !(refBox.h > 0)) return null
	var keys = ks.k || []
	if (keys.length < 2) return null
	var raw = []
	var varies = false
	for (var i = 0; i < keys.length; i++) {
		var kf = keys[i]
		if (!kf || typeof kf.t !== 'number') continue
		var p = (kf.s && kf.s[0]) || (kf.e && kf.e[0])
		var box = verticesBBox(p && p.v)
		var sx = box ? (box.w / refBox.w) * 100 : 100
		var sy = box ? (box.h / refBox.h) * 100 : 100
		if (Math.abs(sx - 100) > 0.2 || Math.abs(sy - 100) > 0.2) varies = true
		raw.push({ t: kf.t, s: [sx, sy] })
	}
	if (!varies || raw.length < 2) return null
	// Collapse interior runs of identical scale values so a 1201-key path bake
	// only keeps the frames where the copy is actually scaling.
	var out = []
	for (var r = 0; r < raw.length; r++) {
		var prev = r > 0 ? raw[r - 1].s : null
		var cur = raw[r].s
		var next = r + 1 < raw.length ? raw[r + 1].s : null
		var samePrev = prev && Math.abs(cur[0] - prev[0]) < 1e-3 && Math.abs(cur[1] - prev[1]) < 1e-3
		var sameNext = next && Math.abs(cur[0] - next[0]) < 1e-3 && Math.abs(cur[1] - next[1]) < 1e-3
		if (samePrev && sameNext) continue
		var entry = { t: raw[r].t, s: cur }
		if (next) {
			entry.i = { x: [1, 1], y: [1, 1] }
			entry.o = { x: [0, 0], y: [0, 0] }
		}
		out.push(entry)
	}
	return out.length >= 2 ? { a: 1, k: out } : null
}

// Local lattice pitch `{ x, y }` measured from the copy centres of a baked
// shape layer, or `{ x: 0, y: 0 }` when there is only one column/row.
function groupPitch(groups) {
	var xs = []
	var ys = []
	groups.forEach(function (g) {
		var tr = trOf(g)
		var box = pathBBox(shOf(g))
		if (!tr || !box) return
		var anchor = pair(tr.a) || [box.cx, box.cy]
		var p = tr.p
		var pk = pair(p)
		if (!pk && p && p.a === 1 && p.k && p.k[0] && Array.isArray(p.k[0].s)) {
			pk = [p.k[0].s[0], p.k[0].s[1] == null ? 0 : p.k[0].s[1]]
		}
		if (!pk) pk = anchor
		xs.push(pk[0] + (box.cx - anchor[0]))
		ys.push(pk[1] + (box.cy - anchor[1]))
	})
	function axis(vals) {
		if (vals.length < 2) return 0
		var sorted = vals.slice().sort(function (a, b) { return a - b })
		var clusters = []
		for (var i = 0; i < sorted.length; i++) {
			if (!clusters.length || sorted[i] - clusters[clusters.length - 1].last > 1) {
				clusters.push({ sum: sorted[i], n: 1, last: sorted[i] })
			} else {
				var c = clusters[clusters.length - 1]
				c.sum += sorted[i]
				c.n++
				c.last = sorted[i]
			}
		}
		if (clusters.length < 2) return 0
		var diffs = []
		for (var j = 1; j < clusters.length; j++) {
			diffs.push(clusters[j].sum / clusters[j].n - clusters[j - 1].sum / clusters[j - 1].n)
		}
		diffs.sort(function (a, b) { return a - b })
		return diffs[Math.floor(diffs.length / 2)]
	}
	return { x: axis(xs), y: axis(ys) }
}

// A scale property multiplied by k, key by key when it is animated. The copy
// group's own scale animates (the grid grows from 0 to full size over a few
// frames), so the image has to carry that same curve, not just its final size.
function scaleTimes(prop, k) {
	var out = clone(prop) || { a: 0, k: [100, 100] }
	if (out.a === 1) {
		;(out.k || []).forEach(function (key) {
			if (Array.isArray(key.s)) key.s = [key.s[0] * k, key.s[1] * k]
			if (Array.isArray(key.e)) key.e = [key.e[0] * k, key.e[1] * k]
		})
		return out
	}
	var v = out.k
	if (Array.isArray(v) && typeof v[0] === 'number') return { a: 0, k: [v[0] * k, v[1] * k] }
	return { a: 0, k: [100 * k, 100 * k] }
}

// The same position property, shifted by dx/dy. A keyframed property is shifted
// key by key, because a static offset on an animated property would drift.
function shiftPosition(prop, dx, dy) {
	var out = clone(prop) || { a: 0, k: [0, 0] }
	if (!dx && !dy) return out
	if (out.a === 1) {
		;(out.k || []).forEach(function (k) {
			if (Array.isArray(k.s)) k.s = [k.s[0] + dx, k.s[1] + dy]
			if (Array.isArray(k.e)) k.e = [k.e[0] + dx, k.e[1] + dy]
		})
		return out
	}
	var v = out.k
	if (Array.isArray(v) && typeof v[0] === 'number') out.k = [v[0] + dx, v[1] + dy]
	else out.k = [dx, dy]
	return out
}

function assetFor(json, job) {
	var base = job.assetId || 'imgfill'
	var w = Math.max(1, Math.round(job.assetW))
	var h = Math.max(1, Math.round(job.assetH))
	var u = job.assetU == null ? '' : job.assetU
	var p = job.assetP
	var e = job.assetE != null ? job.assetE : 0
	// Reuse an existing identical image asset so two duplicators sharing the
	// same baked cell image produce one asset and one file on disk.
	var existing = (json.assets || []).find(function (a) {
		return !a.layers && a.w === w && a.h === h && (a.u || '') === u && a.p === p && (a.e || 0) === e
	})
	if (existing) return existing.id
	var used = {}
	;(json.assets || []).forEach(function (a) { used[a.id] = true })
	var id = base
	var n = 1
	while (used[id]) id = base + '_' + n++
	var asset = {
		id: id,
		w: w,
		h: h,
		u: u,
		p: p,
		e: e
	}
	json.assets.push(asset)
	return id
}

// Every layer list in the document: the root plus each comp asset.
function allLayerLists(json) {
	var lists = []
	if (json.layers && json.layers.length) lists.push({ owner: json, layers: json.layers })
	;(json.assets || []).forEach(function (a) {
		if (a.layers && a.layers.length) lists.push({ owner: a, layers: a.layers })
	})
	return lists
}

// Which layer a job belongs to: by name when the writer kept one, otherwise by
// the copy count the duplicator produced. The writer emits no names at all
// (measured: every exported layer has `nm: undefined`), so the count is the only
// stable handle.
function pickLayer(candidates, job) {
	if (job.layerName) {
		var named = candidates.filter(function (L) { return L.nm === job.layerName })
		if (named.length === 1) return named[0]
	}
	if (!job.copyCount) return null
	var counted = candidates.filter(function (L) { return copyGroups(L).length === job.copyCount })
	if (counted.length === 1) return counted[0]
	if (counted.length > 1 && job.cellW) {
		var sized = counted.filter(function (L) {
			var box = pathBBox(shOf(copyGroups(L)[0]))
			return box && Math.abs(box.w - job.cellW) < 1
		})
		if (sized.length === 1) return sized[0]
	}
	// A duplicator with culled copies (e.g. skipInvisibleDuplicates or a subMesh
	// gate) bakes fewer groups than grid.x * grid.y. Allow an under-count match
	// only when the job opts in via `allowUnderCount` (or matches `cellW`), so an
	// unrelated 3-copy layer is never hijacked by a 99-copy job.
	if (counted.length === 0 && (job.allowUnderCount || job.cellW)) {
		var minGroups = job.copyCount > 1 ? 2 : 1
		var under = candidates.filter(function (L) {
			var n = copyGroups(L).length
			return n >= minGroups && n <= job.copyCount
		})
		if (job.cellW) {
			var sizedUnder = under.filter(function (L) {
				var box = pathBBox(shOf(copyGroups(L)[0]))
				return box && Math.abs(box.w - job.cellW) < 1
			})
			if (sizedUnder.length === 1) return sizedUnder[0]
		}
		if (job.allowUnderCount && under.length === 1) return under[0]
	}
	return null
}

// Match each job to a layer once, in order, so two jobs never claim the same one.
// A copy layer can live in any comp asset, because the grid is a precomp.
function resolveJobs(json, jobs, notes) {
	var lists = allLayerLists(json)
	var taken = {}
	var pairs = []
	jobs.forEach(function (job) {
		var hit = null
		for (var i = 0; i < lists.length && !hit; i++) {
			var candidates = lists[i].layers.filter(function (L) {
				return L.ty === 4 && !taken[lists[i].owner === json ? 'r' + L.ind : L.ind] && copyGroups(L).length > 0
			})
			hit = pickLayer(candidates, job)
			if (hit) {
				lists[i].owner === json ? (taken['r' + hit.ind] = true) : (taken[hit.ind] = true)
				pairs.push({ job: job, layer: hit, owner: lists[i] })
			}
		}
		if (!hit) notes.push('image fill: no baked copy layer matches ' + (job.layerName || job.copyCount + ' copies') + '; its fill stays flat')
	})
	return pairs
}

// Multiply a group's opacity property by a 0/100 hold-keyed gate (or static 0/100).
// When the gate is constantly 0, returns null so the caller can skip the copy.
// When the gate is constantly 100, returns the original opacity unchanged.
function multiplyGateOpacity(baseProp, gateProp) {
	if (!gateProp) return baseProp ? clone(baseProp) : { a: 0, k: 100 }
	if (gateProp.a !== 1) {
		var gv = Number(gateProp.k)
		if (!(gv > 0)) return null
		if (gv >= 100) return baseProp ? clone(baseProp) : { a: 0, k: 100 }
		return { a: 0, k: gv }
	}
	var gkeys = gateProp.k || []
	if (!gkeys.length) return baseProp ? clone(baseProp) : { a: 0, k: 100 }
	var allZero = gkeys.every(function (k) { return !(Number(k.s && k.s[0]) > 0) })
	if (allZero) return null
	var allFull = gkeys.every(function (k) { return Number(k.s && k.s[0]) >= 100 })
	if (allFull) return baseProp ? clone(baseProp) : { a: 0, k: 100 }
	// If base opacity is static 100 (or absent), the gate curve is the exact result.
	if (!baseProp || (baseProp.a !== 1 && Number(baseProp.k) >= 100)) return clone(gateProp)
	if (baseProp.a !== 1) {
		var bv = Number(baseProp.k)
		if (!(bv > 0)) return null
		return {
			a: 1,
			k: gkeys.map(function (k) {
				var out = clone(k)
				out.s = [Math.round((Number(k.s && k.s[0]) || 0) * bv) / 100]
				return out
			})
		}
	}
	// Both animated: sample at the union of key times with hold interpolation on the gate.
	var times = []
	var seen = {}
	;(baseProp.k || []).forEach(function (k) { if (typeof k.t === 'number' && !seen[k.t]) { seen[k.t] = 1; times.push(k.t) } })
	gkeys.forEach(function (k) { if (typeof k.t === 'number' && !seen[k.t]) { seen[k.t] = 1; times.push(k.t) } })
	times.sort(function (a, b) { return a - b })
	var holdAt = function (keys, t) {
		var v = Number(keys[0] && keys[0].s && keys[0].s[0]) || 0
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].t <= t) v = Number(keys[i].s && keys[i].s[0]) || 0
			else break
		}
		return v
	}
	var baseAt = function (keys, t) {
		if (!keys.length) return 100
		if (t <= keys[0].t) return Number(keys[0].s && keys[0].s[0]) || 0
		for (var i = 0; i < keys.length - 1; i++) {
			var k0 = keys[i], k1 = keys[i + 1]
			if (t <= k1.t) {
				var v0 = Number(k0.s && k0.s[0]) || 0
				if (k0.h === 1 || k1.t === k0.t) return v0
				var v1 = Number(k1.s && k1.s[0]) || 0
				return v0 + (v1 - v0) * ((t - k0.t) / (k1.t - k0.t))
			}
		}
		var last = keys[keys.length - 1]
		return Number(last.s && last.s[0]) || 0
	}
	var merged = []
	for (var ti = 0; ti < times.length; ti++) {
		var t = times[ti]
		var val = Math.round((baseAt(baseProp.k || [], t) * holdAt(gkeys, t)) / 100)
		var prev = merged.length ? merged[merged.length - 1].s[0] : null
		if (prev === val) continue
		merged.push({ t: t, s: [val], h: 1 })
	}
	if (!merged.length || merged.every(function (k) { return k.s[0] <= 0 })) return null
	if (merged.length === 1) return { a: 0, k: merged[0].s[0] }
	return { a: 1, k: merged }
}

// Resolve `job.copyAssetIndex` and `job.copyOpacity` from raw probe-measured
// `arrayIndex` / `shapeId` records (each `{ frames, copies: [{ c, v, vs }] }`),
// paired to the target layer's baked copy groups by centre coordinate.
// Uses the same coordinate-matching rule as submeshVisibility (`alignedPairs`).
function resolveMeasuredCopies(groups, job) {
	if (!job.measuredArrayIndex && !job.measuredShapeId) return { copyAssetIndex: job.copyAssetIndex, copyOpacity: job.copyOpacity }
	var groupCentres = groups.map(function (g) {
		var tr = trOf(g)
		var box = pathBBox(shOf(g))
		if (!tr || !box) return null
		var anchor = pair(tr.a) || [box.cx, box.cy]
		var pk = pair(tr.p)
		if (!pk && tr.p && tr.p.a === 1 && tr.p.k && tr.p.k[0] && Array.isArray(tr.p.k[0].s)) {
			pk = [tr.p.k[0].s[0], tr.p.k[0].s[1] == null ? 0 : tr.p.k[0].s[1]]
		}
		if (!pk) pk = anchor
		return [pk[0] + (box.cx - anchor[0]), pk[1] + (box.cy - anchor[1])]
	})
	// Align source copy centres (from probe bake, already in Lottie Y-down space)
	// to target group centres by centroid shift + greedy nearest match.
	var pairProbe = function (copies) {
		var src = copies.map(function (c) { return c.c })
		var validS = src.filter(Boolean)
		var validD = groupCentres.filter(Boolean)
		if (!validS.length || !validD.length) return null
		var scx = 0, scy = 0, dcx = 0, dcy = 0
		validS.forEach(function (p) { scx += p[0]; scy += p[1] })
		validD.forEach(function (p) { dcx += p[0]; dcy += p[1] })
		var dx = dcx / validD.length - scx / validS.length
		var dy = dcy / validD.length - scy / validS.length
		var pairs = []
		for (var i = 0; i < src.length; i++) {
			if (!src[i]) continue
			var sx = src[i][0] + dx, sy = src[i][1] + dy
			for (var j = 0; j < groupCentres.length; j++) {
				if (!groupCentres[j]) continue
				var ex = sx - groupCentres[j][0], ey = sy - groupCentres[j][1]
				pairs.push({ i: i, j: j, d2: ex * ex + ey * ey })
			}
		}
		pairs.sort(function (a, b) { return a.d2 - b.d2 })
		var map = new Array(src.length).fill(null)
		var used = {}
		for (var k = 0; k < pairs.length; k++) {
			var p = pairs[k]
			if (map[p.i] !== null || used[p.j]) continue
			map[p.i] = p.j
			used[p.j] = true
		}
		return map
	}

	var copyAssetIndex = job.copyAssetIndex
	if (!copyAssetIndex && job.measuredArrayIndex && Array.isArray(job.measuredArrayIndex.copies)) {
		var count = Array.isArray(job.assets) ? job.assets.length : 1
		var mp = pairProbe(job.measuredArrayIndex.copies)
		if (mp && count > 0) {
			copyAssetIndex = new Array(groups.length).fill(null)
			mp.forEach(function (gi, ci) {
				if (gi === null) return
				var raw = Math.round(job.measuredArrayIndex.copies[ci].v)
				var wrapped = ((raw % count) + count) % count
				copyAssetIndex[gi] = job.assetArrayReverse ? (count - 1 - wrapped) : wrapped
			})
		}
	}

	var copyOpacity = job.copyOpacity
	if (!copyOpacity && job.measuredShapeId && Array.isArray(job.measuredShapeId.copies) && typeof job.shapeSlot === 'number' && job.shapeSlot >= 0) {
		var mframes = job.measuredShapeId.frames || [0]
		var sp = pairProbe(job.measuredShapeId.copies)
		if (sp) {
			copyOpacity = new Array(groups.length).fill(null)
			sp.forEach(function (gi, ci) {
				if (gi === null) return
				var copy = job.measuredShapeId.copies[ci]
				var vs = Array.isArray(copy.vs) && copy.vs.length ? copy.vs : [copy.v]
				var keys = []
				for (var fi = 0; fi < vs.length; fi++) {
					var on = Math.round(vs[fi]) === job.shapeSlot ? 100 : 0
					var prev = keys.length ? keys[keys.length - 1].s[0] : null
					if (prev === on) continue
					keys.push({ t: mframes[fi] != null ? mframes[fi] : 0, s: [on], h: 1 })
				}
				if (keys.length === 1) copyOpacity[gi] = { a: 0, k: keys[0].s[0] }
				else if (keys.length > 1) copyOpacity[gi] = { a: 1, k: keys }
			})
		}
	}
	return { copyAssetIndex: copyAssetIndex, copyOpacity: copyOpacity }
}

// Lay one baked cell over every copy of the layer each job names.
//
// jobs: [{ assetId, assetW, assetH, assetU, assetP, assetE?, layerName?,
//          copyCount?, cellW? }]
// -> { changed, layers, notes }
//
// The image layers go in BEFORE the shape layer they decorate: Lottie paints the
// first array entry on top, so the cell image covers the flat fill and the flat
// fill still covers whatever the shape layer covered.
export function applyImageFills(json, jobs) {
	var notes = []
	if (!jobs || !jobs.length) return { changed: 0, layers: [], notes: notes }
	if (!json.assets) json.assets = []

	var pairs = resolveJobs(json, jobs, notes)
	if (!pairs.length) return { changed: 0, layers: [], notes: notes }

	var lists = allLayerLists(json)
	var nextInd = 1
	lists.forEach(function (list) {
		list.layers.forEach(function (L) { if (L.ind >= nextInd) nextInd = L.ind + 1 })
	})

	var changed = 0
	var made = []

	pairs.forEach(function (hit) {
		var layer = hit.layer
		var job = hit.job
		var groups = copyGroups(layer)
		var assetSpecs = Array.isArray(job.assets) && job.assets.length
			? job.assets.map(function (a) {
				return {
					id: assetFor(json, a),
					w: Math.max(1, Math.round(a.assetW)),
					h: Math.max(1, Math.round(a.assetH))
				}
			})
			: [{
				id: assetFor(json, job),
				w: Math.max(1, Math.round(job.assetW)),
				h: Math.max(1, Math.round(job.assetH))
			}]

		// The carrier reproduces the shape layer's own transform so the group
		// coordinates resolve exactly as they did inside it.
		var carrier = {
			ind: nextInd++,
			nm: (layer.nm || 'image fill') + ' carrier',
			ty: 3,
			ip: layer.ip,
			op: layer.op,
			st: layer.st || 0,
			sr: layer.sr != null ? layer.sr : 1,
			ks: clone(layer.ks || {}),
			shapes: []
		}
		if (layer.parent != null) carrier.parent = layer.parent
		if (layer.tt) carrier.tt = layer.tt
		if (layer.td) carrier.td = layer.td

		var pitch = job.spansPitch ? groupPitch(groups) : { x: 0, y: 0 }
		var resolved = resolveMeasuredCopies(groups, job)
		var copyAssetIndex = resolved.copyAssetIndex
		var copyOpacity = resolved.copyOpacity
		var block = [carrier]
		var placed = 0
		groups.forEach(function (g, gi) {
			// A copy culled across the whole timeline is marked `g.hd = true` by
			// `applyValuesToGroups` while leaving `tr.o` at 100. Creating an image
			// layer for it would paint a permanently visible copy where the grid
			// has a hole (measured: one floating mango in the middle of the card).
			if (g && g.hd) return
			var tr = trOf(g)
			var sh = shOf(g)
			var box = pathBBox(sh)
			if (!tr || !box) return
			var specIdx = Array.isArray(copyAssetIndex) && typeof copyAssetIndex[gi] === 'number'
				? copyAssetIndex[gi]
				: placed % assetSpecs.length
			if (specIdx < 0 || specIdx >= assetSpecs.length) return
			var gateProp = Array.isArray(copyOpacity) ? copyOpacity[gi] : null
			var opacityProp = multiplyGateOpacity(tr.o, gateProp)
			if (!opacityProp) return
			var spec = assetSpecs[specIdx]
			var assetW = spec.w
			var assetH = spec.h
			var anchor = pair(tr.a) || [box.cx, box.cy]
			// The group anchors at its own centre and the image anchors at its
			// own centre, so the distance between the two centres is the only
			// correction the image position needs.
			var pos = shiftPosition(tr.p || { a: 0, k: [anchor[0], anchor[1]] }, box.cx - anchor[0], box.cy - anchor[1])
			// When `job.spansPitch` is true, `assetW x assetH` is one full lattice
			// pitch (gutter midpoint to gutter midpoint), so it spans the local
			// pitch rather than the inner rounded-rect outline (`box.w < pitch`).
			var spanW = pitch.x > 0 ? pitch.x : box.w
			var spanH = pitch.y > 0 ? pitch.y : box.h
			var fit = Math.min(spanW / assetW, spanH / assetH) * 100
			var baseScale = (tr.s && tr.s.a === 1) ? tr.s : (pathScaleProp(sh, box) || tr.s)
			block.push({
				ind: nextInd++,
				nm: (layer.nm || 'image fill') + ' ' + (placed + 1),
				ty: 2,
				refId: spec.id,
				parent: carrier.ind,
				ip: layer.ip,
				op: layer.op,
				st: layer.st || 0,
				sr: layer.sr != null ? layer.sr : 1,
				ks: {
					p: pos,
					a: { a: 0, k: [assetW / 2, assetH / 2] },
					s: scaleTimes(baseScale, fit / 100),
					r: tr.r ? clone(tr.r) : { a: 0, k: 0 },
					o: opacityProp
				}
			})
			placed++
		})

		if (!placed) {
			notes.push('image fill: ' + (layer.nm || 'layer ' + layer.ind) + ' has no usable copy outline; its fill stays flat')
			return
		}
		if (layer.masksProperties && layer.masksProperties.length) notes.push('image fill: ' + (layer.nm || 'layer ' + layer.ind) + ' carries masks the images do not reproduce')

		var list = hit.owner.layers
		var at = list.indexOf(layer)
		if (at < 0) return
		list.splice.apply(list, [at, 0].concat(block))
		changed++
		made.push({ layer: layer.ind, assetId: assetSpecs[0].id, assetIds: assetSpecs.map(function (s) { return s.id }), copies: placed })
	})

	return { changed: changed, layers: made, notes: notes }
}
