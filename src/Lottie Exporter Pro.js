// Lottie Exporter Pro
// Exports a comp with Cavalry's own Lottie writer, then optimises the JSON with
// selectable passes. Also optimises any existing Lottie file.
// Player preflight and asset embedding come next.

import { PASSES, optimise } from './modules/passes.js'
import { theme, label, section, button, toggleRow, list } from './modules/ui/kit.js'
import { checkForUpdate } from './modules/updateChecker.js'
import { exportComp, copyImages, BAKE_MODES } from './modules/cavalryExport.js'

var GITHUB_REPO = 'phillip-motion/cavalry-lottie-tools' // ponytail: confirm owner before first release
var SCRIPT_NAME = 'Lottie Exporter Pro'
var PREF_KEY = 'lottieTools_exporter'

// ---------- settings ----------

function defaults() {
	var s = { exponent: true, pretty: false, stripNames: false, bakeMode: 0 }
	PASSES.forEach(function (p) {
		s[p.id] = p.on
	})
	return s
}

function loadSettings() {
	var s = defaults()
	try {
		if (api.hasPreferenceObject(PREF_KEY)) {
			var saved = api.getPreferenceObject(PREF_KEY)
			for (var k in s) if (typeof saved[k] === typeof s[k]) s[k] = saved[k]
		}
	} catch (e) {}
	return s
}

var settings = loadSettings()
function save() {
	try {
		api.setPreferenceObject(PREF_KEY, settings)
	} catch (e) {}
}

// ---------- widgets ----------

var T = theme()

// Tooltip (long) and row detail (one short line) per pass.
var TIPS = {
	removeHidden: ['Hidden layers and shapes (hd). Parents and matte sources are kept.', 'Hidden layers and shapes'],
	removeDeadLayers: ['Layers with an empty time range or opacity 0 the whole time.', 'Never on screen'],
	removeIdentityNulls: ['Null layers that do not move anything (Cavalry adds one per comp).', 'Nulls that move nothing'],
	removeUnusedAssets: ['Images and precomps no layer refers to.', 'Nothing refers to them'],
	dedupeAssets: ['Identical precomps or images become one asset.', 'Identical precomps and images'],
	trimToLayerRange: ['Keyframes outside each layer’s in/out range, keeping one on each side.', 'Keys outside each layer’s range'],
	collapseStatic: ['Animated properties whose keys all hold the same value.', 'Keys that all hold one value'],
	removeRedundantKeys: ['Keys inside a constant run, or exactly on a straight line.', 'Keys that change nothing'],
	trimKeyframeFields: ['Tangents on hold and last keys, legacy end values; linear eases written short.', 'Unused tangents and end values'],
	removeDefaults: ['Zero skew, auto-orient off, empty names.', 'Zero skew, empty names'],
	unwrapScalars: ['Store [5] as 5 on static values.', '[5] → 5'],
	stripMeta: ['ln, cl, meta and effect match names.', 'ln, cl, meta, match names'],
	recoverRigidMotion: ['Baked duplicator/deformer copies that only move, turn or scale keep one path and animate their transform instead. Biggest saving on baked scenes.', 'Baked copies → one path + transform'],
	simplifyKeys: ['Drops baked keys that lie within a fraction of a pixel (or degree, or %) of a straight line between their neighbours.', 'Baked keys within ¼ px of a line'],
	roundPrecision: ['Positions and paths to 0.01 px, opacity to 0.1, colours to 0.001.', '0.01 px, 0.1 opacity, 0.001 colour'],
}

function optionRow(key, title, tip, detail) {
	return toggleRow(title, detail, settings[key], T, function (on) {
		settings[key] = on
		save()
	}, tip).widget
}

var root = new ui.VLayout()
root.setMargins(4, 4, 4, 4)
root.setSpaceBetween(8)

// export: comp, bake override, the main action
root.add(section('Export', T))
var compDrop = new ui.DropDown()
var compIds = []
function refreshComps() {
	compDrop.clear()
	compIds = api.getComps()
	var active = api.getActiveComp()
	compIds.forEach(function (id) {
		compDrop.addEntry(api.getNiceName(id))
	})
	var i = compIds.indexOf(active)
	if (i >= 0) compDrop.setValue(i)
}
refreshComps()
var compRow = new ui.HLayout()
compRow.setSpaceBetween(6)
compRow.add(compDrop)
var refresh = button('↻', false, refreshComps, T)
refresh.widget.setFixedWidth(30)
refresh.widget.setToolTip('Refresh the comp list')
compRow.add(refresh.widget)
root.add(compRow)

var bakeDrop = new ui.DropDown()
bakeDrop.addEntry('Bake: as set on each layer')
BAKE_MODES.forEach(function (m) {
	bakeDrop.addEntry('Bake: force ' + m)
})
bakeDrop.setValue(settings.bakeMode)
bakeDrop.setToolTip('Overrides each layer’s Lottie Baking for this export only; your scene is restored afterwards.')
bakeDrop.onValueChanged = function () {
	settings.bakeMode = bakeDrop.getValue()
	save()
}
root.add(bakeDrop)
var exportBtn = button('Export comp…', true, function () {
	guarded(runExport)
}, T)
root.add(exportBtn.widget)

// optimisation passes, grouped, in a recessed list
var optHead = section('Optimise', T)
root.add(optHead)
var opts = list(300, T)
;['lossless', 'lossy'].forEach(function (group) {
	opts.layout.add(label(group === 'lossy' ? 'Lossy · within a fraction of a pixel' : 'Lossless', 10, T.muted))
	PASSES.forEach(function (p) {
		if (p.group === group) opts.layout.add(optionRow(p.id, p.label, TIPS[p.id][0], TIPS[p.id][1]))
	})
})
opts.layout.add(label('Output', 10, T.muted))
opts.layout.add(optionRow('stripNames', 'Strip layer and shape names', 'Keeps names that expressions refer to. Leave off if apps look layers up by name (iOS/Android KeyPaths).', 'Breaks name lookups in apps'))
opts.layout.add(optionRow('exponent', 'Short number format', 'Writes very small and very large numbers in exponent form.', '0.000001 → 1e-6'))
opts.layout.add(optionRow('pretty', 'Pretty print', 'Indented JSON for reading; much larger.', 'Readable, much larger'))
opts.layout.addStretch()
root.add(opts.widget)

var optimiseBtn = button('Optimise existing file…', false, function () {
	guarded(run)
}, T)
root.add(optimiseBtn.widget)

var status = label('Optimising an existing file writes <name>.min.json next to it.', 11, T.muted)
root.add(status)
root.addStretch()

function guarded(fn) {
	ui.setCallbacksActive(false) // no hover/click callbacks into the panel while work runs
	try {
		fn()
	} catch (e) {
		status.setText('Failed: ' + ((e && e.message) || e))
		console.error(SCRIPT_NAME + ': ' + ((e && e.stack) || e))
	} finally {
		ui.setCallbacksActive(true)
	}
}

// ---------- run ----------

var kb = function (n) {
	return (n / 1024).toFixed(1) + ' KB'
}

function passSettings() {
	var opts = { exponent: settings.exponent, pretty: settings.pretty }
	PASSES.forEach(function (p) {
		opts[p.id] = settings[p.id]
	})
	if (settings.stripMeta) opts.stripMeta = { names: settings.stripNames }
	return opts
}

function optimiseAndWrite(json, out, extra) {
	var result = optimise(json, passSettings())
	if (!api.writeToFile(out, result.text, true)) {
		status.setText('Could not write ' + out)
		return
	}
	var r = result.report
	var lines = (extra || []).concat([kb(r[0].bytes) + ' → ' + kb(r[r.length - 1].bytes) + ' (' + Math.round(100 - (100 * r[r.length - 1].bytes) / r[0].bytes) + '% smaller)'])
	r.forEach(function (x) {
		if (x.changes) lines.push('  ' + x.id + ': ' + x.changes)
	})
	if (result.expressions) lines.push('Contains expressions: lottie_light, Android and iOS ignore them.')
	lines.push('Saved ' + api.getFileNameFromPath(out))
	status.setText(lines.join('\n'))
	console.log(SCRIPT_NAME + ': ' + lines.join(' | '))
}

function run() {
	var start = api.getProjectPath() || api.getDesktopFolder()
	var path = api.presentOpenFile(start, 'Optimise Lottie', 'Lottie JSON (*.json)')
	if (!path) return
	var json
	try {
		json = JSON.parse(api.readFromFile(path))
	} catch (e) {
		status.setText('Could not read JSON: ' + e.message)
		return
	}
	optimiseAndWrite(json, path.replace(/(\.min)?\.json$/i, '') + '.min.json')
}

function runExport() {
	var comp = compIds[compDrop.getValue()]
	if (!comp) return
	var start = api.getProjectPath() || api.getDesktopFolder()
	var out = api.presentSaveFile(start, 'Export Lottie', 'Lottie JSON (*.json)', api.getNiceName(comp) + '.json')
	if (!out) return
	if (!/\.json$/i.test(out)) out += '.json'
	status.setText('Exporting…')
	var exported
	try {
		exported = exportComp(comp, { bakeMode: settings.bakeMode > 0 ? settings.bakeMode - 1 : null })
	} catch (e) {
		status.setText('Export failed: ' + e.message)
		return
	}
	var images = copyImages(exported.dir, api.getFolderFromPath(out))
	var extra = ['Cavalry export: ' + kb(exported.text.length)]
	if (images) extra.push(images + ' image(s) copied to images/')
	optimiseAndWrite(exported.json, out, extra)
}

ui.setTitle(SCRIPT_NAME)
ui.add(root)
ui.setMinimumWidth(320)
ui.show()

checkForUpdate(GITHUB_REPO, SCRIPT_NAME, PRODUCT_VERSION)
