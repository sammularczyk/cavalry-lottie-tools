// Lottie Optimiser
// Preflight: checks a comp (or any Lottie file) against the players you target.
// Export: exports a comp with Cavalry's own Lottie writer, then optimises the JSON with
// selectable passes. Also optimises any existing Lottie file.

import { PASSES, optimise, serialise } from './modules/passes.js'
import { PLAYERS, checkLottie, describePlayers } from './modules/players.js'
import { theme, label, section, button, row, toggleRow, list, tabStrip } from './modules/ui/kit.js'
import { checkForUpdate } from './modules/updateChecker.js'
import { exportComp, BAKE_MODES } from './modules/cavalryExport.js'
import { packImages } from './modules/images.js'
import { gzipSize, zip, utf8, base64 } from './modules/zip.js'
import { exportWithPrecomps } from './modules/precomps.js'

var GITHUB_REPO = 'phillip-motion/cavalry-lottie-tools' // ponytail: confirm owner before first release
var SCRIPT_NAME = 'Lottie Optimiser'
var PREF_KEY = 'lottieTools_exporter' // old key kept so saved settings carry over

// ---------- settings ----------

// Options that can change how the animation looks or which apps can use it. Everything
// else is lossless and always on (hidden), so saved settings can't switch it off.
var ADVANCED = ['precomps', 'recoverRigidMotion', 'simplifyKeys', 'simplifyPaths', 'roundPrecision', 'holdAll', 'stripNames', 'embedImages', 'jpegImages', 'pretty']
var ALWAYS = { exponent: true }
PASSES.forEach(function (p) {
	if (ADVANCED.indexOf(p.id) < 0) ALWAYS[p.id] = p.on
})

var PRESETS = [
	{
		label: 'Safe',
		detail: 'Looks identical · keeps names for apps',
		tip: 'Looks identical to Cavalry, and keeps layer names for apps that change colours or text from code. For mobile apps and anything you’re unsure of.',
		values: { accuracy: 0, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, stripNames: false, embedImages: true, jpegImages: false, pretty: false },
	},
	{
		label: 'Smaller',
		detail: 'Under ¼ px of difference · keeps names',
		tip: 'Nothing moves more than ¼ px, which you can’t see. Keeps layer names.',
		values: { accuracy: 1, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, stripNames: false, embedImages: true, jpegImages: false, pretty: false },
	},
	{
		label: 'Extreme',
		detail: 'Smallest · up to 1 px · no names · JPEG',
		tip: 'Smallest file: up to 1 px of difference on sharp edges, no layer names, and opaque images saved as JPEG. Not for apps that find layers by name.',
		values: { accuracy: 3, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, stripNames: true, embedImages: true, jpegImages: true, pretty: false },
	},
]

function currentPreset() {
	for (var i = 0; i < PRESETS.length; i++) {
		var v = PRESETS[i].values, match = true
		for (var k in v) if (settings[k] !== v[k]) match = false
		if (match) return i
	}
	return PRESETS.length // Custom
}

function defaults() {
	var s = { exponent: true, pretty: false, stripNames: false, holdAll: false, precomps: true, bakeMode: 0, tab: 0, accuracy: 1, display: 0, format: 0, embedImages: true, jpegImages: false, advancedOpen: false, targets: ['webSvg', 'android', 'iosCA', 'thorvg'] }
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
	for (var a in ALWAYS) s[a] = ALWAYS[a]
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

// The most anything may move, in pixels at the size the animation plays at.
var ACCURACY = [
	{ label: 'Exact (0.05 px)', px: 0.05 },
	{ label: 'Balanced (¼ px)', px: 0.25 },
	{ label: 'Small file (½ px)', px: 0.5 },
	{ label: 'Smallest (1 px)', px: 1 },
]
var FORMATS = [
	{ label: 'Lottie JSON', json: true },
	{ label: 'dotLottie (.lottie)', lottie: true },
	{ label: 'Both', json: true, lottie: true },
]
var DISPLAY = [
	{ label: 'Full size', scale: 1 },
	{ label: 'Half size', scale: 0.5 },
	{ label: 'Quarter size', scale: 0.25 },
]

// Tooltip (long) and row detail (one short line) per pass.
var TIPS = {
	removeHidden: ['Anything you hid in Cavalry is left out. Layers other layers depend on (parents, mattes) are kept.', 'Leaves out hidden layers'],
	removeDeadLayers: ['Layers that are never on screen: fully transparent the whole time, or outside the timeline.', 'Leaves out layers you never see'],
	flattenShapeGroups: ['Cavalry wraps every shape in several empty groups. This unwraps groups that do nothing, so the shape looks exactly the same.', 'Unwraps empty shape groups'],
	foldStaticParents: ['Cavalry writes every group as its own layer. Groups that don’t move or draw anything are merged into their children, which often halves the file.', 'Merges still groups into their children'],
	removeDoubledPaints: ['Cavalry writes the fill and stroke of every path shape twice, so players paint it twice: see-through colours come out stronger than in Cavalry and edges darker. Keeps one copy, which matches Cavalry exactly.', 'Matches Cavalry, much smaller'],
	mergeShapeLayers: ['Cavalry writes every shape as its own layer; After Effects files hold many shapes in one. Neighbouring shapes with the same parent and timing become groups in one layer. Nothing changes on screen.', 'Many layers → one layer of groups'],
	mergeShapeGroups: ['A filled and stroked path is written as two copies of the path; this keeps one with both. Shapes with the same fill or stroke that don’t touch also share it.', 'One path, shared fills and strokes'],
	removeIdentityNulls: ['Removes empty nulls that don’t move anything. Cavalry adds one per comp.', 'Removes nulls that do nothing'],
	removeUnusedAssets: ['Removes images and comps that no layer uses.', 'Removes unused images and comps'],
	dedupeAssets: ['When the same image or comp is in the file twice, keeps one copy.', 'Keeps one copy of duplicates'],
	trimToLayerRange: ['Removes keyframes from before a layer starts and after it ends.', 'Removes keys outside a layer’s time'],
	instanceLayers: ['When layers are exact copies (duplicators, repeated comps), the content is written once and reused. Cavalry writes every copy out in full.', 'Writes repeated content once'],
	collapseStatic: ['A property whose keyframes all hold the same value becomes a plain value.', 'Turns “animated” constants into values'],
	removeRedundantKeys: ['Removes keyframes that don’t change the motion: repeats, or keys on a straight line.', 'Removes keys that change nothing'],
	trimKeyframeFields: ['Removes keyframe data that players never read.', 'Removes unused keyframe data'],
	removeDefaults: ['Leaves out values every player assumes anyway: positions and anchors at 0, scale 100%, no rotation, full opacity, zero skew, empty names. Checked against the lottie-web, Android, iOS and ThorVG source.', 'Leaves out default values'],
	unwrapScalars: ['Writes single values more compactly.', 'Writes single values more compactly'],
	stripMeta: ['Removes notes and labels that only After Effects or Cavalry use.', 'Removes editor-only notes'],
	holdJumps: ['Phones and 120 Hz screens draw frames in between yours. A value that snaps from one frame to the next would slide; this keeps it a snap, as in Cavalry.', 'Snaps stay snaps on fast screens'],
	recoverRigidMotion: ['Baked duplicators and deformers store every shape again on every frame. Copies that only move, turn or scale become one shape plus an animated transform. Usually the biggest saving.', 'Turns baked shapes back into motion'],
	simplifyKeys: ['Baked motion has a keyframe on every frame. Replaces runs of them with a few eased keys that follow the same motion, checked every half frame: shapes morphing, things moving along curves (as motion paths), fades and colours. Stays within the accuracy you pick.', 'Baked keys → a few smooth keys'],
	simplifyPaths: ['Removes points from still shapes that don’t change the outline: points on straight edges, doubled points and extra points along curves, which are refitted. Corners stay. Skipped on layers with round corners, zig zag, pucker or offset.', 'Fewer points, same outline'],
	roundPrecision: ['Rounds every number to the fewest decimals you can’t see at your accuracy, worked out per layer from how big it’s drawn.', 'Rounds to invisible precision'],
}

// A labelled dropdown that stores its index in settings[key].
function choiceRow(key, title, entries, tip, onChange) {
	var r = new ui.HLayout()
	r.setMargins(8, 2, 8, 2)
	r.setSpaceBetween(6)
	r.add(label(title, 12, T.text))
	r.addStretch()
	var d = new ui.DropDown()
	entries.forEach(function (e) {
		d.addEntry(e.label)
	})
	d.setValue(Math.min(settings[key], entries.length - 1))
	d.setToolTip(tip)
	d.onValueChanged = function () {
		settings[key] = d.getValue()
		save()
		if (onChange) onChange()
	}
	r.add(d)
	return r
}

function optionRow(key, title, tip, detail, onChange) {
	return toggleRow(title, detail, settings[key], T, function (on) {
		settings[key] = on
		save()
		if (onChange) onChange()
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
	status.setText(summary(issues, showResults(issues, api.getFileNameFromPath(path, true))))
}

// ---------- export page ----------

var ROW_TEXT = {
	precomps: ['Comp references as precomps', 'Writes each comp once and reuses it, so nested comps keep animating with the right timing. Also fixes positions Cavalry’s exporter gets wrong around pivots. Turn off to use Cavalry’s export unchanged.', 'Fixes nested comps, timing and pivots'],
	holdAll: ['Hold every frame-by-frame key', 'Plays exactly Cavalry’s frames, with no in-between frames on fast screens. Smooth baked motion will step at your comp’s frame rate.', 'Exact frames, no in-betweens'],
	stripNames: ['Strip layer and shape names', 'Smaller file. Leave off if a developer changes colours or text from code, since apps find layers by name.', 'Leave off if apps find layers by name'],
	embedImages: ['Embed images in the file', 'Puts images inside the JSON, so it’s one file to hand over. Images grow by a third when embedded. Off: images are saved in an images folder next to the file. A .lottie always holds its images.', 'One file, nothing to lose'],
	jpegImages: ['Save opaque images as JPEG', 'Images with no transparency are saved as JPEG (85% quality) when that’s smaller. Slight JPEG softening. macOS only; Cavalry asks you to trust the script the first time.', 'Smaller, slightly softer'],
	pretty: ['Pretty print', 'Spaced out so people can read it. Much larger; use for debugging only.', 'Readable, much larger'],
}
PASSES.forEach(function (p) {
	if (!ROW_TEXT[p.id] && TIPS[p.id]) ROW_TEXT[p.id] = [p.label, TIPS[p.id][0], TIPS[p.id][1]]
})

var exportPage = page()

// preset, then the two choices that depend on where the file is going
var presetRow = new ui.HLayout()
presetRow.setSpaceBetween(6)
presetRow.add(label('Preset', 12, T.text))
presetRow.addStretch()
var presetDrop = new ui.DropDown()
PRESETS.forEach(function (p) {
	presetDrop.addEntry(p.label)
})
presetDrop.addEntry('Custom')
presetRow.add(presetDrop)
exportPage.add(presetRow)
var presetDetail = label('', 10, T.muted)
exportPage.add(presetDetail)
exportPage.add(choiceRow('format', 'Save as', FORMATS, 'Lottie JSON plays everywhere. dotLottie is the same animation zipped with its images: usually a fifth of the size, for LottieFiles players, the dotLottie runtimes, and lottie-android / lottie-ios. Not lottie-web on its own.'))
exportPage.add(choiceRow('display', 'Plays at', DISPLAY, 'The size the animation is shown at, compared to the comp. Smaller means less detail is needed, so files get smaller. Pick the largest size it’s ever shown at.'))

// Advanced: everything a preset sets, rebuilt whenever a preset changes it
var advHead = row('', null, T, { tip: 'Every option the presets set. Changing one makes the preset Custom.' })
exportPage.add(advHead.widget)
var adv = list(250, T)
exportPage.add(adv.widget)

function showPreset() {
	var i = currentPreset()
	presetDrop.setValue(i)
	presetDetail.setText(i < PRESETS.length ? PRESETS[i].detail : 'Your own mix of the Advanced options')
	presetDrop.setToolTip(i < PRESETS.length ? PRESETS[i].tip : 'Your own mix of the Advanced options. Pick a preset to reset them.')
}

function buildAdvanced() {
	adv.layout.clear() // rebuilt, not reparented (Easey: reparenting rows breaks them)
	var bake = new ui.DropDown()
	// Labels follow BAKE_MODES order.
	;['Baking: use each layer’s setting', 'Baking: automatic for every layer', 'Baking: shapes every frame', 'Baking: shapes and colours every frame', 'Baking: one layer per frame (largest)', 'Baking: freeze, no animation'].forEach(function (l) {
		bake.addEntry(l)
	})
	bake.setValue(settings.bakeMode)
	bake.setToolTip('How Cavalry turns things Lottie can’t describe (duplicators, deformers, behaviours) into keyframes. Applies to this export only; your layers’ settings are put back afterwards. Automatic is usually best; the optimiser shrinks baked frames afterwards.')
	bake.onValueChanged = function () {
		settings.bakeMode = bake.getValue()
		save()
	}
	adv.layout.add(bake)
	adv.layout.add(choiceRow('accuracy', 'Accuracy', ACCURACY, 'The most anything may move from the original, in pixels on screen. Balanced can’t be seen; Smallest can, just, on sharp edges up close.', showPreset))
	ADVANCED.forEach(function (key) {
		var t = ROW_TEXT[key] || [key, '', '']
		adv.layout.add(optionRow(key, t[0], t[1], t[2], showPreset))
	})
	adv.layout.add(button('Deselect all', false, function () {
		ADVANCED.forEach(function (key) {
			settings[key] = false
		})
		save()
		buildAdvanced()
		showPreset()
	}, T).widget)
	adv.layout.addStretch()
}

function showAdvanced() {
	advHead.title.setText((settings.advancedOpen ? '▾  ' : '▸  ') + 'Advanced')
	adv.widget.setHidden(!settings.advancedOpen)
}
advHead.widget.onMousePress = function () {
	settings.advancedOpen = !settings.advancedOpen
	save()
	showAdvanced()
}

presetDrop.onValueChanged = function () {
	var i = presetDrop.getValue()
	if (i >= PRESETS.length) return showPreset() // Custom isn't a preset to apply
	var v = PRESETS[i].values
	for (var k in v) settings[k] = v[k]
	save()
	buildAdvanced()
	showPreset()
}

buildAdvanced()
showPreset()
showAdvanced()

var exportRow = new ui.HLayout()
exportRow.setSpaceBetween(6)
exportRow.add(button('Export comp…', true, function () {
	guarded(runExport)
}, T).widget)
exportRow.add(button('Optimise file…', false, function () {
	guarded(runOptimiseFile)
}, T).widget)
exportPage.add(exportRow)

// ---------- report page ----------

var reportPage = page()
var reportHead = section('Last export', T)
reportPage.add(reportHead)
var reportList = list(380, T)
reportList.layout.add(label('Export or optimise a file to see what each step saved.', 11, T.muted))
reportList.layout.addStretch()
reportPage.add(reportList.widget)

var PASS_LABEL = {}
PASSES.forEach(function (p) {
	PASS_LABEL[p.id] = p.label
})

// report: optimise()'s [{id, bytes, changes}], plus lines for the saved files
function showReport(name, report, saved) {
	reportHead.setText('LAST EXPORT · ' + name.toUpperCase())
	reportList.layout.clear()
	var first = report[0].bytes, last = report[report.length - 1].bytes
	reportList.layout.add(row(kb(first) + ' → ' + kb(last), Math.round(100 - (100 * last) / first) + '% smaller as JSON', T).widget)
	saved.forEach(function (line) {
		reportList.layout.add(row(line, null, T).widget)
	})
	reportList.layout.add(label('What each step saved', 10, T.muted))
	for (var i = 1; i < report.length - 1; i++) {
		var r = report[i], saving = report[i - 1].bytes - r.bytes
		if (!r.changes && !saving) continue
		reportList.layout.add(row(PASS_LABEL[r.id] || r.id, (saving >= 0 ? '−' : '+') + kb(Math.abs(saving)) + ' · ' + r.changes + ' change' + (r.changes === 1 ? '' : 's'), T).widget)
	}
	reportList.layout.addStretch()
}

// ---------- run ----------

var kb = function (n) {
	return (n / 1024).toFixed(1) + ' KB'
}

function passSettings() {
	var o = { exponent: settings.exponent, pretty: settings.pretty, accuracy: (ACCURACY[settings.accuracy] || ACCURACY[1]).px, display: (DISPLAY[settings.display] || DISPLAY[0]).scale }
	PASSES.forEach(function (p) {
		o[p.id] = settings[p.id]
	})
	if (settings.stripMeta) o.stripMeta = { names: settings.stripNames }
	if (settings.holdJumps) o.holdJumps = { all: settings.holdAll }
	return o
}

// Optimise, pack images, write, then preflight the result for the selected players.
// dirs: folders the file's images can be found in.
function optimiseAndWrite(json, out, extra, dirs) {
	var ps = passSettings()
	var result = optimise(json, ps)
	var fmt = FORMATS[settings.format] || FORMATS[0]
	var fmtOpts = { pretty: ps.pretty, exponent: ps.exponent }
	var notes = []
	var saved = []
	if (fmt.lottie) {
		var lj = JSON.parse(JSON.stringify(result.json))
		var files = []
		packImages(lj, dirs, null, { lottie: files, jpeg: settings.jpegImages })
		var id = api.getFileNameFromPath(out, false).replace(/[^A-Za-z0-9_-]+/g, '_') || 'animation'
		var manifest = { version: '2', generator: SCRIPT_NAME, animations: [{ id: id }] }
		var bytes = zip([{ name: 'manifest.json', data: utf8(JSON.stringify(manifest)) }, { name: 'a/' + id + '.json', data: utf8(serialise(lj, fmtOpts)) }].concat(files))
		var lottiePath = out.replace(/\.json$/i, '') + '.lottie'
		if (!api.writeEncodedToBinaryFile(lottiePath, base64(bytes))) {
			status.setText('Could not write ' + lottiePath)
			return
		}
		saved.push(api.getFileNameFromPath(lottiePath, true) + ' ' + kb(bytes.length))
		if (files.length) notes.push(files.length + ' image(s) packed in the .lottie')
	}
	if (fmt.json) {
		var pack = packImages(result.json, dirs, api.getFolderFromPath(out), { embed: settings.embedImages, jpeg: settings.jpegImages })
		if (pack.embedded || pack.copied) result.text = serialise(result.json, fmtOpts)
		if (pack.embedded) notes.push(pack.embedded + ' image(s) embedded')
		if (pack.copied) notes.push(pack.copied + ' image(s) saved to images/')
		if (pack.jpeg) notes.push(pack.jpeg + ' as JPEG')
		if (pack.missing) notes.push(pack.missing + ' image(s) not found')
		if (!api.writeToFile(out, result.text, true)) {
			status.setText('Could not write ' + out)
			return
		}
		saved.unshift(api.getFileNameFromPath(out, true) + ' ' + kb(result.text.length) + ' (' + kb(gzipSize(result.text)) + ' gzipped)')
	}
	result.report[result.report.length - 1].bytes = result.text.length
	if (notes.length) extra = (extra || []).concat([notes.join(' · ')])
	var r = result.report
	var issues = checkLottie(result.json, settings.targets)
	var lines = (extra || []).concat([
		kb(r[0].bytes) + ' → ' + kb(r[r.length - 1].bytes) + ' JSON (' + Math.round(100 - (100 * r[r.length - 1].bytes) / r[0].bytes) + '% smaller) · saved ' + saved.join(', '),
		summary(issues, showResults(issues, api.getFileNameFromPath(out, true))),
	])
	status.setText(lines.join('\n'))
	showReport(api.getFileNameFromPath(out, true), r, saved)
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
	optimiseAndWrite(JSON.parse(api.readFromFile(path)), path.replace(/(\.min)?\.json$/i, '') + '.min.json', [], [api.getFolderFromPath(path)])
}

function runExport() {
	var comp = selectedComp()
	if (!comp) return
	var out = api.presentSaveFile(api.getProjectPath() || api.getDesktopFolder(), 'Export Lottie', 'Lottie JSON (*.json)', api.getNiceName(comp) + '.json')
	if (!out) return
	if (!/\.json$/i.test(out)) out += '.json'
	status.setText('Exporting…')
	var exported = exportSelected()
	optimiseAndWrite(exported.json, out, exported.note ? [exported.note] : [], exported.dirs)
}

// ---------- window ----------

// PageView, not TabView: TabView can't be styled, so the strip drives the pages (Easey).
var pages = new ui.PageView()
pages.add(preflight)
pages.add(exportPage)
pages.add(reportPage)
var tabs = tabStrip(
	[
		{ label: 'Preflight', icon: 'preflight' },
		{ label: 'Export', icon: 'export' },
		{ label: 'Report', icon: 'report' },
	],
	function (i) {
		pages.setPage(i)
		settings.tab = i
		save()
	},
	T
)
var startTab = settings.tab === 1 || settings.tab === 2 ? settings.tab : 0
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
