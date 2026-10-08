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
	return { json: JSON.parse(text), text: text, dir: dir, file: file, baked: restore.map(function (r) { return r[0] }) }
}
