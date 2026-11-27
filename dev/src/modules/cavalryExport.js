// Export a comp with Cavalry's own Lottie writer, through a temporary Render Queue Item.
// The scene is left as it was: bake overrides are restored and the queue item deleted.

import { visibilitySequenceMask, expressionValues, gateOf, clampOpacity, oscillatorSeries, oscillatorPhaseFromSamples, applyValuesToGroups, alignedPairs } from './submeshVisibility.js'
import { bakeImageFills } from './imageBake.js'
import { applyImageFills } from './imageFills.js'

// forceLottieBake values, in Cavalry's order.
export var BAKE_MODES = ['Automatic', 'Animated Mesh', 'Animated Mesh & Materials', 'Nuclear', 'Still']

// Cavalry's `startFrame` shifts the time base: with startFrame 0, setFrame(f) reads authored
// frame f; with startFrame s, setFrame(f) reads authored frame f + s. A comp whose startFrame
// is not 0 therefore reads every frame s late, and the authored frame the writer labels `f`
// is read by setFrame(f - s).
export function timeBase(comp) {
	var s = Number(api.get(comp, 'startFrame'))
	return Number.isFinite(s) ? s : 0
}

// A Lottie frame label (authored frame) to the frame setFrame reads it at.
export var readFrame = function (label, shift) { return label - shift }

// A frame read in Cavalry's shifted time base to the authored frame the writer labels it.
export var labelFrame = function (frame, shift) { return frame + shift }

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

// The node ids connected into a layer's `slot` list (a duplicator's `shapes`),
// in slot order. Reads the serialised scene graph: probing slot.N through
// getInConnection throws — and logs "Couldn't find attribute with path" — as
// soon as N passes the last entry, which spammed the console on every export.
export function inputSources(layerId, slot) {
	var nodes = null
	var attr = slot || 'shapes'
	try { nodes = JSON.parse([].concat(api.serialise([layerId], false)).join('')) } catch (e) { return [] }
	var prefix = layerId + '.' + attr + '.'
	var out = []
	;(nodes && nodes.connections || []).forEach(function (c) {
		var to = String(c.to)
		if (to.indexOf(prefix) !== 0) return
		out.push({ at: parseInt(to.slice(prefix.length), 10) || 0, from: String(c.from).replace(/\.id$/, '') })
	})
	out.sort(function (a, b) { return a.at - b.at })
	return out.map(function (o) { return o.from })
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

// opts: { bakeMode: null | 0..4, ref: compositionReference id it's exported for, crop: {from, to} | null }
//   -> { json, text, dir, file, baked: [ids], shift, first, last }
// A crop renders only the playback range. It uses the render queue's Custom Range so the
// The text-bearing groups whose outFrame Cavalry's Lottie writer needs pushed past the
// comp's endFrame for the glyphs to survive. Returns [holderId, outFrame] pairs for the
// caller to widen and restore. Cavalry evaluates a text layer's topology over the whole
// comp range and drops the glyphs (shapes [{ty:'gr',np:0,it:[]}], no `t` field at all)
// when the group directly holding the text ends at or before the comp's endFrame.
// Measured on group#98 (in 212, out 581) in a 1200-frame comp: out 581..1200 all export
// itLen 0, out 1201 exports the full 26 groups. Only the nearest group matters —
// group#97 (out 86) wraps group#120 (out 1225), and those texts export fine.
export function textOutFrameLifts(compId, compEnd) {
	if (!(compEnd > 0)) return []
	if (typeof api.getOutFrame !== 'function' || typeof api.getParent !== 'function') return []
	var lifted = {}
	var out = []
	compLayers(compId).forEach(function (id) {
		if (api.getLayerType(id) !== 'textShape') return
		var holder = api.getParent(id)
		// A text parented straight to the comp resolves to the comp itself, and
		// widening that would change the export's own frame span. Only groups lift.
		if (!holder || holder === compId || lifted[holder]) return
		if (api.getLayerType(holder) !== 'group') return
		var outF = api.getOutFrame(holder)
		if (!(outF > 0) || outF > compEnd) return
		lifted[holder] = 1
		out.push([holder, outF])
	})
	return out
}

// comp's own startFrame/endFrame stay as authored: lowering startFrame shifts Cavalry's time
// base and every frame read lands late (a colour cycle starts on its wrong end).
// `shift` is the comp's time-base shift; `first` and `last` are the authored frame labels the
// export covers (the Lottie ip and op - 1), so a caller sampling the scene can convert them
// to reads with readFrame(label, shift).
export function exportComp(compId, opts) {
	opts = opts || {}
	var dir = api.getTempFolder() + '/lottie-tools-' + new Date().getTime()
	api.makeFolder(dir)
	var restore = []
	var restoreOut = []
	var rewired = []
	var rq = null
	var frame = api.getFrame() // rendering moves the playhead
	var shift = timeBase(compId)
	try {
		shaderArrayPicks(compId, opts.ref).forEach(function (p) {
			api.connect(p.shader, 'id', p.shape, p.path, true) // force swaps the source in place; disconnecting drops the list entry
			rewired.push(p)
		})
		// Cavalry's writer evaluates a text layer's topology over the whole comp range
		// and drops the glyphs (shapes [{ty:'gr',np:0,it:[]}], no `t` field at all)
		// when the group directly holding the text ends at or before the comp's
		// endFrame. Measured on group#98 (in 212, out 581) in a 1200-frame comp: out
		// 581..1200 all export itLen 0, out 1201 exports the full 26 groups. Only the
		// nearest group matters — group#97 (out 86) wraps group#120 (out 1225), and
		// those texts export fine. setOutFrame stores out+1, so passing the comp's own
		// endFrame leaves the outFrame one past it.
		var compEnd = Number(api.get(compId, 'endFrame')) || 0
		textOutFrameLifts(compId, compEnd).forEach(function (r) {
			restoreOut.push(r)
			api.setOutFrame(r[0], compEnd)
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
		if (opts.crop) api.set(rq, { filePath: dir, fileName: 'export', frameRangeMode: 2, frameRange: { x: opts.crop.from, y: opts.crop.to } })
		else api.set(rq, { filePath: dir, fileName: 'export', frameRangeMode: 0 })
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
		restoreOut.forEach(function (r) {
			try {
				api.setOutFrame(r[0], r[1] - 1)
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

	if (fadeAutoAnimate(compId, json, shift)) text = JSON.stringify(json)
	if (injectVisibilityOpacity(compId, json, frames, shift)) text = JSON.stringify(json)
	if (injectSubMeshVisibility(compId, json, frames, opts && opts.measuredSubMesh, shift)) text = JSON.stringify(json)
	if (restructureDuplicators(compId, json, frames, opts, shift)) text = JSON.stringify(json)
	// Cavalry's writer emits no image asset for an imageShader fill: the shape
	// bakes as a flat fill of its material colour. Bake one cell of each shader
	// in a comp built for it, then repeat that cell over every copy.
	if (opts && opts.imageFills !== false) {
		if (applyImageFillsFromScene(compId, json, dir, shift, opts && opts.measuredSubMesh)) text = JSON.stringify(json)
	}
	console.log('[restructure] DONE. assets=' + (json.assets ? json.assets.length : 0) + ', layers=' + json.layers.length)
	return { json: json, text: text, dir: dir, file: file, baked: restore.map(function (r) { return r[0] }), shift: shift, first: compIP, last: compOP - 1 }
}

// Put each imageShader fill back as a real image. The cell is rendered by
// Cavalry in a comp of its own (see imageBake.js), copied into this comp's
// export folder so the image packer resolves it like any other image, then
// repeated over the copies by imageFills.js.
function applyImageFillsFromScene(compId, json, dir, shift, measured) {
	var bakes = []
	try {
		bakes = bakeImageFills(compId, shift || 0)
	} catch (e) {
		console.log('[image-fill] measurement failed: ' + (e && e.message))
		return false
	}
	if (!bakes.length) return false
	var lookupMeasured = function (host, ownerId, attr) {
		if (!measured || !ownerId) return null
		if (host && measured[host + ':' + ownerId] && measured[host + ':' + ownerId][attr]) return measured[host + ':' + ownerId][attr]
		if (measured[ownerId] && measured[ownerId][attr]) return measured[ownerId][attr]
		return null
	}
	var jobs = []
	var copiedCount = 0
	var copiedFiles = {}
	var copyIntoDir = function (assetFile, assetP) {
		if (copiedFiles[assetP] === assetFile) return true
		var target = dir + '/' + assetP
		try {
			if (api.filePathExists(target)) api.deleteFilePath(target)
			api.copyFilePath(assetFile, target)
			copiedFiles[assetP] = assetFile
			copiedCount++
			return true
		} catch (e) {
			console.log('[image-fill] could not copy ' + assetP + ': ' + (e && e.message))
			return false
		}
	}
	bakes.forEach(function (b) {
		if (Array.isArray(b.assets) && b.assets.length) {
			var copied = []
			b.assets.forEach(function (a) {
				if (!copyIntoDir(a.assetFile, a.assetP)) return
				copied.push({
					assetId: a.assetId,
					assetW: a.assetW,
					assetH: a.assetH,
					assetU: '',
					assetP: a.assetP
				})
			})
			if (!copied.length) return
			jobs.push({
				assets: copied,
				copyCount: b.copyCount,
				allowUnderCount: b.allowUnderCount,
				cellW: b.cellW,
				spansPitch: b.spansPitch,
				copyAssetIndex: b.copyAssetIndex,
				copyOpacity: b.copyOpacity,
				assetArrayReverse: b.assetArrayReverse,
				shapeSlot: b.shapeSlot,
				measuredArrayIndex: lookupMeasured(b.host, b.assetArrayNode, 'arrayIndex'),
				measuredShapeId: lookupMeasured(b.host, b.host, 'shapeId')
			})
			return
		}
		if (!copyIntoDir(b.assetFile, b.assetP)) return
		jobs.push({
			assetId: b.assetId,
			assetW: b.assetW,
			assetH: b.assetH,
			assetU: '',
			assetP: b.assetP,
			copyCount: b.copyCount,
			cellW: b.cellW,
			spansPitch: b.spansPitch
		})
	})
	if (!jobs.length) return false
	var r = applyImageFills(json, jobs)
	r.notes.forEach(function (n) { console.log('[image-fill] ' + n) })
	if (r.changed) console.log('[image-fill] ' + r.changed + ' layer(s), ' + copiedCount + ' cell image(s)')
	return r.changed > 0
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
function fadeAutoAnimate(compId, json, shift) {
	var changed = 0
	var frame = api.getFrame()
	shift = shift || 0
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
			api.setFrame(readFrame(f, shift))
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
function buildVisibilityMask(compId, frames, shift) {
	var visMap = readVisibilityCurves(compId)
	var masks = {}

	for (var nodeId in visMap) {
		var curveId = visMap[nodeId]
		if (masks[curveId]) continue // shared curve, already computed

		var mask = []
		for (var f = 0; f < frames.length; f++) {
			mask.push(getVisibilityValue(curveId, readFrame(frames[f].frame, shift || 0)))
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
// `shift` is the comp's time-base shift, so each label is read at readFrame(label, shift).
function injectVisibilityOpacity(compId, json, frames, shift) {
	var changed = 0
	var frame = api.getFrame()
	try {
		// Build the visibility masks
		var masks = buildVisibilityMask(compId, frames, shift)
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
		try { api.setFrame(frame) } catch (e) {}
		try { if (prevComp) api.setActiveComp(prevComp) } catch (e) {}
	}
	return changed
}

// ---------------------------------------------------------------
// Per-submesh visibility injection.
//
// Cavalry's Lottie writer drops a subMesh's driven shapeVisibility, so every
// duplicator copy exports as if always visible. The same writer drops a driven
// shapeOpacity, so an oscillator fade exports as a flat 100. Cavalry has no API
// to READ either evaluated per-index value (measured: getBoundingBox,
// subBoundingBox, countSubMeshes, extractSubMeshes and api.get on the driven
// attrs all ignore it), so this pass evaluates what the scene graph defines —
// a Visibility Sequence, an index-pure JavaScript utility (ctx = {index,
// count}), an Oscillator on shapeOpacity (closed form) — and takes every other
// driver (a seeded Random, a Value with falloffs, an oscillator whose
// timeOffset is driven) from the clone measurement in subMeshMeasure.js.
// Layer-seeded Randoms are not measured yet; their copies keep their visibility
// rather than being culled on a guess.
//
// Every driver yields a per-frame 0..100 value series per copy, so a gate and a
// fade are the same kind of number and combine by MULTIPLICATION — a hidden
// copy stays at 0 whatever its fade says, and a visible copy at half fade lands
// at 50. The product lands on the matching Lottie shape groups as a tr.o
// opacity (hold keys for a gate, a thinned linear curve for a fade), or
// hd:true when a copy is 0 at every frame — removeHidden strips those.
// ---------------------------------------------------------------

// Read an oscillator node's analytic config. Returns null when the node is not
// an oscillator. fps comes from the comp (the oscillator node has no fps
// attribute; measured), which is the rate its frequency is expressed against.
export function oscillatorConfig(id, compId) {
	if (api.getLayerType(id) !== 'oscillator') return null
	var cfg = {}
	;['minimum', 'maximum', 'frequency', 'timeMode', 'trigType', 'waveType', 'strength', 'strengthToZero', 'timeOffset', 'timeScale', 'offset'].forEach(function (a) {
		try { cfg[a] = api.hasAttribute(id, a) ? api.get(id, a) : undefined } catch (e) { cfg[a] = undefined }
	})
	cfg.fps = 60
	try {
		var comp = compId || api.getActiveComp()
		if (comp && api.hasAttribute(comp, 'fps')) cfg.fps = api.get(comp, 'fps') || 60
	} catch (e) {}
	return cfg
}

// One driven subMesh attribute as a value source. Returns
//   { perCopy: copy -> per-frame 0..100 values }  — index-ordered (needs pairing)
//   { uniform: per-frame 0..100 values }          — same for every copy
//   { measured: [{ c, v }] in probe bake order }  — paired by baked position
// or null when the driver cannot be reproduced (copies are then left alone).
//
// `attr` is 'shapeVisibility' (a gate: v >= 0.5 shows, measured) or
// 'shapeOpacity' (hard-clamped to 0..100, measured). Drivers whose per-copy
// value only Cavalry can compute come from the clone measurement
// (subMeshMeasure.js), handed in as `measured`.
function subMeshDriverValues(sm, attr, frames, compId, measured, shift, host) {
	var count = subMeshCopyCount(sm, compId, host)
	if (!count) return null
	var conn = (api.getInConnection(sm, attr) || '').split('.')[0]
	if (!conn) return null
	var type = api.getLayerType(conn)
	var isGate = attr === 'shapeVisibility'
	var hold = function (v) {
		var row = []
		for (var k = 0; k < frames.length; k++) row.push(v)
		return row
	}

	if (type === 'visibility' && isGate) {
		var masks = []
		for (var i = 0; i < frames.length; i++) {
			api.setFrame(readFrame(frames[i].frame, shift))
			masks.push(
				visibilitySequenceMask(
					{
						start: api.get(conn, 'start'),
						end: api.get(conn, 'end'),
						travel: api.get(conn, 'travel'),
						invert: api.get(conn, 'invert'),
						alwaysOn: api.get(conn, 'alwaysOn'),
						alwaysOff: api.get(conn, 'alwaysOff'),
					},
					count
				)
			)
		}
		var vis = []
		for (var c = 0; c < count; c++) {
			var row = []
			for (var f = 0; f < frames.length; f++) row.push(masks[f][c] ? 100 : 0)
			vis.push(row)
		}
		return { perCopy: vis }
	}

	if (type === 'javaScript') {
		var base = expressionValues(api.get(conn, 'expression'), count)
		if (base) {
			return {
				perCopy: base.map(function (v) {
					return hold(isGate ? (gateOf(v) ? 100 : 0) : clampOpacity(Number(v) || 0))
				}),
			}
		}
	}

	// The measurement is only trusted for the node it was taken from.
	var hostKey = host ? host + ':' + sm : null
	var m = (hostKey && measured && measured[hostKey] && measured[hostKey][attr]) || (measured && measured[sm] && measured[sm][attr])
	if (m && m.node === conn) {
		if (m.kind === 'value') {
			// A multi-frame measurement is a piecewise-constant value: the driver
			// re-rolls at the sampled frames, so any export frame takes the value
			// of the most recent sample not after it. A single sample is a constant.
			if (m.frames && m.frames.length > 1) {
				return {
					measured: m.copies.map(function (k) {
						var row = []
						for (var f = 0; f < frames.length; f++) {
							var t = frames[f].frame
							var bi = m.frames.length - 1
							for (var s = 0; s < m.frames.length - 1; s++) {
								if (t < m.frames[s + 1]) { bi = s; break }
							}
							var v = k.vs[bi]
							row.push(isGate ? (gateOf(v) ? 100 : 0) : clampOpacity(v))
						}
						return { c: k.c, row: row }
					}),
				}
			}
			return {
				measured: m.copies.map(function (k) {
					return { c: k.c, row: hold(isGate ? (gateOf(k.v) ? 100 : 0) : clampOpacity(k.v)) }
				}),
			}
		}
		// kind 'phase': two samples of the oscillator's own output fix each
		// copy's phase; the closed form then gives every frame.
		var pcfg = oscillatorConfig(conn, compId)
		if (!pcfg || !m.frames || m.frames.length < 2) return null
		var out = []
		for (var q = 0; q < m.copies.length; q++) {
			var k = m.copies[q]
			// The solver returns the phase at the first sample; shift it back to frame 0.
			var off = oscillatorPhaseFromSamples(pcfg, k.vs[0], k.vs[1], m.frames[1] - m.frames[0])
			if (off == null) return null
			off -= m.frames[0] / (pcfg.fps || 60)
			var s = oscillatorSeries(Object.assign({}, pcfg, { timeOffset: off }), frames, 0)
			if (!s) return null
			out.push({ c: k.c, row: s.map(clampOpacity) })
		}
		return { measured: out }
	}

	if (type === 'oscillator' && !isGate) {
		var cfg = oscillatorConfig(conn, compId)
		if (!cfg) return null
		if ((api.getInConnection(conn, 'timeOffset') || '').split('.')[0]) {
			console.log('[submesh-vis] ' + sm + ': oscillator timeOffset is driven and was not measured — copies left alone')
			return null
		}
		var series = oscillatorSeries(cfg, frames, 0)
		if (!series) {
			console.log('[submesh-vis] ' + sm + ': oscillator config is not analytically evaluable — skipping')
			return null
		}
		return { uniform: series.map(clampOpacity) }
	}

	if (driverUsesLayerSeed(sm, attr)) {
		console.log('[submesh-vis] ' + sm + ': ' + attr + ' driver uses "Use Layer as Seed" — copies left visible')
	} else {
		console.log('[submesh-vis] ' + sm + ': ' + attr + ' driver (' + type + ') was not measured — copies left visible')
	}
	return null
}

// Walk an attribute's driver chain for a Random/Noise with Use Layer as Seed.
// The chain must be walked, not sampled one hop: on Quiz BG the flag would sit
// on random#33, which feeds value#77, which feeds the subMesh.
export function driverUsesLayerSeed(sm, attr) {
	var seen = {}
	var stack = [(api.getInConnection(sm, attr || 'shapeVisibility') || '').split('.')[0]]
	while (stack.length) {
		var id = stack.pop()
		if (!id || seen[id]) continue
		seen[id] = 1
		var type = api.getLayerType(id)
		if (type === 'random' || type === 'noise') {
			if (api.hasAttribute(id, 'useLayerAsSeed') && api.get(id, 'useLayerAsSeed')) return true
		}
		;(api.getInConnectedAttributes(id) || []).forEach(function (a) {
			var src = (api.getInConnection(id, a) || '').split('.')[0]
			if (src) stack.push(src)
		})
	}
	return false
}

// Copy index → comp-space centre (Cavalry coordinates, y up), read from the
// live duplicator at the first exported frame, because the baked group centres
// come from each copy's FIRST path keyframe.
//
// The index→position relationship is NOT the grid order you might assume, and
// Sort/Shuffle/Array distributions reorder ids, so it is read, never derived.
function readCopyCentres(host, count, compId, sampleFrame, shift) {
	var frame = api.getFrame()
	var ex = null
	try {
		ex = api.create('extractSubMeshes', 'submesh-vis-centres')
		api.parent(ex, compId)
		api.set(ex, { ignoreEmptySubMeshes: false, levelMode: 1, level: 1, indices: '0' })
		api.connect(host, 'id', ex, 'inputShape')
		if (typeof sampleFrame === 'number') api.setFrame(readFrame(sampleFrame, shift || 0))
		var out = []
		for (var c = 0; c < count; c++) {
			api.set(ex, { indices: String(c) })
			var box = api.getBoundingBox(ex, true)
			out.push(box && box.width ? [box.x + box.width / 2, box.y + box.height / 2] : null)
		}
		return out
	} catch (e) {
		console.log('[submesh-vis] ' + host + ': could not read copy centres — ' + e.message)
		return null
	} finally {
		if (ex) { try { api.deleteLayer(ex) } catch (e) {} }
		try { api.setFrame(frame) } catch (e) {}
	}
}

// All duplicators whose deformers slot holds this subMesh.
export function subMeshHosts(sm, compId) {
	var hosts = []
	compLayers(compId).forEach(function (id) {
		if (api.getLayerType(id) !== 'duplicator') return
		for (var i = 0; api.hasAttribute(id, 'deformers.' + i); i++) {
			if ((api.getInConnection(id, 'deformers.' + i) || '').split('.')[0] === sm) {
				if (hosts.indexOf(id) < 0) hosts.push(id)
			}
		}
	})
	return hosts
}

// The duplicator whose deformers slot holds this subMesh, or null.
export function subMeshHost(sm, compId) {
	var hosts = subMeshHosts(sm, compId)
	return hosts.length ? hosts[0] : null
}

// How many copies a subMesh's host duplicator generates (the attribute path
// moved between Cavalry versions: generator.count, else generator.input.count).
function subMeshCopyCount(sm, compId, host) {
	host = host || subMeshHost(sm, compId)
	if (!host) return 0
	var count = null
	if (api.hasAttribute(host, 'generator.count')) count = api.get(host, 'generator.count')
	if (!count && api.hasAttribute(host, 'generator.input.count')) count = api.get(host, 'generator.input.count')
	if (!count || !count.x || !count.y) return 0
	return Math.max(1, Math.round(count.x * count.y))
}

// The comp itself plus every comp it reaches through composition references.
// A scene comp usually holds its rig inside a referenced comp, so a pass that
// only looks at direct children finds nothing.
export function referencedComps(compId, seen, out) {
	seen = seen || {}
	out = out || []
	if (!compId || seen[compId]) return out
	seen[compId] = 1
	out.push(compId)
	compLayers(compId).forEach(function (id) {
		if (api.getLayerType(id) !== 'compositionReference') return
		var inner = ''
		try { inner = String(api.getInConnection(id, 'composition') || '').replace(/\.id$/, '') } catch (e) { inner = '' }
		if (inner && !seen[inner]) referencedComps(inner, seen, out)
	})
	return out
}

// Inject per-submesh visibility into the Lottie JSON. Returns changes count.
//
// Every source is resolved to one 0..100 series per BAKED GROUP, and the
// sources of all deformers on a host are MULTIPLIED: a copy any gate hides is
// 0 whatever its fade says. Index-ordered sources are paired by live copy
// centre (y flipped into Lottie space); measured sources by the probe bake's
// own copy centres. A group some source cannot place is left alone.
export function injectSubMeshVisibility(compId, json, frames, measured, shift) {
	var frame = api.getFrame()
	var changed = 0
	var prevComp = api.getActiveComp()
	shift = shift || 0
	try {
		var byHost = {}
		var order = []
		var ownerOf = {}
		// A scene comp usually holds a compositionReference rather than the rig
		// itself, so a subMesh's host duplicator lives in the REFERENCED comp.
		// Resolve each subMesh against the comp that owns it.
		referencedComps(compId).forEach(function (owner) {
			compLayers(owner).forEach(function (id) {
				if (api.getLayerType(id) !== 'subMesh') return
				subMeshHosts(id, owner).forEach(function (host) {
					if (!byHost[host]) {
						byHost[host] = []
						order.push(host)
						ownerOf[host] = owner
					}
					byHost[host].push(id)
				})
			})
		})

		// A baked copy layer can sit in the root layer list or inside a precomp
		// asset; both hold shapes and both must be considered.
		var layerLists = [json.layers].concat((json.assets || []).filter(function (a) { return a.layers }).map(function (a) { return a.layers }))
		var usedLayers = []

		order.forEach(function (host) {
			var owner = ownerOf[host]
			try { api.setActiveComp(owner) } catch (e) {}
			var count = subMeshCopyCount(byHost[host][0], owner, host)
			if (!count) return
			var hostName = ''
			try { if (typeof api.getNiceName === 'function') hostName = api.getNiceName(host) || '' } catch (e) {}
			var layer = null
			var best = null
			var bestNamed = false
			layerLists.forEach(function (list) {
				;(list || []).forEach(function (L) {
					if (L.ty !== 4 || usedLayers.indexOf(L) >= 0) return
					var g = allCopyGroups(L.shapes)
					if (g.length < count) return
					var d = g.length - count
					var named = !!(hostName && L.nm === hostName)
					if (best === null || (named && !bestNamed) || (named === bestNamed && d < best)) {
						best = d
						bestNamed = named
						layer = L
					}
				})
			})
			if (!layer) {
				console.log('[submesh-vis] ' + host + ': no shape layer with ' + count + '+ copy groups')
				return
			}
			usedLayers.push(layer)
			var groups = allCopyGroups(layer.shapes)
			var groupCentres = groups.map(function (g) { return bakedGroupCentre(g) })

			var sources = []
			byHost[host].forEach(function (id) {
				;['shapeVisibility', 'shapeOpacity'].forEach(function (attr) {
					if (!(api.getInConnection(id, attr) || '')) return
					var s = subMeshDriverValues(id, attr, frames, owner, measured, shift, host)
					if (s) sources.push(s)
				})
			})
			if (!sources.length) {
				console.log('[submesh-vis] ' + host + ': no deformer value is reproducible — copies left visible')
				return
			}

			var indexPairs
			var perGroup = []
			for (var si = 0; si < sources.length; si++) {
				var src = sources[si]
				var rows = new Array(groups.length).fill(null)
				if (src.uniform) {
					for (var g0 = 0; g0 < groups.length; g0++) rows[g0] = src.uniform
				} else if (src.perCopy) {
					if (indexPairs === undefined) {
						indexPairs = alignedPairs(readCopyCentres(host, count, owner, frames.length ? frames[0].frame : null, shift), groupCentres, true)
					}
					if (!indexPairs) {
						console.log('[submesh-vis] ' + host + ': could not pair copies to baked groups — skipping')
						return
					}
					indexPairs.forEach(function (gi, ci) { if (gi !== null) rows[gi] = src.perCopy[ci] })
				} else {
					var mp = alignedPairs(src.measured.map(function (k) { return k.c }), groupCentres, false)
					if (!mp) return
					mp.forEach(function (gi, k) { if (gi !== null) rows[gi] = src.measured[k].row })
				}
				perGroup.push(rows)
			}

			var byGroup = {}
			for (var gi = 0; gi < groups.length; gi++) {
				var row = []
				for (var f2 = 0; f2 < frames.length; f2++) {
					var v = 100
					for (var s2 = 0; s2 < perGroup.length; s2++) {
						var r = perGroup[s2][gi]
						if (!r) { v = null; break }
						v = (v * r[f2]) / 100
					}
					row.push(v)
				}
				byGroup[gi] = row
			}
			changed += applyValuesToGroups(groups, byGroup, frames)
		})
	} finally {
		try { api.setFrame(frame) } catch (e) {}
		try { if (prevComp) api.setActiveComp(prevComp) } catch (e) {}
	}
	return changed
}

// Every baked copy group of a shape layer: the children of the top-level
// container group. The writer bakes a duplicator's copies as `gr` children of
// one outer `gr` (which itself ends with a `tr` item) — the container is not
// a copy, so it must not consume a mask index.
function allCopyGroups(items, out) {
	out = out || []
	;(items || []).forEach(function (outer) {
		if (outer.ty !== 'gr') return
		;(outer.it || []).forEach(function (g) {
			if (g.ty === 'gr') out.push(g)
		})
	})
	return out
}

// Shape groups that hold an animated path of their own (the glyphs of a baked text layer).
function glyphGroups(items, out) {	out = out || []
	;(items || []).forEach(function (s) {
		if (s.ty !== 'gr') return
		var sh = s.it.filter(function (c) { return c.ty === 'sh' })[0]
		if (sh && sh.ks && sh.ks.a === 1) out.push(s)
		else glyphGroups(s.it, out)
	})
	return out
}

// Centroid(s) of a copy group's baked path. Static paths give one point; animated paths
// give one per keyframe (Lottie path keyframes hold their sub-path in `s[0].v`). Returns
// null when the path data is missing or malformed — the caller then leaves the group alone.
function groupCentroids(sh) {
	if (!sh || !sh.ks || !sh.ks.k) return null
	var paths = sh.ks.a === 1 ? sh.ks.k.map(function (kf) { return kf && kf.s && kf.s[0] }) : [sh.ks.k]
	if (!paths.length) return null
	var out = []
	for (var i = 0; i < paths.length; i++) {
		var v = paths[i] && paths[i].v
		if (!v || !v.length) return null
		var cx = 0, cy = 0
		v.forEach(function (p) { cx += p[0]; cy += p[1] })
		out.push([cx / v.length, cy / v.length])
	}
	return out
}

// Comp-space centre of one baked copy group, used to pair it with the copy
// index it came from. The writer bakes each copy's path already offset into the
// duplicator's space, so the path vertex centroid IS the copy position; the
// group's own tr.p is absent (transform lives in the path). Returns null when
// the group holds no path to measure.
function bakedGroupCentre(g) {
	var it = (g && g.it) || []
	for (var i = 0; i < it.length; i++) {
		if (it[i].ty !== 'sh') continue
		var cents = groupCentroids(it[i])
		// Later keyframes exist for animated copies; the static first frame is
		// enough to identify which copy this group is.
		if (cents && cents.length) return cents[0]
	}
	return null
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
function restructureDuplicators(compId, json, frames, opts, shift) {
	var changed = 0
	var saved = 0
	var frame = api.getFrame()
	shift = shift || 0
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
			// a duplicator whose input is a composition reference is handled by the
			// precomp pass (duplicatorCompRefs) — the bake has no fills worth keeping
			var shapeSources = inputSources(dupId)
			for (var s = 0; s < shapeSources.length; s++) {
				if (api.getLayerType(shapeSources[s]) === 'compositionReference') {
					console.log('[restructure] duplicator ' + dupId + ' feeds on a composition reference — left to the precomp pass')
					return
				}
			}
			var count = null
			if (api.hasAttribute(dupId, 'generator.count')) count = api.get(dupId, 'generator.count')
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
