// Standalone duplicator restructure for Lottie JSON.
// Works on any parsed Lottie JSON — no Cavalry api.* dependencies.
//
// For each duplicator pattern (shape layer with 20+ shape groups):
// 1. Identify the duplicator shape layer
// 2. Extract ONE shared shape from the first copy (SubMesh distortion baked in)
// 3. Create a precomp with that shared shape + keep all transforms
// 4. Replace each copy's shape layer with a ty:0 ref layer pointing to the precomp
// 5. Keep all original transform data (position, scale, rotation, opacity, keyframes) on the ref layers
//
// This optimises the shared static shape that SubMesh distorts identically on all copies.
// Animation data is preserved as-is on each ref layer.

export function restructureDuplicators(json, opts) {
	opts = opts || {}
	if (!opts.duplicators) return 0

	var changed = 0
	var saved = 0

	// Guard: JSON must have layers
	if (!json || !Array.isArray(json.layers)) return 0

	// 1. Find duplicator shape layers by counting shape groups
	for (var li = 0; li < json.layers.length; li++) {
		if (json.layers[li].ty !== 4) continue

		var layer = json.layers[li]
		var shps = layer.shapes || []

		// Count all shape groups at any depth
		var grpCount = 0
		function countGroups(items) {
			for (var i = 0; i < (items || []).length; i++) {
				var item = items[i]
				if (item.ty === 'gr' || item.ty === 'ms') {
					grpCount++
					countGroups(item.it)
				}
			}
		}
		countGroups(shps)

		// Heuristic: >20 shape groups suggests a duplicator
		if (grpCount < 20) continue

		// 2. Collect all shape groups at all depths
		var allGroups = []
		function collectGroups(items) {
			for (var i = 0; i < (items || []).length; i++) {
				var item = items[i]
				if (item.ty === 'gr' || item.ty === 'ms') {
					allGroups.push(item)
					collectGroups(item.it)
				}
			}
		}
		collectGroups(shps)

		// Filter to groups with a transform (position attribute)
		var groupsWithTr = []
		for (var gi = 0; gi < allGroups.length; gi++) {
			var g = allGroups[gi]
			var tr = null
			for (var ti = 0; ti < (g.it || []).length; ti++) {
				if (g.it[ti].ty === 'tr') { tr = g.it[ti]; break }
			}
			if (tr) groupsWithTr.push({ group: g, tr: tr })
		}

		if (groupsWithTr.length < 20) continue

		// 3. Find the first group that has both a shape (sh) and fill (fl)
		var srcGroup = null
		for (var fi = 0; fi < allGroups.length; fi++) {
			var g = allGroups[fi]
			var hasSh = false, hasFl = false
			for (var si = 0; si < (g.it || []).length; si++) {
				var child = g.it[si]
				if (child.ty === 'sh') hasSh = true
				if (child.ty === 'fl') hasFl = true
			}
			if (hasSh && hasFl) { srcGroup = g; break }
		}
		if (!srcGroup) continue

		// 4. Extract shared shape and fill
		var srcShape = null, srcFill = null
		for (var xsi = 0; xsi < (srcGroup.it || []).length; xsi++) {
			var child = srcGroup.it[xsi]
			if (child.ty === 'sh') srcShape = JSON.parse(JSON.stringify(child))
			if (child.ty === 'fl') srcFill = JSON.parse(JSON.stringify(child))
		}
		if (!srcShape || !srcFill) continue

		// 5. Extract transform from source group (first real copy, not container)
		var srcTr = null
		for (var sti = 0; sti < (srcGroup.it || []).length; sti++) {
			if (srcGroup.it[sti].ty === 'tr') { srcTr = srcGroup.it[sti]; break }
		}
		if (!srcTr) continue

		// Extract transform values (handle both static and animated)
		function cloneTransform(t) {
			if (!t) return null
			var out = {}
			for (var k in t) {
				if (t.hasOwnProperty(k)) {
					out[k] = JSON.parse(JSON.stringify(t[k]))
				}
			}
			return out
		}

		var srcP = cloneTransform(srcTr.p)
		var srcS = cloneTransform(srcTr.s)
		var srcR = cloneTransform(srcTr.r)
		var srcO = cloneTransform(srcTr.o)
		var srcA = cloneTransform(srcTr.a)

		// 6. Create precomp with shared shapes and static transform at origin
		var precompNid = 'precomp_dup_' + (changed + 1)
		if (!json.assets) json.assets = []

		var frameStart = (json.ip != null ? json.ip : 1)
		var frameEnd = (json.op != null ? json.op : 1)
		var frameRate = (json.fr || 30)

		var precomp = {
			ids: precompNid,
			nm: 'Duplicator_' + (changed + 1) + '_precomp',
			ty: 2,
			w: Number(json.w) || 1920,
			h: Number(json.h) || 1080,
			st: Number(json.st) || 0,
			sr: Number(json.sr) || 1,
			ip: Number(frameStart),
			op: Number(frameEnd),
			fr: Number(frameRate),
			bgColor: (json.bgColor && Array.isArray(json.bgColor) ? json.bgColor : [0, 0, 0, 1]),
			layers: [{
				ind: 1,
				nm: 'shared',
				ty: 4,
				ip: Number(frameStart),
				op: Number(frameEnd),
				st: Number(json.st) || 0,
				sr: Number(json.sr) || 1,
				ks: {
					p: srcP || { a: 0, k: [0, 0] },
					s: srcS || { a: 0, k: [100, 100, 100] },
					r: srcR || { a: 0, k: 0 },
					o: srcO || { a: 0, k: 100 },
					a: srcA || null
				},
				shapes: {
					ty: 'gr',
					it: [
						srcShape,
						srcFill,
						{
							ty: 'tr',
							p: { a: 0, k: [0, 0] },
							s: { a: 0, k: [100, 100, 100] },
							r: { a: 0, k: 0 },
							o: { a: 0, k: 100 },
							a: null
						}
					]
				}
			}]
		}

		json.assets.push(precomp)

		// 7. Create ref layers for each copy
		var newLayers = []
		for (var ni = 0; ni < groupsWithTr.length; ni++) {
			var entry = groupsWithTr[ni]
			var tr = entry.tr

			// Build transform: use original animated values as-is
			var trP = tr.p ? JSON.parse(JSON.stringify(tr.p)) : { a: 0, k: [0, 0, 0] }
			var trS = (tr.s ? JSON.parse(JSON.stringify(tr.s)) : { a: 0, k: [100, 100, 100] })
			var trR = (tr.r ? JSON.parse(JSON.stringify(tr.r)) : { a: 0, k: 0 })
			var trO = (tr.o ? JSON.parse(JSON.stringify(tr.o)) : { a: 0, k: 100 })
			var trA = (tr.a ? JSON.parse(JSON.stringify(tr.a)) : null)

			newLayers.push({
				ind: ni + 1,
				nm: 'copy_' + ni,
				ty: 0,
				ip: Number(frameStart),
				op: Number(frameEnd),
				st: Number(json.st) || 0,
				sr: Number(json.sr) || 1,
				refId: precompNid,
				ks: {
					p: trP,
					s: trS,
					r: trR,
					o: trO,
					a: trA
				}
			})
		}

		// 8. Replace the shape layer with ref layers
		for (var ri = 0; ri < json.layers.length; ri++) {
			if (json.layers[ri] === layer) {
				json.layers.splice(ri, 1)
				for (var nl = 0; nl < newLayers.length; nl++) {
					json.layers.splice(ri + nl, 0, newLayers[nl])
				}
				break
			}
		}

		// Count keyframe savings: original had animated position on each copy
		// Now each ref layer keeps its original position animation (so no keys lost from position)
		// But we saved: (groups.length - 1) * shape data per copy
		var numShapesPerCopy = 1
		saved += groupsWithTr.length * numShapesPerCopy
		changed++
	}

	// 9. Clean up unused assets
	if (changed && json.assets && json.assets.length) {
		var usedIds = {}
		json.layers.forEach(function (L) {
			if (L.refId != null) usedIds[L.refId] = true
		})
		var cleanedAssets = json.assets.filter(function (a) { return usedIds[a.ids] })
		json.assets = cleanedAssets
	}

	return changed
}
