// Lottie Exporter Pro
// Exports a comp with Cavalry's own Lottie writer, then optimises the JSON with
// selectable passes. Also optimises any existing Lottie file.
// Player preflight, lossy passes and asset embedding come next.

import { PASSES, optimise } from './modules/passes.js'
import { getTokens } from './modules/ui/theme.js'
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

var tokens = getTokens()

function sectionLabel(text) {
	var label = new ui.Label(text.toUpperCase())
	label.setFontSize(11)
	label.setTextColor(tokens.textMuted)
	return label
}

function checkRow(text, tooltip, key) {
	var row = new ui.HLayout()
	var cb = new ui.Checkbox(!!settings[key])
	cb.setToolTip(tooltip || text)
	cb.onValueChanged = function () {
		settings[key] = cb.getValue()
		save()
	}
	var label = new ui.Label(text)
	label.setToolTip(tooltip || text)
	row.add(cb)
	row.add(label)
	row.addStretch()
	return row
}

var TIPS = {
	removeHidden: 'Hidden layers and shapes (hd). Parents and matte sources are kept.',
	removeDeadLayers: 'Layers with an empty time range or opacity 0 the whole time.',
	removeUnusedAssets: 'Images and precomps no layer refers to.',
	dedupeAssets: 'Identical precomps or images become one asset.',
	trimToLayerRange: 'Keyframes outside each layer’s in/out range, keeping one on each side.',
	collapseStatic: 'Animated properties whose keys all hold the same value.',
	removeRedundantKeys: 'Keys inside a constant run, or exactly on a straight line.',
	trimKeyframeFields: 'Tangents on hold and last keys, and legacy end values.',
	unwrapScalars: 'Store [5] as 5 on static values.',
	stripMeta: 'ln, cl, meta and effect match names.',
	removeIdentityNulls: 'Null layers that do not move anything (Cavalry adds one per comp).',
	removeDefaults: 'Zero skew, auto-orient off, empty names.',
	recoverRigidMotion: 'Baked duplicator/deformer copies that only move, turn or scale keep one path and animate their transform instead. Biggest saving on baked scenes.',
	simplifyKeys: 'Drops baked keys that lie within a fraction of a pixel (or degree, or %) of a straight line between their neighbours.',
	roundPrecision: 'Positions and paths to 0.01 px, opacity to 0.1, colours to 0.001.',
}

var layout = new ui.VLayout()
layout.setMargins(8, 8, 8, 8)

// Export section: comp + bake override
layout.add(sectionLabel('Export'))
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
var compRow = new ui.HLayout()
compRow.add(compDrop)
var refresh = new ui.Button('↻')
refresh.setToolTip('Refresh the comp list')
refresh.onClick = refreshComps
compRow.add(refresh)
layout.add(compRow)
layout.add(bakeDrop)
var exportButton = new ui.Button('Export comp…')
layout.add(exportButton)
layout.addSpacing(6)

;['lossless', 'lossy'].forEach(function (group) {
	layout.add(sectionLabel(group === 'lossy' ? 'Lossy (within a fraction of a pixel)' : 'Lossless'))
	PASSES.forEach(function (p) {
		if (p.group === group) layout.add(checkRow(p.label, TIPS[p.id], p.id))
	})
	layout.addSpacing(4)
})
layout.add(checkRow('Strip layer and shape names', 'Keeps names that expressions refer to. Leave off if apps look layers up by name (iOS/Android KeyPaths).', 'stripNames'))
layout.addSpacing(6)
layout.add(sectionLabel('Output'))
layout.add(checkRow('Short number format (1e-6, 123e5)', 'Writes very small and very large numbers in exponent form.', 'exponent'))
layout.add(checkRow('Pretty print', 'Indented JSON for reading; much larger.', 'pretty'))
layout.addSpacing(8)

var button = new ui.Button('Optimise existing file…')
var status = new ui.Label('Optimising an existing file writes <name>.min.json next to it.')
status.setTextColor(tokens.textMuted)
layout.add(button)
layout.add(status)
layout.addStretch()

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

button.onClick = run
exportButton.onClick = runExport

ui.setTitle(SCRIPT_NAME)
ui.add(layout)
ui.setMinimumWidth(320)
ui.show()

checkForUpdate(GITHUB_REPO, SCRIPT_NAME, PRODUCT_VERSION)
