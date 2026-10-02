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

// opts: { bakeMode: null | 0..4 }  -> { json, text, dir, file, baked: [ids] }
export function exportComp(compId, opts) {
	opts = opts || {}
	var dir = api.getTempFolder() + '/lottie-tools-' + new Date().getTime()
	api.makeFolder(dir)
	var restore = []
	var rq = null
	var frame = api.getFrame() // rendering moves the playhead
	try {
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
