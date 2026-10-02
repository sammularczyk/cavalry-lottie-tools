// Image assets after export: embed them in the JSON as data URIs, or copy them next to
// it in images/. Optionally re-encodes opaque PNGs as JPEG (macOS `sips`; elsewhere
// images stay as they are).

var JPEG_QUALITY = '85'

function isImage(a) {
	return a && !a.layers && typeof a.p === 'string' && a.e !== 1 && a.p.indexOf('data:') !== 0
}

function findSource(a, dirs) {
	for (var i = 0; i < dirs.length; i++) {
		var f = dirs[i] + '/' + (a.u || '') + a.p
		if (api.filePathExists(f)) return f
	}
	return null
}

// Opaque PNG -> JPEG in scratchDir if that's smaller; returns the file to use.
function toJpeg(src, scratchDir) {
	if (!/\.png$/i.test(src) || api.getPlatform() !== 'macOS') return src
	var alpha = api.runProcess('sips', ['-g', 'hasAlpha', src])
	if (alpha.error || !/hasAlpha:\s*no/.test(alpha.output)) return src
	var out = scratchDir + '/' + api.getFileNameFromPath(src, false) + '.jpg'
	var r = api.runProcess('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, src, '--out', out])
	if (r.error || !api.filePathExists(out)) return src
	return api.encodeBinary(out).length < api.encodeBinary(src).length ? out : src
}

// opts: { embed, jpeg, scratchDir } -> { embedded, copied, jpeg, missing }
export function packImages(json, dirs, outDir, opts) {
	var res = { embedded: 0, copied: 0, jpeg: 0, missing: 0 }
	;(json.assets || []).forEach(function (a) {
		if (!isImage(a)) return
		var src = findSource(a, dirs)
		if (!src) {
			res.missing++
			return
		}
		var file = opts.jpeg ? toJpeg(src, opts.scratchDir || dirs[0]) : src
		var jpeg = file !== src
		if (jpeg) res.jpeg++
		if (opts.embed) {
			var ext = (api.getExtensionFromPath(file) || 'png').replace('.', '').toLowerCase()
			a.u = ''
			a.p = 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + api.encodeBinary(file)
			a.e = 1
			res.embedded++
		} else {
			var name = api.getFileNameFromPath(file)
			var target = outDir + '/images/' + name
			if (target !== file) {
				if (api.filePathExists(target)) api.deleteFilePath(target)
				if (!api.copyFilePath(file, target)) return
			}
			a.u = 'images/'
			a.p = name
			res.copied++
		}
		if (jpeg) api.deleteFilePath(file)
	})
	return res
}
