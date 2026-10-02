// Lottie Optimiser
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
var SCRIPT_NAME = 'Lottie Optimiser'
var PREF_KEY = 'lottieTools_exporter' // old key kept so saved settings carry over

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
	removeHidden: ['Anything you hid in Cavalry is left out. Layers other layers depend on (parents, mattes) are kept.', 'Leaves out hidden layers'],
	removeDeadLayers: ['Layers that are never on screen: fully transparent the whole time, or outside the timeline.', 'Leaves out layers you never see'],
	flattenShapeGroups: ['Cavalry wraps every shape in several empty groups. This unwraps groups that do nothing, so the shape looks exactly the same.', 'Unwraps empty shape groups'],
	foldStaticParents: ['Cavalry writes every group as its own layer. Groups that don’t move or draw anything are merged into their children, which often halves the file.', 'Merges still groups into their children'],
	removeIdentityNulls: ['Removes empty nulls that don’t move anything. Cavalry adds one per comp.', 'Removes nulls that do nothing'],
	removeUnusedAssets: ['Removes images and comps that no layer uses.', 'Removes unused images and comps'],
	dedupeAssets: ['When the same image or comp is in the file twice, keeps one copy.', 'Keeps one copy of duplicates'],
	trimToLayerRange: ['Removes keyframes from before a layer starts and after it ends.', 'Removes keys outside a layer’s time'],
	instanceLayers: ['When layers are exact copies (duplicators, repeated comps), the content is written once and reused. Cavalry writes every copy out in full.', 'Writes repeated content once'],
	collapseStatic: ['A property whose keyframes all hold the same value becomes a plain value.', 'Turns “animated” constants into values'],
	removeRedundantKeys: ['Removes keyframes that don’t change the motion: repeats, or keys on a straight line.', 'Removes keys that change nothing'],
	trimKeyframeFields: ['Removes keyframe data that players never read.', 'Removes unused keyframe data'],
	removeDefaults: ['Leaves out settings that already match the default.', 'Leaves out default settings'],
	unwrapScalars: ['Writes single values more compactly.', 'Writes single values more compactly'],
	stripMeta: ['Removes notes and labels that only After Effects or Cavalry use.', 'Removes editor-only notes'],
	holdJumps: ['Phones and 120 Hz screens draw frames in between yours. A value that snaps from one frame to the next would slide; this keeps it a snap, as in Cavalry.', 'Snaps stay snaps on fast screens'],
	recoverRigidMotion: ['Baked duplicators and deformers store every shape again on every frame. Copies that only move, turn or scale become one shape plus an animated transform. Usually the biggest saving.', 'Turns baked shapes back into motion'],
	simplifyKeys: ['Baked motion has a keyframe on every frame. Removes keys you couldn’t see were missing: the result stays within ¼ px (or ¼°, ¼%) of the original.', 'Removes keys that aren’t visibly needed'],
	roundPrecision: ['Rounds numbers to a precision you can’t see: positions to 0.01 px, opacity to 0.1%, colours to 0.001.', 'Rounds to invisible precision'],
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
// Labels follow BAKE_MODES order.
;['Baking: use each layer’s setting', 'Baking: automatic for every layer', 'Baking: shapes every frame', 'Baking: shapes and colours every frame', 'Baking: one layer per frame (largest)', 'Baking: freeze, no animation'].forEach(function (l) {
	bakeDrop.addEntry(l)
})
bakeDrop.setValue(settings.bakeMode)
bakeDrop.setToolTip('How Cavalry turns things Lottie can’t describe (duplicators, deformers, behaviours) into keyframes. Applies to this export only; your layers’ settings are put back afterwards. Automatic is usually best; the optimiser shrinks baked frames afterwards.')
bakeDrop.onValueChanged = function () {
	settings.bakeMode = bakeDrop.getValue()
	save()
}
exportPage.add(bakeDrop)
exportPage.add(
	optionRow(
		'precomps',
		'Comp references as precomps',
		'Writes each comp once and reuses it, so nested comps keep animating with the right timing. Also fixes positions Cavalry’s exporter gets wrong around pivots. Turn off to use Cavalry’s export unchanged.',
		'Fixes nested comps, timing and pivots'
	)
)

exportPage.add(section('Optimise', T))
var opts = list(260, T)
;['lossless', 'lossy'].forEach(function (group) {
	opts.layout.add(label(group === 'lossy' ? 'Near-lossless · changes you can’t see' : 'Lossless · nothing changes on screen', 10, T.muted))
	PASSES.forEach(function (p) {
		var tip = TIPS[p.id] || [p.label, '']
		if (p.group === group) opts.layout.add(optionRow(p.id, p.label, tip[0], tip[1]))
	})
})
opts.layout.add(optionRow('holdAll', 'Hold every frame-by-frame key', 'Plays exactly Cavalry’s frames, with no in-between frames on fast screens. Smooth baked motion will step at your comp’s frame rate.', 'Exact frames, no in-betweens'))
opts.layout.add(label('Output', 10, T.muted))
opts.layout.add(optionRow('stripNames', 'Strip layer and shape names', 'Smaller file. Leave off if a developer changes colours or text from code, since apps find layers by name.', 'Leave off if apps find layers by name'))
opts.layout.add(optionRow('exponent', 'Short number format', 'Writes tiny and huge numbers in short form. Every player reads it.', '0.000001 → 1e-6'))
opts.layout.add(optionRow('pretty', 'Pretty print', 'Spaced out so people can read it. Much larger; use for debugging only.', 'Readable, much larger'))
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
