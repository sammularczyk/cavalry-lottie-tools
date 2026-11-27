// Image assets after export: embed them in the JSON as data URIs, copy them next to it
// in images/, or collect them for a .lottie's i/ folder. Optionally re-encodes opaque
// PNGs as JPEG (macOS `sips`; elsewhere images stay as they are).

import { fromBase64 } from './zip.js'

var JPEG_QUALITY = '85'

function isImage(a) {
	return a && !a.layers && typeof a.p === 'string' && a.e !== 1 && a.p.indexOf('data:') !== 0
}

function findSource(a, dirs) {
	// precomp exports record their own folder in u
	if (/^([a-zA-Z]:)?\//.test(a.u || '') && api.filePathExists(a.u + a.p)) return a.u + a.p
	for (var i = 0; i < dirs.length; i++) {
		var f = dirs[i] + '/' + (a.u || '') + a.p
		if (api.filePathExists(f)) return f
	}
	return null
}

// Opaque PNG -> JPEG in scratchDir if that's smaller; returns the file to use.
function toJpeg(src, scratchDir) {
	if (!/\.png$/i.test(src) || api.getPlatform() !== 'macOS') return src
	// runProcess is stripped from some script contexts (measured: it is absent in
	// the MCP host), so a JPEG pass there would throw and lose the whole export.
	if (typeof api.runProcess !== 'function') return src
	var alpha = api.runProcess('sips', ['-g', 'hasAlpha', src])
	if (alpha.error || !/hasAlpha:\s*no/.test(alpha.output)) return src
	var out = scratchDir + '/' + api.getFileNameFromPath(src, false) + '.jpg'
	var r = api.runProcess('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, src, '--out', out])
	if (r.error || !api.filePathExists(out)) return src
	return api.encodeBinary(out).length < api.encodeBinary(src).length ? out : src
}

// Bundle path for external-image JSON exports: <dir>/<stem>/<stem>.json so the
// JSON and its images/ folder travel together. Avoids double-nesting when the
// chosen parent folder already has the same name as the file stem.
export function externalBundlePath(out) {
	var clean = String(out || '').replace(/\\/g, '/')
	var slash = clean.lastIndexOf('/')
	var parent = slash >= 0 ? clean.slice(0, slash) : ''
	var fileName = slash >= 0 ? clean.slice(slash + 1) : clean
	var stem = fileName.replace(/\.json$/i, '') || 'animation'
	var parentSlash = parent.lastIndexOf('/')
	var parentName = parentSlash >= 0 ? parent.slice(parentSlash + 1) : parent
	var dir = parentName === stem ? parent : (parent ? parent + '/' + stem : stem)
	return { dir: dir, file: dir + '/' + fileName, folderName: stem }
}

// opts: { embed, jpeg, scratchDir, lottie: [] (collects { name, data } for i/) }
// -> { embedded, copied, jpeg, missing }
export function packImages(json, dirs, outDir, opts) {
	var res = { embedded: 0, copied: 0, jpeg: 0, missing: 0 }
	var names = {} // file name -> source, so two different images can't share one
	var unique = function (name, src, id) {
		if (names[name] && names[name] !== src) name = id + '_' + name
		names[name] = src
		return name
	}
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
		if (opts.lottie) {
			// dotLottie 2: u "/i/", e 0, and a size (ThorVG reads sizeless assets as audio)
			var entry = 'i/' + unique(api.getFileNameFromPath(file, true), src, a.id)
			if (!opts.lottie.some(function (f) { return f.name === entry })) opts.lottie.push({ name: entry, data: fromBase64(api.encodeBinary(file)), store: true })
			a.u = '/i/'
			a.p = entry.slice(2)
			a.e = 0
			res.copied++
		} else if (opts.embed) {
			var ext = (api.getExtensionFromPath(file) || 'png').replace('.', '').toLowerCase()
			a.u = ''
			a.p = 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + api.encodeBinary(file)
			a.e = 1
			res.embedded++
		} else {
			var name = unique(api.getFileNameFromPath(file, true), src, a.id)
			var imgDir = outDir + '/images'
			if (!api.isDirectory(imgDir)) api.makeFolder(imgDir)
			var target = imgDir + '/' + name
			if (target !== file) {
				if (api.filePathExists(target)) api.deleteFilePath(target)
				if (!api.copyFilePath(file, target)) return
			}
			a.u = 'images/'
			a.p = name
			a.e = 0
			res.copied++
		}
		if (jpeg) api.deleteFilePath(file)
	})
	return res
}
