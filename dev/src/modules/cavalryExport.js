// Export a comp with Cavalry's own Lottie writer, through a temporary Render Queue Item.
// The scene is left as it was: bake overrides are restored and the queue item deleted.

// forceLottieBake values, in Cavalry's order.
export var BAKE_MODES = ['Automatic', 'Animated Mesh', 'Animated Mesh & Materials', 'Nuclear', 'Still']

// Every layer under a comp (getChildren returns direct children only).
export function compLayers(compId) {
	var out = []
	var walk = function (id) {
		api.getChildren(id).forEach(function (c) {
			out.push(c)
			walk(c)
		})
	}
	walk(compId)
	return out
}

// Cavalry's writer drops a fill or stroke fed by a Shader Array (it writes the bare colour,
// often transparent or white). Find the shader each array actually shows: the index a
// precomp override on refId sets, else the array's own. -> [{ shape, path, arr, shader }]
export function shaderArrayPicks(compId, refId) {
	var picks = []
	compLayers(compId).forEach(function (shape) {
		;['material', 'stroke'].forEach(function (slot) {
			for (var i = 0; api.hasAttribute(shape, slot + '.colorShaders.' + i + '.shader'); i++) {
				var path = slot + '.colorShaders.' + i + '.shader'
				var arr = (api.getInConnection(shape, path) || '').split('.')[0]
				if (!arr || api.getLayerType(arr) !== 'shaderArray') continue
				var shader = arrayPick(arr, compId, refId)
				if (shader) picks.push({ shape: shape, path: path, arr: arr, shader: shader })
			}
		})
	})
	return picks
}

// The shader a shape's first fill (or stroke: slot 'stroke') shader slot shows, through any Shader Array.
export function fillShader(shape, compId, refId, slot) {
	var path = (slot || 'material') + '.colorShaders.0.shader'
	if (!api.hasAttribute(shape, path)) return null
	var src = (api.getInConnection(shape, path) || '').split('.')[0]
	if (src && api.getLayerType(src) === 'shaderArray') src = arrayPick(src, compId, refId)
	return src || null
}

function arrayPick(arr, compId, refId) {
	if (api.get(arr, 'autoIndex')) return null // ponytail: auto index (duplicator-driven) left to Cavalry
	var index = overrideFor(arr, 'arrayIndex', compId, refId)
	if (index == null) index = api.get(arr, 'arrayIndex')
	return (api.getInConnection(arr, 'array.' + index) || '').split('.')[0] || null
}

// The value a comp reference's precomp override gives layer.attr, or null.
function overrideFor(layer, attr, compId, refId) {
	if (!refId) return null
	var exposed = (api.getOutConnections(layer, attr) || []).filter(function (c) {
		return c.indexOf(compId + '.overrides.') === 0
	})[0]
	if (!exposed) return null
	for (var i = 0; api.hasAttribute(refId, 'overrides.' + i); i++) {
		var o = 'overrides.' + i
		if (api.getInConnection(refId, o + '.attribute') === exposed && api.get(refId, o + '.enabled')) return api.get(refId, o + '.int')
	}
	return null
}

// opts: { bakeMode: null | 0..4, ref: compositionReference id it's exported for }  -> { json, text, dir, file, baked: [ids] }
export function exportComp(compId, opts) {
	opts = opts || {}
	var dir = api.getTempFolder() + '/lottie-tools-' + new Date().getTime()
	api.makeFolder(dir)
	var restore = []
	var rewired = []
	var rq = null
	var frame = api.getFrame() // rendering moves the playhead
	try {
		shaderArrayPicks(compId, opts.ref).forEach(function (p) {
			api.connect(p.shader, 'id', p.shape, p.path, true) // force swaps the source in place; disconnecting drops the list entry
			rewired.push(p)
		})
		if (opts.bakeMode != null) {
			compLayers(compId).forEach(function (id) {
				if (!api.hasAttribute(id, 'forceLottieBake')) return
				var was = api.get(id, 'forceLottieBake')
				if (was === opts.bakeMode) return
				restore.push([id, was])
				api.set(id, { forceLottieBake: opts.bakeMode })
			})
		}
		rq = api.addRenderQueueItem(compId)
		api.setGenerator(rq, 'generator', 'renderLottie')
		api.set(rq, { filePath: dir, fileName: 'export', frameRangeMode: 0 })
		api.render(rq)
	} finally {
		api.setFrame(frame)
		rewired.forEach(function (p) {
			api.connect(p.arr, 'id', p.shape, p.path, true)
		})
		restore.forEach(function (r) {
			try {
				api.set(r[0], { forceLottieBake: r[1] })
			} catch (e) {}
		})
		if (rq) {
			try {
				api.deleteLayer(rq)
			} catch (e) {}
		}
	}
	var file = dir + '/export.json'
	if (!api.filePathExists(file)) throw new Error('Cavalry did not write a Lottie file (is Lottie export licensed?)')
	var text = api.readFromFile(file)
	var json = JSON.parse(text)

	// Determine frame range from Lottie output (comp ip/op)
	var compIP = json.ip != null ? json.ip : 1
	var compOP = json.op != null ? json.op : 1
	var frameCount = Math.max(0, compOP - compIP)
	var frames = []
	for (var fi = 0; fi < frameCount; fi++) {
		frames.push({ frame: compIP + fi })
	}

	if (fadeAutoAnimate(compId, json)) text = JSON.stringify(json)
	if (injectVisibilityOpacity(compId, json, frames)) text = JSON.stringify(json)
	if (cullFalloffHidden(compId, json, frames)) text = JSON.stringify(json)
	if (restructureDuplicators(compId, json, frames, opts)) text = JSON.stringify(json)
	console.log('[restructure] DONE. assets=' + (json.assets ? json.assets.length : 0) + ', layers=' + json.layers.length)
	return { json: json, text: text, dir: dir, file: file, baked: restore.map(function (r) { return r[0] }) }
}

// The opacity of one glyph under an Auto-Animate: a hold at 0 (or 100) until `start`, then
// the progress curve `prog` (progress at start, start+1, ...) as per-frame keys. mode:
// 'up' fades 0 -> 100, 'down' 100 -> 0, 'appear' steps from 0 to 100 at `start`.
export function glyphOpacity(start, prog, mode) {
	var lin = { i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }
	var key = function (t, v, hold) {
		return Object.assign({ t: t, s: [v] }, hold ? { h: 1 } : lin)
	}
	if (mode === 'appear') return { a: 1, k: [key(0, 0, true), key(start, 100, true)] }
	var from = mode === 'down' ? 100 : 0
	var k = [key(0, from, true)]
	prog.forEach(function (p, i) {
		k.push(key(start + i, mode === 'down' ? 100 - p : p))
	})
	return { a: 1, k: k }
}

// Frames each glyph of `text` is delayed by an Auto-Animate's Time Offset, in the order
// Cavalry exports the glyphs (last character first), or null when the offset isn't the
// plain case: automatic, negative, normal order, per word or per character. Checked
// against Cavalry's own renders: the elements at the level spread |offset| frames evenly,
// the first starting at once (reverse flips them).
export function glyphDelays(text, aa) {
	if (!aa.automatic || aa.offset >= 0 || aa.timing !== 0 || aa.groupByParent || (aa.level !== 2 && aa.level !== 3)) return null
	var chars = text.replace(/\s/g, '').length
	var words = text.split(/\s+/).filter(Boolean)
	var el = []
	words.forEach(function (w, wi) {
		for (var i = 0; i < w.length; i++) el.push(aa.level === 2 ? wi : el.length)
	})
	var n = aa.level === 2 ? words.length : chars
	return el.map(function (k) {
		return (-aa.offset * (aa.reverse ? n - 1 - k : k)) / Math.max(n - 1, 1)
	}).reverse()
}

// Cavalry bakes text into glyph paths but its Lottie writer drops the Auto-Animate's
// Opacity / Visibility modes, so every glyph shows from the first frame. A glyph starts
// when its progress leaves 0: the delay comes from the Time Offset when that's the plain
// case (glyphDelays), else from where its baked path first moves. The progress curve goes
// on as group opacity.
// ponytail: other offsets need a position/scale/rotation mode to read the start from.
function fadeAutoAnimate(compId, json) {
	var changed = 0
	var frame = api.getFrame()
	compLayers(compId).forEach(function (id) {
		if (!api.hasAttribute(id, 'deformers.0')) return
		var aa = (api.getInConnection(id, 'deformers.0') || '').split('.')[0]
		if (!aa || api.getLayerType(aa) !== 'autoAnimate') return
		var mode = api.get(aa, 'opacityMode') === 1 ? 'up' : api.get(aa, 'opacityMode') === 2 ? 'down' : api.get(aa, 'visibilityMode') === 1 ? 'appear' : null
		if (!mode) return
		var attr = api.get(aa, 'progressMode') === 1 ? 'opacityProgress' : 'progress'
		var keys = api.getKeyframeTimes(aa, attr)
		var last = keys.length ? keys[keys.length - 1] : 0
		var prog = []
		for (var f = 0; f <= last; f++) {
			api.setFrame(f)
			prog.push(api.get(aa, attr))
		}
		var first = prog.findIndex(function (p) { return p > 0 })
		if (first < 0) return
		prog = prog.slice(first)
		var layer = json.layers.filter(function (l) { return l.ty === 4 && l.nm === api.getNiceName(id) })[0]
		if (!layer) return
		var text = api.hasAttribute(id, 'text') ? (api.get(id, 'text') || {}).text : null // a text shape's value is {text, overrides}
		var delays = typeof text !== 'string' ? null : glyphDelays(text, {
			automatic: api.get(aa, 'automaticTimeOffset'),
			offset: api.get(aa, 'timeOffset'),
			timing: api.get(aa, 'timingMode'),
			groupByParent: api.get(aa, 'groupByParent'),
			level: api.get(aa, 'levelMode'),
			reverse: api.get(aa, 'reverseTimeOffset'),
		})
		var groups = glyphGroups(layer.shapes)
		if (delays && delays.length !== groups.length) delays = null
		groups.forEach(function (g, gi) {
			var tr = g.it.filter(function (s) { return s.ty === 'tr' })[0]
			var kf = g.it.filter(function (s) { return s.ty === 'sh' })[0].ks.k
			if (!tr || (tr.o && tr.o.a === 1) || !Array.isArray(kf)) return
			var start = first + Math.floor(delays ? delays[gi] + 1e-6 : 0)
			if (!delays) {
				var v = function (k) { return k.s[0].v[0] }
				var base = v(kf[0])
				var move = kf.filter(function (k) { return Math.abs(v(k)[0] - base[0]) + Math.abs(v(k)[1] - base[1]) > 0.01 })[0]
				if (!move || move.t < 1) return
				start = move.t
			}
			tr.o = glyphOpacity(start, prog, mode)
			changed++
		})
	})
	api.setFrame(frame)
	return changed
}

// Build a map of scene node IDs → visibility curve IDs.
// A visibility curve is any node connected to a scene node's `on` attribute.
// Returns: { [nodeId]: visibilityCurveId }
function readVisibilityCurves(compId) {
	var map = {}
	var visCurves = {}

	// First, find all visibilityCurve nodes in the scene
	compLayers(compId).forEach(function (id) {
		if (api.getLayerType(id) === 'visibilityCurve') {
			visCurves[id] = true
		}
	})

	// Then, check each node for `on` attributes connected to visibility curves
	compLayers(compId).forEach(function (shape) {
		if (!api.hasAttribute(shape, 'on')) return
		var conn = api.getInConnection(shape, 'on') || ''
		if (!conn) return
		var curveId = conn.split('.')[0]
		if (visCurves[curveId]) {
			map[shape] = curveId
		}
	})

	return map
}

// Evaluate a visibility curve at a specific frame, returning 0 or 1.
// Visibility curves evaluate via Cavalry's runtime: setFrame + get(curveId, 'out').
// Output: 1.0 = visible, 0.0 or -1.0 = hidden.
function getVisibilityValue(curveId, frame) {
	api.setFrame(frame)
	var val = api.get(curveId, 'out')
	if (val == null) return 1
	// 1.0 = visible, anything else (0.0, -1.0) = hidden
	return Math.round(val) === 1 ? 1 : 0
}

// Build a visibility mask for each frame in the composition.
// Returns: { curveId: [0, 1, 0, 1, ...] } // one entry per frame
function buildVisibilityMask(compId, frames) {
	var visMap = readVisibilityCurves(compId)
	var masks = {}

	for (var nodeId in visMap) {
		var curveId = visMap[nodeId]
		if (masks[curveId]) continue // shared curve, already computed

		var mask = []
		for (var f = 0; f < frames.length; f++) {
			mask.push(getVisibilityValue(curveId, frames[f].frame))
		}
		masks[curveId] = mask
	}

	return masks
}

// Map Lottie layers back to scene nodes by name.
function layerNameToNodeId(compId, layerName) {
	var nodes = compLayers(compId)
	for (var i = 0; i < nodes.length; i++) {
		if (api.getNiceName(nodes[i]) === layerName) {
			return nodes[i]
		}
	}
	return null
}

// Inject visibility-based opacity keyframes into Lottie JSON.
// For each layer with a visibility curve, multiply opacity by the visibility mask.
// If the layer was static opacity, convert it to animated with the mask baked in.
// If a shape group is hidden at all frames, mark it `hd` so removeHidden strips it.
// `frames` is an array of { frame: Number } objects — the frame numbers Cavalry rendered.
function injectVisibilityOpacity(compId, json, frames) {
	var changed = 0
	var frame = api.getFrame()
	try {
		// Build the visibility masks
		var masks = buildVisibilityMask(compId, frames)
		if (!masks || Object.keys(masks).length === 0) return 0

		// Map each Lottie layer to its visibility mask
		json.layers.forEach(function (layer) {
			if (layer.ty !== 4) return // only shape layers

			var sceneNode = layerNameToNodeId(compId, layer.nm)
			if (!sceneNode) return

			var visMap = readVisibilityCurves(compId)
			var curveId = visMap[sceneNode]
			if (!curveId || !masks[curveId]) return

			var mask = masks[curveId]
			if (mask.length === 0) return

			// Apply mask to all transform groups in this layer
			var items = layer.shapes || []
			items.forEach(function injectToGroup(group) {
				if (group.ty === 'tr') {
					if (!group.o || group.o.a === 0 || group.o.k === 100) {
						// Static opacity → inject animated opacity with visibility mask
						var keys = []
						for (var f = 0; f < mask.length; f++) {
							var val = mask[f] * 100
							keys.push({
								t: frames[f].frame,
								s: [val],
								i: { x: [1], y: [1] },
								o: { x: [0], y: [0] }
							})
						}
						group.o = { a: 1, k: keys }
						changed++
					}
				} else if (group.it && group.it.length) {
					group.it.forEach(injectToGroup)
				}
			})
		})

		// Check visibility curves on child shapes (basicShape nodes connected to duplicators)
		// These visibility curves control individual source shapes that get duplicated.
		// If a visibility curve is always 0, the duplicated instances should be hidden.
		compLayers(compId).forEach(function (shape) {
			if (!api.hasAttribute(shape, 'on')) return
			var conn = api.getInConnection(shape, 'on') || ''
			if (!conn) return
			var curveId = conn.split('.')[0]
			if (masks[curveId]) {
				var mask = masks[curveId]
				var alwaysHidden = mask.every(function (v) { return v === 0 })
				if (alwaysHidden) {
					// Find matching Lottie shape groups and mark them hidden
					var niceName = api.getNiceName(shape)
					json.layers.forEach(function (layer) {
						if (layer.ty !== 4) return
						var items = layer.shapes || []
						var stack = [items]
						while (stack.length) {
							var parent = stack.pop()
							for (var i = 0; i < parent.length; i++) {
								var g = parent[i]
								if (g && g.nm === niceName) {
									g.hd = true
									changed++
								}
								if (g && g.it) stack.push(g.it)
							}
						}
					})
				}
			}
		})
	} finally {
		api.setFrame(frame)
	}
	return changed
}

// Shape groups that hold an animated path of their own (the glyphs of a baked text layer).
function glyphGroups(items, out) {
	out = out || []
	;(items || []).forEach(function (s) {
		if (s.ty !== 'gr') return
		var sh = s.it.filter(function (c) { return c.ty === 'sh' })[0]
		if (sh && sh.ks && sh.ks.a === 1) out.push(s)
		else glyphGroups(s.it, out)
	})
	return out
}

// Decode a compound-graph attribute into a y(x) sampler over x ∈ [0,1].
// api.get reads graph attrs as null, so this goes through api.serialise (the save-file
// representation): graph.list is an array of bezier points, each {position:{x,y},
// left:{x,y}, right:{x,y}, interpolation} — position is the on-curve point, left/right
// the handle offsets, all with a {value:...} wrapper. x is clamped to [0,1] outside the
// point range; y is linear-interpolated between consecutive control points (enough for
// culling, which only trusts exact-0 values).
function graphSamplerFromSerialised(graphAttr) {
	if (!graphAttr || !graphAttr.list || !graphAttr.list.length) return null
	var pts = graphAttr.list.map(function (entry) {
		var c = entry && entry.compound
		if (!c || !c.position || !c.position.value) return null
		return { x: c.position.value.x, y: c.position.value.y }
	}).filter(Boolean)
	if (!pts.length) return null
	pts.sort(function (a, b) { return a.x - b.x })
	return function (x) {
		if (x <= pts[0].x) return pts[0].y
		if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y
		for (var i = 1; i < pts.length; i++) {
			if (x <= pts[i].x) {
				var a = pts[i - 1], b = pts[i]
				var t = (x - a.x) / (b.x - a.x || 1)
				return a.y + (b.y - a.y) * t
			}
		}
		return pts[pts.length - 1].y
	}
}

// The static falloff attached to a node's `falloffs` slot, or null.
// Only safe when every spatial/time attribute is static; any keyframes or an
// undecodeable graph make the value unknowable and we return null instead.
function staticFalloffOf(nodeId, slot, frames) {
	var conn = (api.getInConnection(nodeId, slot) || '').split('.')[0]
	if (!conn) return { enabled: true, sampler: null, rect: null } // no falloff → full strength
	if (api.getLayerType(conn) !== 'falloff') return null
	var f = conn
	// Falloff disabled → output 1 everywhere (same as absent). 'on' gates rendering of
	// the falloff gizmo itself; 'enabled' is the computational switch.
	if (!api.get(f, 'enabled')) return { enabled: false, sampler: null, rect: null }
	// Animated anything → bail. Sample the key attributes at every frame; a value that
	// moves makes the per-copy result time-dependent.
	var frame = api.getFrame()
	var dynamic = ['strength', 'size', 'position', 'rotation', 'seed', 'useProbability', 'repetitions', 'enabled'].some(function (attr) {
		if (!api.hasAttribute(f, attr)) return false
		var first = null
		for (var i = 0; i < frames.length; i++) {
			api.setFrame(frames[i].frame)
			var v = JSON.stringify(api.get(f, attr))
			if (first === null) first = v
			else if (v !== first) return true
		}
		return false
	})
	api.setFrame(frame)
	if (dynamic) return null
	// Decode the graph through serialise (api.get returns null for compound graphs).
	var ser = api.serialise([f], false)
	var graphSampler = null
	try {
		var parsed = JSON.parse(ser)
		var fnode = (parsed.nodes || []).filter(function (n) { return n && n.nodeId === f })[0]
		if (fnode) graphSampler = graphSamplerFromSerialised(fnode.attributes && fnode.attributes.graph)
	} catch (e) {}
	// A custom graph we cannot read must block culling: an unknown curve could make
	// interior values non-zero.
	if (graphSampler === null) {
		if (api.isAttrDefault(f, 'graph')) {
			// Default graph = 1 at centre → 0 at edge (documented). Linear drop: y = 1 - x.
			graphSampler = function (x) { return 1 - x }
		} else {
			return null
		}
	}
	var shapeType = api.get(f, 'shapeType')
	var size = api.get(f, 'size')
	var pos = api.get(f, 'position')
	var rot = api.get(f, 'rotation')
	// v1 supports the axis-aligned Rectangle falloff (the common grid-hole case).
	if (shapeType !== 1) return null
	if (rot && (rot.x || rot.y || rot.z)) return null
	if (!size || !size.x || !size.y) return null
	return {
		enabled: true,
		sampler: graphSampler,
		rect: { cx: pos ? pos.x : 0, cy: pos ? pos.y : 0, hw: size.x / 2, hh: size.y / 2 },
	}
}

// Value of the falloff at a point in comp space. The doc: the Falloff Graph is sampled
// from centre (x=0) to outside (x=1); for a Rectangle the sample coordinate is the
// max-normalised axis distance (Chebyshev), matching the linear edge case measured
// empirically. Returns the graph value; 0 means the attached behaviour outputs nothing.
function falloffValueAt(fo, x, y) {
	var nx = Math.abs(x - fo.rect.cx) / fo.rect.hw
	var ny = Math.abs(y - fo.rect.cy) / fo.rect.hh
	var n = Math.max(Math.min(nx, 1), Math.min(ny, 1))
	return fo.sampler(n)
}

// Cavalry's writer drops a subMesh's animated shapeVisibility (per-copy mesh hiding),
// so a falloff carving a hole out of a duplicator grid exports as if every copy were
// visible — huge dead weight. Read the chain: subMesh.shapeVisibility ← value ← falloffs.
// When the falloff is static (the common "always-off hole" rig), evaluate its graph at
// each copy group's baked centre and mark always-zero copies `hd` — removeHidden strips
// them later. Copies with any non-zero value are left untouched: the exact visibility
// threshold is Cavalry-internal, so only exact-0 (provably never drawn) gets culled.
// Returns changes count.
function cullFalloffHidden(compId, json, frames) {
	var frame = api.getFrame()
	var changed = 0
	try {
		// 1. subMesh nodes driving a shapeVisibility or shapeOpacity from a value node
		// with a falloff. Both attributes hide copies: visibility gates drawing, opacity
		// scales it — a static falloff that evaluates to exactly 0 proves the copy is
		// never drawn either way.
		var sceneLayers = compLayers(compId)
		var hiddenZones = [] // [{ cx, cy, hw, hh, sampler }] — comp-space visibility holes
		sceneLayers.forEach(function (id) {
			if (api.getLayerType(id) !== 'subMesh') return
			var src = (api.getInConnection(id, 'shapeVisibility') || api.getInConnection(id, 'shapeOpacity') || '').split('.')[0]
			if (!src) return
			// The gate must be a static value node: keyframed gates need per-frame baking
			// (injectVisibilityOpacity territory), not culling.
			if (api.getLayerType(src) !== 'value') return
			if (!api.hasAttribute(src, 'falloffs')) return
			var value = api.get(src, 'value')
			// Full-strength base only: 1 on the 0..1 scale or 100 on the percent scale
			// (shapeOpacity chains read percent). Other bases scale the output in ways
			// the cull's exact-0 rule still holds for — but stay conservative.
			if (value !== 1 && value !== 100) return
			// every falloff in the slot attenuates multiplicatively (doc: multiplies Strength)
			var falloffs = []
			for (var i = 0; api.hasAttribute(src, 'falloffs.' + i + '.id'); i++) {
				var fo = staticFalloffOf(src, 'falloffs.' + i + '.id', frames)
				if (!fo || !fo.enabled) return // unknown falloff or disabled evaluation → skip this subMesh entirely
				if (fo.rect) falloffs.push(fo)
			}
			if (!falloffs.length) return
			// With N falloffs the output = base × ∏ graph_i(x). A copy is cullable when
			// that product is exactly 0 at its position for every frame.
			hiddenZones.push({ falloffs: falloffs, subMesh: id })
		})
		if (!hiddenZones.length) return 0

		// 2. Cull: a subMesh's shapeVisibility hides copies of ONE mesh, and the exported
		// JSON has one ty=4 layer per mesh. Any shape layer with enough groups to be a
		// duplicated mesh gets its per-copy check: groups whose centre evaluates to an
		// exact 0 through every falloff in every zone are provably never drawn.
		// (The centre is the baked path centroid — Cavalry bakes copies at absolute comp
		// positions, the same space the falloff's position lives in.)
		json.layers.forEach(function (layer) {
			if (layer.ty !== 4) return
			var groups = []
			;(function walk(items) {
				(items || []).forEach(function (g) {
					if (g.ty === 'gr') { groups.push(g); walk(g.it) }
				})
			})(layer.shapes)
			if (groups.length < 4) return
			groups.forEach(function (g) {
				if (g.hd) return
				var sh = null
				for (var i = 0; i < (g.it || []).length; i++) if (g.it[i].ty === 'sh') { sh = g.it[i]; break }
				if (!sh || !sh.ks || sh.ks.a === 1) return
				var v = sh.ks.k && sh.ks.k.v
				if (!v || !v.length) return
				var cx = 0, cy = 0
				v.forEach(function (p) { cx += p[0]; cy += p[1] })
				cx /= v.length; cy /= v.length
				hiddenZones.forEach(function (zone) {
					var product = 1
					zone.falloffs.forEach(function (fo) { product *= falloffValueAt(fo, cx, cy) })
					if (product === 0) { g.hd = true; changed++ }
				})
			})
		})
	} finally {
		api.setFrame(frame)
	}
	return changed
}

// ---------------------------------------------------------------
// Restructure duplicator layers into hierarchical precomps.
//
// Uses Cavalry scene data (duplicator count, grid) to reconstruct
// the Lottie as a shared precomp + per-copy offset transforms.
//
// For each duplicator layer:
// 1. Take one copy's shape+fill geometry
// 2. Take one copy's animation curve (position + scale keyframes)
// 3. Compute per-copy grid offset from its baked position
// 4. Create a precomp with shared geometry + animation
// 5. Create per-copy layers (ty=0) referencing the precomp
//
// Returns total keyframes saved.
// ---------------------------------------------------------------
function restructureDuplicators(compId, json, frames, opts) {
	var changed = 0
	var saved = 0
	var frame = api.getFrame()
	try {
		if (!opts.duplicators) return 0

		// 1. Find all duplicator layers in the scene
		var sceneLayers = compLayers(compId)
		console.log('[restructure] compLayers returned ' + sceneLayers.length + ' items for compId=' + compId)
		var duplicators = sceneLayers.filter(function (id) {
			var t = api.getLayerType(id)
			return t === 'duplicator'
		})
		console.log('[restructure] found ' + duplicators.length + ' duplicators')

		// Debug: print all scene layers and their types
		var allTypes = {}
		sceneLayers.forEach(function (id) {
			var t = api.getLayerType(id)
			if (!allTypes[t]) allTypes[t] = 0
			allTypes[t]++
		})
		console.log('[restructure] scene layer types: ' + JSON.stringify(allTypes))

		// 2. Map each duplicator to its Lottie shape layer
		var dupInfos = []
		duplicators.forEach(function (dupId) {
			var count = api.get(dupId, 'generator.count')
			if (!count) return
			var xCount = count.x || count['x'] || 0
			var yCount = count.y || count['y'] || 0
			var total = xCount * yCount
			if (total < 4) return // Only restructure large duplicators

			// Find matching Lottie shape layer (by group count, not name)
			console.log('[restructure] duplicator ' + dupId + ' has count=' + total + ', checking ' + json.layers.length + ' layers')
			var lottieLayer = null
			for (var li = 0; li < json.layers.length; li++) {
				if (json.layers[li].ty === 4) {
					var shps = json.layers[li].shapes || []
					// Count ALL ty:'gr' or ty:'ms' across all nested shape arrays
					var grpCount = 0
					for (var si = 0; si < shps.length; si++) {
						if (shps[si].ty === 'gr' || shps[si].ty === 'ms') grpCount++
						var items = shps[si].it || []
						for (var ji = 0; ji < items.length; ji++) {
							if (items[ji].ty === 'gr' || items[ji].ty === 'ms') grpCount++
						}
					}
					console.log('[restructure]   layer[' + li + '] ty=4 shapes=' + shps.length + ' grp=' + grpCount + ' match=' + (grpCount >= total - 20 && grpCount <= total + 20))
					if (grpCount >= total - 20 && grpCount <= total + 20) {
						lottieLayer = json.layers[li]
						break
					}
				}
			}
			if (!lottieLayer) return

			// Check if layer has animated shape objects
			// Collect all ty:'gr' / ty:'ms' groups at ALL nesting depths
			function allGroups(items, out) {
				out = out || []
				;(items || []).forEach(function (g) {
					if (g.ty === 'gr' || g.ty === 'ms') {
						out.push(g)
						allGroups(g.it, out)
					}
				})
				return out
			}
			var animGroups = allGroups(lottieLayer.shapes || [])
				.filter(function (g) {
					// Each copy is a ty:'gr' with sh, fl, tr inside
					var tr = null
					for (var ii = 0; ii < (g.it || []).length; ii++) {
						if (g.it[ii].ty === 'tr') { tr = g.it[ii]; break }
					}
					if (!tr) return false
					var p = tr.p
					if (!p) return false
					// Animated position: tr.p.a === 1 with keyframes
					if (p.a === 1 && p.k && Array.isArray(p.k) && p.k.length >= 2) return true
					// Static position — still a copy (2D or 3D)
					if (p.a === 0 && p.k && Array.isArray(p.k) && (p.k.length === 2 || p.k.length === 3)) return true
					// No position attribute at all — skip
					return false
				})
			console.log('[restructure]   ag=' + animGroups.length)
			if (animGroups.length < 10) return

			dupInfos.push({
				dupId: dupId,
				xCount: xCount,
				yCount: yCount,
				total: total,
				layer: lottieLayer,
				groups: animGroups
			})
			console.log('[restructure]   pushed dupInfos[' + dupInfos.length + ']: dupId=' + dupId + ' groups=' + animGroups.length)
		})

		// 3. Process each duplicator
		console.log('[restructure]   processing ' + dupInfos.length + ' dupInfos')
		for (var di = 0; di < dupInfos.length; di++) {
			try {
			var dup = dupInfos[di]
			var layer = dup.layer
			var groups = dup.groups
			console.log('[restructure]   dup ' + di + ': groups.length=' + groups.length)
			if (groups.length < 4) continue

			// 4. Find first group with shape and fill (skip containers)
			console.log('[restructure]   dup ' + di + ': scanning ' + groups.length + ' groups for srcGroup with sh+fl')
			var srcGroup = null
			var srcGroupIdx = -1
			for (var gi = 0; gi < groups.length; gi++) {
				var hasSh = false
				var hasFl = false
				var hasG = false
				for (var si = 0; si < (groups[gi].it || []).length; si++) {
					if (groups[gi].it[si].ty === 'sh') hasSh = true
					if (groups[gi].it[si].ty === 'fl') hasFl = true
					if (groups[gi].it[si].ty === 'gr') hasG = true
				}
				if (hasSh && hasFl) { srcGroup = groups[gi]; srcGroupIdx = gi; break }
			}
			console.log('[restructure]   dup ' + di + ': srcGroup at index ' + srcGroupIdx + ' (found=' + (srcGroup !== null) + ')')
			if (!srcGroup) { console.log('[restructure]   dup ' + di + ': SKIP no srcGroup found'); continue }

			// Extract the source copy's geometry and paint: the precomp holds one copy's
			// shape + fill; every outer ref layer carries only its offset transform.
			var srcShape = null
			var srcFill = null
			for (var sfi = 0; sfi < (srcGroup.it || []).length; sfi++) {
				if (srcGroup.it[sfi].ty === 'sh') srcShape = srcGroup.it[sfi]
				if (srcGroup.it[sfi].ty === 'fl') srcFill = srcGroup.it[sfi]
			}
			console.log('[restructure]   dup ' + di + ': srcShape=' + (srcShape !== null) + ' srcFill=' + (srcFill !== null))
			if (!srcShape) { console.log('[restructure]   dup ' + di + ': SKIP no sh item in srcGroup'); continue }

			// 5. Extract source transform + animation data
			var srcTr = null
			for (var sti = 0; sti < (srcGroup.it || []).length; sti++) {
				if (srcGroup.it[sti].ty === 'tr') { srcTr = srcGroup.it[sti]; break }
			}
			console.log('[restructure]   dup ' + di + ': srcTr found=' + (srcTr !== null))
			if (!srcTr) continue

			var srcPosKeys = null
			var srcScaleKeys = null
			var srcPosStatic = null
			var srcScaleStatic = null
			if (srcTr.p && srcTr.p.a === 1 && srcTr.p.k && Array.isArray(srcTr.p.k) && srcTr.p.k.length >= 2) {
				srcPosKeys = srcTr.p.k
			} else if (srcTr.p && srcTr.p.a === 0 && srcTr.p.k && Array.isArray(srcTr.p.k)) {
				srcPosStatic = srcTr.p.k
			}
			if (srcTr.s && srcTr.s.a === 1 && srcTr.s.k && Array.isArray(srcTr.s.k) && srcTr.s.k.length >= 2) {
				srcScaleKeys = srcTr.s.k
			} else if (srcTr.s && srcTr.s.a === 0 && srcTr.s.k && Array.isArray(srcTr.s.k)) {
				srcScaleStatic = srcTr.s.k
			}
			console.log('[restructure]   dup ' + di + ': srcPosKeys=' + (srcPosKeys ? srcPosKeys.length : 'null') + ', srcScaleKeys=' + (srcScaleKeys ? srcScaleKeys.length : 'null') + ', srcPosStatic=' + (srcPosStatic ? JSON.stringify(srcPosStatic) : 'null') + ', srcScaleStatic=' + (srcScaleStatic ? JSON.stringify(srcScaleStatic) : 'null'))

			// If source has no animation but other copies do (common with SubMesh),
			// extract the shared animation curve from the first animated copy
			var sharedPosKeys = srcPosKeys
			var sharedScaleKeys = srcScaleKeys
			if (!srcPosKeys && !srcScaleKeys) {
				console.log('[restructure]   dup ' + di + ': source has no animation, searching animated copies...')
				// DIAG: print first 5 groups' tr.p.a and tr.p.k shape
				for (var diag_i = 0; diag_i < Math.min(5, groups.length); diag_i++) {
					var diagTr = null
					for (var diag_ti = 0; diag_ti < (groups[diag_i].it || []).length; diag_ti++) {
						if (groups[diag_i].it[diag_ti].ty === 'tr') { diagTr = groups[diag_i].it[diag_ti]; break }
					}
					var diagPA = diagTr && diagTr.p ? diagTr.p.a : 'no_p'
					var diagPK = diagTr && diagTr.p && diagTr.p.k ? (Array.isArray(diagTr.p.k) ? diagTr.p.k.length : 'not_arr') : 'no_k'
					console.log('[restructure]   dup ' + di + ':   diag[' + diag_i + '] tr.p.a=' + diagPA + ' tr.p.k.length=' + diagPK)
				}
				for (var ai = 0; ai < groups.length; ai++) {
					if (groups[ai] === srcGroup) continue
					var agTr = null
					for (var ati = 0; ati < (groups[ai].it || []).length; ati++) {
						if (groups[ai].it[ati].ty === 'tr') { agTr = groups[ai].it[ati]; break }
					}
					if (agTr && agTr.p && agTr.p.a === 1 && agTr.p.k && Array.isArray(agTr.p.k) && agTr.p.k.length >= 2) {
						sharedPosKeys = agTr.p.k
						console.log('[restructure]   dup ' + di + ': extracted sharedPosKeys=' + agTr.p.k.length)
						break
					}
					if (agTr && agTr.s && agTr.s.a === 1 && agTr.s.k && Array.isArray(agTr.s.k) && agTr.s.k.length >= 2) {
						sharedScaleKeys = agTr.s.k
						console.log('[restructure]   dup ' + di + ': extracted sharedScaleKeys=' + agTr.s.k.length)
						break
					}
				}
				if (!sharedPosKeys && !sharedScaleKeys) console.log('[restructure]   dup ' + di + ': no animated copies found')
			}

			console.log('[restructure]   dup ' + di + ': FINAL sharedPosKeys=' + (sharedPosKeys ? sharedPosKeys.length : 'null') + ', sharedScaleKeys=' + (sharedScaleKeys ? sharedScaleKeys.length : 'null'))
			var numPosKeys = sharedPosKeys ? sharedPosKeys.length : 0
			var numScaleKeys = sharedScaleKeys ? sharedScaleKeys.length : 0
			console.log('[restructure]   dup ' + di + ': checking line 587: !sharedPosKeys=' + (!sharedPosKeys) + ', !sharedScaleKeys=' + (!sharedScaleKeys) + ', !srcPosStatic=' + (!srcPosStatic) + ', !srcScaleStatic=' + (!srcScaleStatic) + ' => ' + (!sharedPosKeys && !sharedScaleKeys && !srcPosStatic && !srcScaleStatic))
			console.log('[restructure]   dup ' + di + ': checking line 588: numPosKeys=' + numPosKeys + ', numScaleKeys=' + numScaleKeys + ' => ' + (numPosKeys === 0 && numScaleKeys === 0))
			if (!sharedPosKeys && !sharedScaleKeys && !srcPosStatic && !srcScaleStatic) { console.log('[restructure]   dup ' + di + ': SKIP line 587 (no data at all)'); continue }
			if (numPosKeys === 0 && numScaleKeys === 0) { console.log('[restructure]   dup ' + di + ': SKIP line 588 (no animation curves)'); continue }

			// 6. Compute per-group offsets from source group
			// Precomp source is positioned at the curve's first keyframe (or [0,0] for flat format),
			// so offset = group's start position minus curve's start position
			var curveBaseX, curveBaseY
			if (srcPosKeys && srcPosKeys.length > 0) {
				curveBaseX = srcPosKeys[0].s[0]
				curveBaseY = srcPosKeys[0].s[1]
			} else if (sharedPosKeys && sharedPosKeys.length > 0) {
				// Source was static but we extracted curve from copies;
				// curve was shifted to zero, so base is 0
				curveBaseX = 0
				curveBaseY = 0
			} else {
				curveBaseX = 0
				curveBaseY = 0
			}

			function getGroupOffset(g) {
				var tr = null
				for (var ti = 0; ti < (g.it || []).length; ti++) {
					if (g.it[ti].ty === 'tr') { tr = g.it[ti]; break }
				}
				if (!tr) return { x: 0, y: 0 }

				var groupX, groupY
				if (tr.p && tr.p.a === 0 && tr.p.k && Array.isArray(tr.p.k)) {
					groupX = tr.p.k[0]; groupY = tr.p.k[1]
				} else if (tr.p && tr.p.k && Array.isArray(tr.p.k) && tr.p.k.length > 0) {
					groupX = tr.p.k[0].s[0]; groupY = tr.p.k[0].s[1]
				} else {
					return { x: 0, y: 0 }
				}

				return { x: groupX - curveBaseX, y: groupY - curveBaseY }
			}
			var offsets = groups.map(getGroupOffset)

			// 6b. Only restructure if there's animation to compress (static-only may bloat JSON)
			if (numPosKeys === 0 && numScaleKeys === 0) {
				console.log('[restructure]   dup ' + di + ': SKIP static-only (no animation curves)')
				continue
			}

			// 7. Create precomp with shared geometry + animation
			var precompNid = 'precomp_dup_' + di
			console.log('[restructure]   dup ' + di + ': creating precomp asset ' + precompNid)
			if (!json.assets) json.assets = []
			
			// When source has NO animation but copies DO (SubMesh pattern),
			// we must shift the animation curve by its first keyframe value so
			// the curve "starts at origin" and precomp source position = [0,0].
			// This way: copyOffset = copyStart - curve(0), and copy final = copyOffset + curve(t).
			var precompPos, precompScale
			if (srcPosStatic || srcScaleStatic) {
				// Shift animation curve to start at zero
				var shiftedCurve
				if (sharedPosKeys) {
					shiftedCurve = sharedPosKeys.map(function (k) {
						var nk = {}
						for (var kk in k) nk[kk] = k[kk]
						nk.s = [nk.s[0] - sharedPosKeys[0].s[0], nk.s[1] - sharedPosKeys[0].s[1]]
						return nk
					})
					precompPos = { a: 1, k: shiftedCurve }
				} else {
					precompPos = { a: 0, k: [0, 0] }
				}
				var shiftedScale
				if (sharedScaleKeys) {
					shiftedScale = sharedScaleKeys.map(function (k) {
						var nk = {}
						for (var kk in k) nk[kk] = k[kk]
						nk.s = [nk.s[0] - sharedScaleKeys[0].s[0], nk.s[1] - sharedScaleKeys[0].s[1], nk.s[2] - sharedScaleKeys[0].s[2]]
						return nk
					})
					precompScale = { a: 1, k: shiftedScale }
				} else {
					precompScale = { a: 0, k: [100, 100, 100] }
				}
			} else {
				precompPos = srcTr.p
				precompScale = srcTr.s
			}
			
			var precomp = {
				id: precompNid,
				nm: 'Duplicator_' + di + '_precomp',
				ty: 2,
				w: json.w || 1920,
				h: json.h || 1080,
				st: 0,
				sr: 1,
				ip: json.ip != null ? json.ip : 1,
				op: json.op != null ? json.op : 1,
				fr: json.fr || 30,
				bgColor: json.bgColor || [0, 0, 0, 1],
				layers: [
					{
						ind: 1,
						ty: 4,
						nm: 'shared',
						ip: precomp.ip,
						op: precomp.op,
						st: 0,
						sr: 1,
						ks: {
							p: precompPos,
							s: precompScale,
							r: { a: 0, k: 0 },
							o: { a: 0, k: 100 }
						},
						shapes: [
							{ ty: 'gr', it: srcFill
								? [
										JSON.parse(JSON.stringify(srcShape)),
										JSON.parse(JSON.stringify(srcFill)),
										{ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
										  s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
									]
								: [JSON.parse(JSON.stringify(srcShape))]
							}
						]
					}
				]
			}
			json.assets.push(precomp)

			// 8. Replace shape layer with precomp reference layers
			var newLayers = []
			for (var oi = 0; oi < groups.length; oi++) {
				var off = offsets[oi]
				newLayers.push({
					ind: oi + 1,
					ty: 0, // comp layer
					nm: 'copy_' + oi,
					ip: json.ip != null ? json.ip : 1,
					op: json.op != null ? json.op : 1,
					st: 0,
					sr: 1,
					refId: precompNid,
					ks: {
						p: { a: 0, k: [off.x, off.y, 0] },
						s: srcTr.s || { a: 0, k: [100, 100, 100] },
						r: { a: 0, k: 0 },
						o: { a: 0, k: 100 }
					}
				})
			}

			// Replace this shape layer
			console.log('[restructure]   dup ' + di + ': searching for shape layer in json.layers (length=' + json.layers.length + ')')
			for (var ni = 0; ni < json.layers.length; ni++) {
				if (json.layers[ni] === layer) {
					console.log('[restructure]   replacing shape layer at index ' + ni + ' with ' + newLayers.length + ' precomp refs')
					json.layers.splice(ni, 1)
					for (var nl = 0; nl < newLayers.length; nl++) {
						json.layers.splice(ni + nl, 0, newLayers[nl])
					}
					console.log('[restructure]   replacement done. json.layers.length=' + json.layers.length + ', assets.length=' + (json.assets ? json.assets.length : 0))
					break
				}
			}

			// Calculate savings
			saved += (groups.length - 1) * (numPosKeys + numScaleKeys)
			changed++
			} catch (err) {
				// One bad duplicator must not kill the others: skip it and carry on.
				console.log('[restructure]   dup ' + di + ': ERROR ' + err.message + ' — skipping this duplicator')
			}
		}
		
		console.log('[restructure]   total changed=' + changed + ', assets=' + (json.assets ? json.assets.length : 0))

		// 9. Clean up unused assets
		if (changed) {
			if (json.assets && json.assets.length) {
				var usedIds = new Set()
				json.layers.forEach(function (L) {
					if (L.refId != null) usedIds.add(L.refId)
				})
				json.assets = json.assets.filter(function (a) { return usedIds.has(a.id) })
			}
		}
	} finally {
		api.setFrame(frame)
	}
	return saved
}
