// Lottie Exporter Pro
// Preflight: checks a comp (or any Lottie file) against the players you target.
// Export: exports a comp with Cavalry's own Lottie writer, then optimises the JSON with
// selectable passes. Also optimises any existing Lottie file.

import { PASSES, optimise } from './modules/passes.js'
import { PLAYERS, checkLottie, describePlayers } from './modules/players.js'
import { theme, label, section, button, row, toggleRow, list, tabStrip } from './modules/ui/kit.js'
import { checkForUpdate } from './modules/updateChecker.js'
import { exportComp, copyImages, BAKE_MODES } from './modules/cavalryExport.js'
import { exportWithPrecomps } from './modules/precomps.js'

var GITHUB_REPO = 'phillip-motion/cavalry-lottie-tools' // ponytail: confirm owner before first release
var SCRIPT_NAME = 'Lottie Exporter Pro'
var PREF_KEY = 'lottieTools_exporter'

// ---------- settings ----------

function defaults() {
	var s = { exponent: true, pretty: false, stripNames: false, holdAll: false, precomps: true, bakeMode: 0, tab: 0, targets: ['webSvg', 'android', 'iosCA', 'thorvg'] }
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
			for (var k in s) if (saved[k] !== undefined && typeof saved[k] === typeof s[k]) s[k] = saved[k]
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

var T = theme()
var FATAL = '#e5534b'

// Tooltip (long) and row detail (one short line) per pass.
var TIPS = {
	removeHidden: ['Hidden layers and shapes (hd). Parents and matte sources are kept.', 'Hidden layers and shapes'],
	removeDeadLayers: ['Layers with an empty time range or opacity 0 the whole time.', 'Never on screen'],
	flattenShapeGroups: ['A shape group that is the only item at its level and has an identity transform gives its contents to the level above. Fills, strokes and modifiers keep the same scope, so nothing drawn changes. Cavalry nests every path in groups inside groups.', 'Groups inside groups → flat'],
	foldStaticParents: ['Group layers that draw nothing and never move are folded into their children’s transforms and removed. Cavalry writes every group as a layer, which roughly doubles files.', 'Still groups → merged into children'],
	removeIdentityNulls: ['Null layers that do not move anything (Cavalry adds one per comp).', 'Nulls that move nothing'],
	removeUnusedAssets: ['Images and precomps no layer refers to.', 'Nothing refers to them'],
	dedupeAssets: ['Identical precomps or images become one asset.', 'Identical precomps and images'],
	trimToLayerRange: ['Keyframes outside each layer’s in/out range, keeping one on each side.', 'Keys outside each layer’s range'],
	instanceLayers: ['Layers with identical content are written once as a precomp and reused. Cavalry writes every duplicate and comp reference out in full; After Effects exports share precomps.', 'Duplicate layers → one shared precomp'],
	collapseStatic: ['Animated properties whose keys all hold the same value.', 'Keys that all hold one value'],
	removeRedundantKeys: ['Keys inside a constant run, or exactly on a straight line.', 'Keys that change nothing'],
	trimKeyframeFields: ['Tangents on hold and last keys, legacy end values; linear eases written short.', 'Unused tangents and end values'],
	removeDefaults: ['Zero skew, auto-orient off, empty names.', 'Zero skew, empty names'],
	unwrapScalars: ['Store [5] as 5 on static values.', '[5] → 5'],
	stripMeta: ['ln, cl, meta and effect match names.', 'ln, cl, meta, match names'],
	holdJumps: ['Players draw in-between frames on fast displays, so a value that jumps from one frame to the next (a baked path wrapping round, a layer snapping into place) would slide. Holds the key before each one-frame jump, as Cavalry shows it.', 'Snaps stay snaps between frames'],
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

function page() {
	var l = new ui.VLayout()
	l.setMargins(0, 0, 0, 0)
	l.setSpaceBetween(8)
	return l
}

// ---------- shared: comp picker + status ----------

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

var status = label('', 11, T.muted)

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

function selectedComp() {
	return compIds[compDrop.getValue()]
}

// -> { json, dirs, note }
function exportSelected() {
	var opts = { bakeMode: settings.bakeMode > 0 ? settings.bakeMode - 1 : null }
	if (!settings.precomps) {
		var e = exportComp(selectedComp(), opts)
		return { json: e.json, dirs: [e.dir], note: '' }
	}
	var r = exportWithPrecomps(selectedComp(), opts)
	var note = r.refs ? r.refs + ' comp reference(s) → ' + r.precomps + ' precomp(s)' : ''
	if (r.pivots || r.baked) note += (note ? ' · ' : '') + (r.pivots + r.baked) + ' position(s) corrected'
	return { json: r.json, dirs: r.dirs, note: note }
}

// ---------- preflight page ----------

var preflight = page()
preflight.add(section('Target players', T))
var targets = list(160, T)
PLAYERS.forEach(function (p) {
	targets.layout.add(
		toggleRow(p.label, null, settings.targets.indexOf(p.id) >= 0, T, function (on) {
			settings.targets = settings.targets.filter(function (id) {
				return id !== p.id
			})
			if (on) settings.targets.push(p.id)
			save()
		}).widget
	)
})
targets.layout.addStretch()
preflight.add(targets.widget)

var checkRow = new ui.HLayout()
checkRow.setSpaceBetween(6)
checkRow.add(button('Check comp', true, function () {
	guarded(checkComp)
}, T).widget)
checkRow.add(button('Check file…', false, function () {
	guarded(checkFile)
}, T).widget)
preflight.add(checkRow)

var resultsHead = section('Results', T)
preflight.add(resultsHead)
var results = list(220, T)
results.layout.add(label('Check a comp or a file to see what your players can’t show.', 11, T.muted))
results.layout.addStretch()
preflight.add(results.widget)

var WORST_COLOR = { fatal: FATAL, dropped: T.warn }

// Fill the results list; returns how many issues stop a target player loading the file.
function showResults(issues, what) {
	results.layout.clear()
	resultsHead.setText('RESULTS · ' + what.toUpperCase())
	if (!issues.length) results.layout.add(label('Nothing here that your players can’t show.', 11, T.muted))
	issues.forEach(function (i) {
		var levels = Object.keys(i.players).map(function (id) {
			return i.players[id]
		})
		var worst = levels.indexOf('fatal') >= 0 ? 'fatal' : levels.indexOf('dropped') >= 0 ? 'dropped' : null
		var where = i.where.slice(0, 8).join('\n') + (i.where.length > 8 ? '\n…and ' + (i.where.length - 8) + ' more' : '')
		results.layout.add(
			row(i.feature.label + (i.where.length > 1 ? '  ×' + i.where.length : ''), describePlayers(i.players) || i.feature.note, T, {
				titleColor: WORST_COLOR[worst] || T.text,
				tip: i.feature.note + '\n\n' + where,
			}).widget
		)
	})
	results.layout.addStretch()
	return issues.filter(function (i) {
		return Object.keys(i.players).some(function (id) {
			return i.players[id] === 'fatal'
		})
	}).length
}

function summary(issues, fatal) {
	if (!issues.length) return 'Preflight: no problems for your players.'
	return 'Preflight: ' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + (fatal ? ', ' + fatal + ' that stop a player loading the file' : '') + '. See the Preflight tab.'
}

function checkComp() {
	var comp = selectedComp()
	if (!comp) return
	status.setText('Exporting ' + api.getNiceName(comp) + ' to check it…')
	var issues = checkLottie(exportSelected().json, settings.targets)
	status.setText(summary(issues, showResults(issues, api.getNiceName(comp))))
}

function checkFile() {
	var path = api.presentOpenFile(api.getProjectPath() || api.getDesktopFolder(), 'Check Lottie', 'Lottie JSON (*.json)')
	if (!path) return
	var issues = checkLottie(JSON.parse(api.readFromFile(path)), settings.targets)
	status.setText(summary(issues, showResults(issues, api.getFileNameFromPath(path))))
}

// ---------- export page ----------

var exportPage = page()
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
exportPage.add(bakeDrop)
exportPage.add(
	optionRow(
		'precomps',
		'Comp references as precomps',
		'Exports each referenced comp once and uses it as a Lottie precomp, with its time offset and time remapping. Also checks every layer against the scene and corrects positions Cavalry’s writer gets wrong around pivots. Turn off to use Cavalry’s own export as-is.',
		'Fixes nested comps, timing and pivots'
	)
)

exportPage.add(section('Optimise', T))
var opts = list(260, T)
;['lossless', 'lossy'].forEach(function (group) {
	opts.layout.add(label(group === 'lossy' ? 'Lossy · within a fraction of a pixel' : 'Lossless', 10, T.muted))
	PASSES.forEach(function (p) {
		var tip = TIPS[p.id] || [p.label, '']
		if (p.group === group) opts.layout.add(optionRow(p.id, p.label, tip[0], tip[1]))
	})
})
opts.layout.add(optionRow('holdAll', 'Hold every frame-by-frame key', 'Every key one frame from the next holds until the next frame, so playback steps exactly like Cavalry’s frames even on 120 Hz screens. Smooth baked motion then steps at the comp’s frame rate.', 'Exact Cavalry frames, no in-betweens'))
opts.layout.add(label('Output', 10, T.muted))
opts.layout.add(optionRow('stripNames', 'Strip layer and shape names', 'Keeps names that expressions refer to. Leave off if apps look layers up by name (iOS/Android KeyPaths).', 'Breaks name lookups in apps'))
opts.layout.add(optionRow('exponent', 'Short number format', 'Writes very small and very large numbers in exponent form.', '0.000001 → 1e-6'))
opts.layout.add(optionRow('pretty', 'Pretty print', 'Indented JSON for reading; much larger.', 'Readable, much larger'))
opts.layout.addStretch()
exportPage.add(opts.widget)

var exportRow = new ui.HLayout()
exportRow.setSpaceBetween(6)
exportRow.add(button('Export comp…', true, function () {
	guarded(runExport)
}, T).widget)
exportRow.add(button('Optimise file…', false, function () {
	guarded(runOptimiseFile)
}, T).widget)
exportPage.add(exportRow)

// ---------- run ----------

var kb = function (n) {
	return (n / 1024).toFixed(1) + ' KB'
}

function passSettings() {
	var o = { exponent: settings.exponent, pretty: settings.pretty }
	PASSES.forEach(function (p) {
		o[p.id] = settings[p.id]
	})
	if (settings.stripMeta) o.stripMeta = { names: settings.stripNames }
	if (settings.holdJumps) o.holdJumps = { all: settings.holdAll }
	return o
}

// Optimise, write, then preflight the result for the selected players.
function optimiseAndWrite(json, out, extra) {
	var result = optimise(json, passSettings())
	if (!api.writeToFile(out, result.text, true)) {
		status.setText('Could not write ' + out)
		return
	}
	var r = result.report
	var issues = checkLottie(result.json, settings.targets)
	var lines = (extra || []).concat([
		kb(r[0].bytes) + ' → ' + kb(r[r.length - 1].bytes) + ' (' + Math.round(100 - (100 * r[r.length - 1].bytes) / r[0].bytes) + '% smaller) · saved ' + api.getFileNameFromPath(out),
		summary(issues, showResults(issues, api.getFileNameFromPath(out))),
	])
	status.setText(lines.join('\n'))
	var changed = r.filter(function (x) {
		return x.changes
	})
	console.log(SCRIPT_NAME + ': ' + lines.join(' | ') + ' | passes: ' + changed.map(function (x) {
		return x.id + ' ' + x.changes
	}).join(', '))
}

function runOptimiseFile() {
	var path = api.presentOpenFile(api.getProjectPath() || api.getDesktopFolder(), 'Optimise Lottie', 'Lottie JSON (*.json)')
	if (!path) return
	optimiseAndWrite(JSON.parse(api.readFromFile(path)), path.replace(/(\.min)?\.json$/i, '') + '.min.json')
}

function runExport() {
	var comp = selectedComp()
	if (!comp) return
	var out = api.presentSaveFile(api.getProjectPath() || api.getDesktopFolder(), 'Export Lottie', 'Lottie JSON (*.json)', api.getNiceName(comp) + '.json')
	if (!out) return
	if (!/\.json$/i.test(out)) out += '.json'
	status.setText('Exporting…')
	var exported = exportSelected()
	var images = 0
	exported.dirs.forEach(function (d) {
		images += copyImages(d, api.getFolderFromPath(out))
	})
	var extra = []
	if (exported.note) extra.push(exported.note)
	if (images) extra.push(images + ' image(s) copied to images/')
	optimiseAndWrite(exported.json, out, extra)
}

// ---------- window ----------

// PageView, not TabView: TabView can't be styled, so the strip drives the pages (Easey).
var pages = new ui.PageView()
pages.add(preflight)
pages.add(exportPage)
var tabs = tabStrip(
	[
		{ label: 'Preflight', icon: 'preflight' },
		{ label: 'Export', icon: 'export' },
	],
	function (i) {
		pages.setPage(i)
		settings.tab = i
		save()
	},
	T
)
var startTab = settings.tab === 1 ? 1 : 0
pages.setPage(startTab)
tabs.setSelected(startTab)

var root = new ui.VLayout()
root.setMargins(4, 4, 4, 4)
root.setSpaceBetween(8)
root.add(tabs.widget)
root.add(compRow)
root.add(pages) // a PageView inside a Container stops rendering, so it goes straight in
root.add(status)
root.addStretch()

ui.setTitle(SCRIPT_NAME)
ui.add(root)
ui.setBackgroundColor(T.bg)
ui.setMinimumWidth(320)
ui.show()

checkForUpdate(GITHUB_REPO, SCRIPT_NAME, PRODUCT_VERSION)
