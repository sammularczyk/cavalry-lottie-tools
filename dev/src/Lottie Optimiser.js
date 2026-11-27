// Lottie Optimiser
// Export: exports a comp with Cavalry's own Lottie writer, then optimises the JSON with
// selectable passes. Also optimises any existing Lottie file.
// Report: what each pass saved, and what each Lottie player can't show.

import { PASSES, optimise, serialise } from './modules/passes.js'
import { checkLottie, describePlayers } from './modules/players.js'
import { theme, label, section, button, row, toggleRow, list, tabStrip, icon } from './modules/ui/kit.js'
import { checkForUpdate } from './modules/updateChecker.js'
import { exportComp, BAKE_MODES } from './modules/cavalryExport.js'
import { restructureDuplicators } from './modules/duplicatorRestructure.js'
import { packImages, externalBundlePath } from './modules/images.js'
import { gzipSize, zip, utf8, base64 } from './modules/zip.js'
import { exportWithPrecomps } from './modules/precomps.js'
import { needsTimingMeasurement, timingMeasurementPending, discardTimingMeasurement, prepareTimingMeasurement, collectTimingMeasurement, shouldRetryMeasurement } from './modules/duplicatorCompRefs.js'
import { needsSubMeshMeasurement, prepareSubMeshMeasurement, collectSubMeshMeasurement, discardSubMeshMeasurement } from './modules/subMeshMeasure.js'
import { BUILD_ID } from './modules/buildInfo.js'

var GITHUB_REPO = 'sammularczyk/cavalry-lottie-tools'
var SCRIPT_NAME = 'Lottie Optimiser'
var TAG = '[' + SCRIPT_NAME + '] '
var PREF_KEY = 'lottieTools_exporter' // old key kept so saved settings carry over

// ---------- settings ----------

// Options that can change how the animation looks or which apps can use it. Everything
// else is lossless and always on (hidden), so saved settings can't switch it off.
var ADVANCED = ['precomps', 'gradientStrokeFills', 'recoverRigidMotion', 'shareDuplicatorAnimation', 'simplifyKeys', 'simplifyPaths', 'roundPrecision', 'holdAll', 'refitEased', 'stripNames', 'embedImages', 'jpegImages', 'pretty', 'duplicators']
var ALWAYS = { exponent: true }
PASSES.forEach(function (p) {
	if (ADVANCED.indexOf(p.id) < 0) ALWAYS[p.id] = p.on
})

var PRESETS = [
	{
		label: 'Safe',
		detail: 'Looks identical · keeps names for apps',
		tip: 'Looks identical to Cavalry, and keeps layer names for apps that change colours or text from code. For mobile apps and anything you’re unsure of.',
		values: { accuracy: 0, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, refitEased: false, stripNames: false, embedImages: true, jpegImages: false, pretty: false },
	},
	{
		label: 'Smaller',
		detail: 'Under ¼ px of difference · keeps names',
		tip: 'Nothing moves more than ¼ px, which you can’t see. Keeps layer names.',
		values: { accuracy: 1, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, refitEased: false, stripNames: false, embedImages: true, jpegImages: false, pretty: false },
	},
	{
		label: 'Extreme',
		detail: 'Smallest · up to 1 px · no names · JPEG',
		tip: 'Smallest file: up to 1 px of difference on sharp edges, no layer names, and opaque images saved as JPEG. Not for apps that find layers by name.',
		values: { accuracy: 3, precomps: true, recoverRigidMotion: true, simplifyKeys: true, simplifyPaths: true, roundPrecision: true, holdAll: false, refitEased: false, stripNames: true, embedImages: true, jpegImages: true, pretty: false },
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
	var s = { exponent: true, pretty: false, stripNames: false, holdAll: false, refitEased: false, precomps: true, gradientStrokeFills: true, bakeMode: 0, page: 0, accuracy: 1, display: 0, format: 0, embedImages: true, jpegImages: false, advancedOpen: false, duplicators: true }
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
	simplifyPaths: ['Removes points that don’t change the outline: points on straight edges, doubled points and extra points along curves, which are refitted; baked outlines made of many short straight lines become a few curves. Animated shapes too, on every key, still morphing point to point. Corners stay. Skipped on layers with round corners, zig zag, pucker or offset.', 'Fewer points, same outline'],
	roundPrecision: ['Rounds every number to the fewest decimals you can’t see at your accuracy, worked out per layer from how big it’s drawn.', 'Rounds to invisible precision'],
}

// A labelled dropdown that stores its index in settings[key].
function choiceRow(key, title, entries, tip, onChange) {
	var r = new ui.HLayout()
	r.setMargins(0, 0, 0, 0)
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
	}, tip, adv).widget
}

function page() {
	var l = new ui.VLayout()
	l.setMargins(0, 0, 0, 0)
	l.setSpaceBetween(8)
	return l
}

// ---------- shared: comp picker ----------

var compDrop = new ui.DropDown()
compDrop.setFixedHeight(26) // the refresh button's height
var compIds = []
function refreshComps() {
	compDrop.clear()
	compIds = api.getComps().sort(function (a, b) {
		return api.getNiceName(a).localeCompare(api.getNiceName(b), undefined, { sensitivity: 'base', numeric: true })
	})
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
// an ImageButton centres its icon; a Button with an image and no text sets it to the left
var refresh = new ui.ImageButton(api.getAppAssetsPath() + '/icons/context-menus/reload.png') // Cavalry's own reload icon
refresh.setImageSize(16, 16)
refresh.setFixedWidth(30)
refresh.setFixedHeight(26)
refresh.setDrawStroke(true) // Cavalry's own outline, as on the dropdown
refresh.setBackgroundColor(T.raised)
refresh.setToolTip('Refresh the comp list')
refresh.onClick = refreshComps
compRow.add(refresh)

// the dropdown follows the active comp; not while an export runs, which may switch comps
var busy = false
ui.addCallbackObject({
	onCompChanged: function () {
		if (busy) return
		var i = compIds.indexOf(api.getActiveComp())
		if (i >= 0) compDrop.setValue(i)
		else refreshComps()
	},
	onSceneChanged: function () {
		if (!busy) refreshComps()
	},
})

function guarded(fn) {
	ui.setCallbacksActive(false) // no hover/click callbacks into the panel while work runs
	busy = true
	try {
		fn()
	} catch (e) {
		console.error(TAG + 'Failed: ' + ((e && e.stack) || e))
	} finally {
		busy = false
		ui.setCallbacksActive(true)
	}
}

function showTab(i) {
	pages.setPage(i)
	tabs.setSelected(i)
	settings.page = i
	save()
}

function selectedComp() {
	return compIds[compDrop.getValue()]
}

// -> { json, dirs, note }
function exportSelected(measured) {
	// A playback range narrower than the comp is the part meant to ship. The comp's own
	// startFrame/endFrame stay as authored: lowering startFrame shifts Cavalry's time base,
	// so every frame the exporter reads lands `playbackStart` frames late. A colour cycle
	// cropped to its playback range then starts on the wrong end of the cycle. The crop only
	// names the label range; the exporter asks the render queue for a Custom Range over it,
	// so the Lottie's ip/op are the playback range and the time base never moves.
	var comp = selectedComp()
	var range = {}
	;['startFrame', 'endFrame', 'playbackStart', 'playbackEnd'].forEach(function (a) {
		range[a] = api.get(comp, a)
	})
	var narrow = range.playbackStart > range.startFrame || range.playbackEnd < range.endFrame
	var crop = narrow ? { from: range.playbackStart, to: range.playbackEnd } : null
	if (crop) settings.crop = crop
	try {
		return exportRange(measured, crop)
	} finally {
		if (crop) settings.crop = null
	}
}

function exportRange(measured, crop) {
	var opts = { bakeMode: settings.bakeMode > 0 ? settings.bakeMode - 1 : null, outlineGradientStrokes: settings.gradientStrokeFills, duplicators: settings.duplicators, measuredTiming: measured && measured.timing, measuredPoints: measured && measured.points, measuredSubMesh: measured && measured.subMesh, crop: crop }
	if (!settings.precomps) {
		var e = exportComp(selectedComp(), opts)
		return { json: e.json, dirs: [e.dir], note: '' }
	}
	var r = exportWithPrecomps(selectedComp(), opts)
	var note = r.refs ? r.refs + ' comp reference(s) → ' + r.precomps + ' precomp(s)' : ''
	if (r.pivots || r.baked) note += (note ? ' · ' : '') + (r.pivots + r.baked) + ' position(s) corrected'
	if (r.masks) note += (note ? ' · ' : '') + r.masks + ' mask(s) rebuilt'
	if (r.trackMattes) note += (note ? ' · ' : '') + r.trackMattes + ' track matte(s)'
	if (r.fills) note += (note ? ' · ' : '') + r.fills + ' fill/blur effect(s)'
	if (r.outlined) note += (note ? ' · ' : '') + r.outlined + ' stroke(s) drawn as outlines (tapered or gradient)'
	if (r.warnings && r.warnings.length) note += (note ? '\n' : '') + '⚠ ' + r.warnings.join('\n⚠ ')
	return { json: r.json, dirs: r.dirs, note: note }
}

// ---------- export page ----------

var ROW_TEXT = {
	precomps: ['Comp references as precomps', 'Writes each comp once and reuses it, so nested comps keep animating with the right timing. Also fixes positions Cavalry’s exporter gets wrong around pivots. Turn off to use Cavalry’s export unchanged.', 'Fixes nested comps, timing and pivots'],
	gradientStrokeFills: ['Gradient strokes as fills (Canva)', 'Draws each gradient stroke as a filled outline with the gradient, since Canva refuses gradient strokes but takes gradient fills. Other players draw gradient strokes themselves: turn off for a smaller, exact file with real strokes. Needs comp references as precomps.', 'For Canva uploads'],
	refitEased: ['Experimental: refit eased keys', 'Keyframe fitting also replaces keys that already have eases, staying within your accuracy every half frame. For particles and simulations Cavalry exports as many eased keys; can halve them. Replaces eases you set by hand, and optimising takes longer.', 'Fewer keys, eases not kept'],
	holdAll: ['Hold every frame-by-frame key', 'Plays exactly Cavalry’s frames, with no in-between frames on fast screens. Smooth baked motion will step at your comp’s frame rate.', 'Exact frames, no in-betweens'],
	stripNames: ['Strip layer and shape names', 'Smaller file. Leave off if a developer changes colours or text from code, since apps find layers by name.', 'Leave off if apps find layers by name'],
	embedImages: ['Embed images in the file', 'Puts images inside the JSON, so it’s one file to hand over. Images grow by a third when embedded. Off: saves the JSON and an images/ folder together inside a subfolder named after the file. A .lottie always holds its images.', 'One file, nothing to lose'],
	jpegImages: ['Save opaque images as JPEG', 'Images with no transparency are saved as JPEG (85% quality) when that’s smaller. Slight JPEG softening. macOS only; Cavalry asks you to trust the script the first time.', 'Smaller, slightly softer'],
	pretty: ['Pretty print', 'Spaced out so people can read it. Much larger; use for debugging only.', 'Readable, much larger'],
	shareDuplicatorAnimation: ['Share a duplicator’s animation as one precomp', 'When the copies of a duplicator share one animation, differing only by a time offset, the curve is written once and each copy references it with its own start. Needs the baked transforms to be recovered first, so it runs straight after that pass.', 'One curve instead of 91. Biggest saving on staggered grids.'],
	duplicators: ['Restructure duplicators as precomps', 'Replaces duplicated shape groups with a shared precomp + per-copy offset transforms. Cuts 3.8 MB → 1.6 MB on Composition 4c. May not play in all Lottie players.', '59% smaller on large grids'],
}
PASSES.forEach(function (p) {
	if (!ROW_TEXT[p.id] && TIPS[p.id]) ROW_TEXT[p.id] = [p.label, TIPS[p.id][0], TIPS[p.id][1]]
})

var exportPage = page()
exportPage.add(compRow)

// preset with its detail tight underneath, then the two choices that depend on where the file is going
var presetGroup = new ui.VLayout()
presetGroup.setMargins(0, 0, 0, 0)
presetGroup.setSpaceBetween(2)
var presetRow = new ui.HLayout()
presetRow.setMargins(0, 0, 0, 0)
presetRow.setSpaceBetween(6)
presetRow.add(label('Preset', 12, T.text))
presetRow.addStretch()
var presetDrop = new ui.DropDown()
PRESETS.forEach(function (p) {
	presetDrop.addEntry(p.label)
})
presetDrop.addEntry('Custom')
presetRow.add(presetDrop)
presetGroup.add(presetRow)
var presetDetail = label('', 10, T.muted)
presetGroup.add(presetDetail)
exportPage.add(presetGroup)
exportPage.add(choiceRow('format', 'Save as', FORMATS, 'Lottie JSON plays everywhere. dotLottie is the same animation zipped with its images: usually a fifth of the size, for LottieFiles players, the dotLottie runtimes, and lottie-android / lottie-ios. Not lottie-web on its own.'))
exportPage.add(choiceRow('display', 'Plays at', DISPLAY, 'The size the animation is shown at, compared to the comp. Smaller means less detail is needed, so files get smaller. Pick the largest size it’s ever shown at.'))

// Advanced: everything a preset sets, rebuilt whenever a preset changes it
var advHead = row('', null, T, { tip: 'Every option the presets set. Changing one makes the preset Custom.' })
exportPage.add(advHead.widget)
// baking and accuracy sit above the list, on the page's edges; a Container so they hide with it
var advTopLayout = new ui.VLayout()
advTopLayout.setMargins(0, 0, 0, 0)
advTopLayout.setSpaceBetween(6)
var advTop = new ui.Container()
advTop.setLayout(advTopLayout)
exportPage.add(advTop)
var adv = list(250, T)
exportPage.add(adv.widget)
var deselectAll = button('Deselect all', false, function () {
	ADVANCED.forEach(function (key) {
		settings[key] = false
	})
	save()
	buildAdvanced()
	showPreset()
}, T).widget
exportPage.add(deselectAll)

function showPreset() {
	var i = currentPreset()
	presetDrop.setValue(i)
	presetDetail.setText(i < PRESETS.length ? PRESETS[i].detail : 'Your own mix of the Advanced options')
	presetDrop.setToolTip(i < PRESETS.length ? PRESETS[i].tip : 'Your own mix of the Advanced options. Pick a preset to reset them.')
}

function buildAdvanced() {
	adv.clear() // rebuilt, not reparented (Easey: reparenting rows breaks them)
	advTopLayout.clear()
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
	advTopLayout.add(bake)
	advTopLayout.add(choiceRow('accuracy', 'Accuracy', ACCURACY, 'The most anything may move from the original, in pixels on screen. Balanced can’t be seen; Smallest can, just, on sharp edges up close.', showPreset))
	ADVANCED.forEach(function (key) {
		var t = ROW_TEXT[key] || [key, '', '']
		adv.add(optionRow(key, t[0], t[1], t[2], showPreset))
	})
	adv.end()
}

function showAdvanced() {
	advHead.title.setText((settings.advancedOpen ? '▾  ' : '▸  ') + 'Advanced')
	// ScrollView has no setHidden, and inside a Container it stops rendering: collapse it instead
	adv.widget.setFixedHeight(settings.advancedOpen ? 250 : 0)
	advTop.setHidden(!settings.advancedOpen)
	deselectAll.setHidden(!settings.advancedOpen)
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
exportPage.addStretch() // pack rows at the top; the PageView is as tall as its tallest page

// ---------- report page ----------

var reportPage = page()
var reportList = list(0, T)
reportList.add(label('Export a comp or optimise a file to see a report.', 11, T.muted))
reportList.end()
reportPage.add(reportList.widget)
reportPage.addStretch()

var DANGER = { bg: '#833636', ink: '#ffffff', icon: 'warning', iconColor: '#ff8e8e' }

var PASS_LABEL = {}
PASSES.forEach(function (p) {
	PASS_LABEL[p.id] = p.label
})

// report: optimise()'s [{id, bytes, changes}]; saved: the files written; issues: checkLottie's
function showReport(name, report, saved, issues) {
	reportList.clear()
	var first = report[0].bytes,
		last = report[report.length - 1].bytes
	var text = new ui.VLayout()
	text.setMargins(0, 0, 0, 0)
	text.setSpaceBetween(3)
	text.add(label(name, 12, T.text, 500))
	text.add(label(kbPair(first, last) + ' (' + Math.round(100 - (100 * last) / first) + '% smaller)', 12, T.mix(T.bg, T.text, 0.6)))
	var head = new ui.HLayout()
	head.setMargins(0, 0, 0, 0)
	head.setSpaceBetween(6)
	var iconCol = new ui.VLayout() // the icon sits on the first line, not centred on both
	iconCol.setMargins(0, 2, 0, 0)
	iconCol.add(icon('file', T.accent, T.bg))
	iconCol.addStretch()
	var iconHost = new ui.Container() // fixed width: a bare layout takes half the row
	iconHost.setLayout(iconCol)
	iconHost.setFixedWidth(11)
	head.add(iconHost)
	head.add(text) // no stretch: a squeezed Label wraps
	reportList.layout.add(head)
	reportList.layout.addSpacing(14)
	if (issues.length) {
		reportList.add(section('Warnings', T))
		reportList.layout.addSpacing(6)
		issues.forEach(function (i) {
			var where = i.where.slice(0, 8).join('\n') + (i.where.length > 8 ? '\n…and ' + (i.where.length - 8) + ' more' : '')
			var o = { tip: i.feature.note + '\n\n' + where }
			for (var k in DANGER) o[k] = DANGER[k]
			reportList.add(row(i.feature.label + (i.where.length > 1 ? '  ×' + i.where.length : ''), describePlayers(i.players) || i.feature.note, T, o).widget)
		})
		reportList.layout.addSpacing(10)
	}
	reportList.add(section('Optimised', T)) // a label ends the warnings: their last row takes the bottom corners
	reportList.layout.addSpacing(6)
	for (var i = 1; i < report.length - 1; i++) {
		var r = report[i], before = report[i - 1].bytes
		if (!r.changes && before === r.bytes) continue
		reportList.add(row(PASS_LABEL[r.id] || r.id, kbPair(before, r.bytes) + ' · ' + r.changes + ' change' + (r.changes === 1 ? '' : 's'), T, { tip: saved.join('\n') }).widget)
	}
	reportList.end(false)
}

// ---------- run ----------

var kb = function (n) {
	return (n / 1024).toFixed(1) + ' KB'
}
// "1720.1 → 30.8 KB"
var kbPair = function (a, b) {
	return (a / 1024).toFixed(1) + ' → ' + kb(b)
}

function passSettings() {
	var o = { exponent: settings.exponent, pretty: settings.pretty, accuracy: (ACCURACY[settings.accuracy] || ACCURACY[1]).px, display: (DISPLAY[settings.display] || DISPLAY[0]).scale }
	PASSES.forEach(function (p) {
		o[p.id] = settings[p.id]
	})
	if (settings.stripMeta) o.stripMeta = { names: settings.stripNames }
	if (settings.holdJumps) o.holdJumps = { all: settings.holdAll }
	if (settings.simplifyKeys) o.simplifyKeys = { eased: settings.refitEased }
	return o
}

// Optimise, pack images, write, then check the result against every player.
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
			console.error(TAG + 'Could not write ' + lottiePath)
			return
		}
		saved.push(api.getFileNameFromPath(lottiePath, true) + ' ' + kb(bytes.length))
		if (files.length) notes.push(files.length + ' image(s) packed in the .lottie')
	}
	if (fmt.json) {
		var jsonOut = out
		var imgOutDir = api.getFolderFromPath(out)
		var jsonLabel = api.getFileNameFromPath(out, true)
		if (!settings.embedImages) {
			var bundle = externalBundlePath(out)
			if (!api.isDirectory(bundle.dir)) api.makeFolder(bundle.dir)
			jsonOut = bundle.file
			imgOutDir = bundle.dir
			jsonLabel = bundle.folderName + '/' + jsonLabel
		}
		var pack = packImages(result.json, dirs, imgOutDir, { embed: settings.embedImages, jpeg: settings.jpegImages })
		if (pack.embedded || pack.copied) result.text = serialise(result.json, fmtOpts)
		if (pack.embedded) notes.push(pack.embedded + ' image(s) embedded')
		if (pack.copied) notes.push(pack.copied + ' image(s) saved to ' + (settings.embedImages ? 'images/' : bundle.folderName + '/images/'))
		if (pack.jpeg) notes.push(pack.jpeg + ' as JPEG')
		if (pack.missing) notes.push(pack.missing + ' image(s) not found')
		if (!api.writeToFile(jsonOut, result.text, true)) {
			console.error(TAG + 'Could not write ' + jsonOut)
			return
		}
		saved.unshift(jsonLabel + ' ' + kb(result.text.length) + ' (' + kb(gzipSize(result.text)) + ' gzipped)')
	}
	result.report[result.report.length - 1].bytes = result.text.length
	// warnings to the console one per line; other notes go in the report
	;(extra || []).concat(notes).join('\n').split('\n').forEach(function (n) {
		if (!n) return
		if (/^⚠|not found/.test(n)) console.warn(TAG + n.replace(/^⚠\s*/, ''))
		else console.log(TAG + n)
	})
	var r = result.report
	var name = api.getFileNameFromPath(out, true)
	var issues = checkLottie(result.json) // every player
	showReport(name, r, saved, issues)
	var first = r[0].bytes,
		last = r[r.length - 1].bytes
	var line = 'Saved. ' + kbPair(first, last) + ' (' + kb(gzipSize(result.text)) + ' gzipped) - ' + Math.round(100 - (100 * last) / first) + '% smaller!'
	if (issues.length) console.warn(TAG + 'Issues found - check Report tab. ' + line)
	else console.log(TAG + line)
	showTab(1)
}

function runOptimiseFile() {
	var path = api.presentOpenFile(api.getProjectPath() || api.getDesktopFolder(), 'Optimise Lottie', 'Lottie JSON (*.json)')
	if (!path) return
	var lj = JSON.parse(api.readFromFile(path))

	optimiseAndWrite(lj, path.replace(/(\.min)?\.json$/i, '') + '.min.json', [], [api.getFolderFromPath(path)])
}

// --- deferred timing measurement ---------------------------------------------
// Comp-reference duplicators whose per-copy time offset Cavalry won't decode (a
// driver that isn't a stagger) are measured in a THROWAWAY comp, never in the
// user's own. Cavalry only re-evaluates a duplicator's per-copy sample time in a
// LATER script execution: a render in the same run bakes every copy at one time
// and decodes to all zeros. A Timer callback fires in the panel's idle event
// loop, which is that later execution — verified, the deferred render decodes
// the real offsets to the last decimal. A ui.Modal's nested loop does NOT count.
//
// So one Export click does the whole job: ask for the destination, build the
// probe, arm a Timer, return, and finish the export from the callback.
var TIMING_TIMER_MS = 600 // long enough for the panel to go idle
var TIMING_RETRY_MS = 1500
var deferredTiming = null // { comp, out, attempt } while a measurement is armed
var deferredTimer = null // keep the armed Timer referenced so it cannot be collected

// Every step below can only cost the time offsets: the export itself still runs,
// and the reason lands in the report instead of failing silently.
function failMeasurement(reason) {
	console.error(TAG + reason)
	return { timing: {}, points: {}, notes: ['The timing could not be measured; copies export without time offsets'] }
}

function exportWithMeasurement(comp, out, measurement) {
	if (selectedComp() !== comp) {
		console.warn(TAG + 'Export cancelled: the active comp changed while the timing was being measured.')
		return
	}
	var exported = exportSelected(measurement)
	var note = exported.note || ''
	for (var n of measurement.notes) note += (note ? '\n' : '') + '⚠ ' + n
	optimiseAndWrite(exported.json, out, note ? [note] : [], exported.dirs)
}

function armMeasurement(delayMs) {
	try {
		var timer = new api.Timer({ onTimeout: runDeferredMeasurement })
		timer.setRepeating(false)
		timer.setInterval(delayMs)
		deferredTimer = timer // a local-only Timer could be collected before it fires
		timer.start()
		return true
	} catch (e) {
		deferredTimer = null
		console.error(TAG + 'Could not start the timing measurement: ' + (e && e.message))
		return false
	}
}

function noTiming() {
	return { timing: {}, points: {}, notes: [] }
}

// Sub-mesh measurement: collected once, retried once when the bake came back
// before Cavalry re-evaluated the sampler. Returns true when a retry is wanted.
function collectSubMesh(job) {
	if (!job.subState) return false
	var res
	try {
		res = collectSubMeshMeasurement(job.subState)
	} catch (e) {
		res = { values: {}, notes: ['Per-copy sub-mesh visibility could not be measured: ' + (e && e.message)] }
	}
	job.subState = null
	job.subResult = res
	return !!res.stale && job.subAttempt < 2
}

function runDeferredMeasurement() {
	var job = deferredTiming
	deferredTimer = null
	if (!job) return
	busy = true
	try { ui.setCallbacksActive(false) } catch (e) {}
	var subRetry = collectSubMesh(job)
	var retry = false
	var measurement = job.timingResult || null
	if (job.timing && !measurement) {
		try {
			measurement = collectTimingMeasurement(job.comp)
		} catch (e) {
			measurement = failMeasurement('Timing measurement failed: ' + (e && e.message))
		}
		if (shouldRetryMeasurement(measurement, job.attempt)) {
			// All zeros means the bake was read before Cavalry re-evaluated the
			// duplicator. Try once more on a longer delay before giving up.
			job.attempt = 2
			try {
				prepareTimingMeasurement(job.comp)
				measurement = null
				retry = true
			} catch (e) {
				console.error(TAG + 'Retrying the timing measurement failed: ' + (e && e.message))
			}
		}
		job.timingResult = measurement
	}
	// Rebuilt AFTER the timing probe, for the same snapshot reason as in runExport.
	if (subRetry) {
		job.subAttempt = 2
		try {
			job.subState = prepareSubMeshMeasurement(job.comp)
			if (job.subState) { job.subResult = null; retry = true }
		} catch (e) {
			console.error(TAG + 'Retrying the sub-mesh measurement failed: ' + (e && e.message))
		}
	}
	if (retry && armMeasurement(TIMING_RETRY_MS)) {
		busy = false
		try { ui.setCallbacksActive(true) } catch (e) {}
		return
	}
	// A retry that could not be armed: drop whatever probe it built.
	try { if (job.subState) discardSubMeshMeasurement(job.subState) } catch (e) {}
	try { if (job.timing && !job.timingResult) discardTimingMeasurement() } catch (e) {}
	if (!measurement) measurement = job.timing ? failMeasurement('The timing measurement could not be retried.') : noTiming()
	var sub = job.subResult || { values: {}, notes: [] }
	measurement.subMesh = sub.values
	measurement.notes = (measurement.notes || []).concat(sub.notes)
	deferredTiming = null
	busy = false
	try { ui.setCallbacksActive(true) } catch (e) {}
	try {
		exportWithMeasurement(job.comp, job.out, measurement)
	} finally {
		// The measurements render throwaway comps and delete them. Put the comp
		// the user had open back, so a finished export does not strand them on
		// another comp (or on one that no longer exists).
		try { if (job.from && api.layerExists(job.from)) api.setActiveComp(job.from) } catch (e) {}
		try { if (job.frame != null) api.setFrame(job.frame) } catch (e) {}
	}
}

function runExport() {
	var comp = selectedComp()
	if (!comp) return
	// The comp the user is looking at, captured before anything else touches the
	// scene: the dropdown selection and the open comp can differ, and this is what
	// has to be open again once the export finishes.
	var from = null, fromFrame = null
	try { from = api.getActiveComp(); fromFrame = api.getFrame() } catch (e) {}
	var timing = false
	try {
		timing = settings.duplicators && settings.precomps && needsTimingMeasurement(comp)
	} catch (e) { timing = false }
	var subMesh = false
	try { subMesh = needsSubMeshMeasurement(comp) } catch (e) { subMesh = false }
	if (timing || subMesh) {
		if (deferredTiming) {
			console.log(TAG + 'A measurement is already running; the export finishes in a moment.')
			return
		}
		// A measurement left behind by an interrupted run cannot be trusted (its
		// probe comp may be half-deleted), so drop it and start clean.
		try { if (timingMeasurementPending()) discardTimingMeasurement() } catch (e) {}
		// Ask for the destination FIRST: a cancelled dialog must not build a probe.
		var outM = api.presentSaveFile(api.getProjectPath() || api.getDesktopFolder(), 'Export Lottie', 'Lottie JSON (*.json)', api.getNiceName(comp) + '.json')
		if (!outM) return
		if (!/\.json$/i.test(outM)) outM += '.json'
		if (typeof api.Timer !== 'function') {
			// No Timer in this Cavalry build: export now and say so in the report.
			var none = timing ? failMeasurement('This Cavalry build has no api.Timer, so the per-copy timing cannot be measured.') : noTiming()
			if (subMesh) none.notes.push('This Cavalry build has no api.Timer, so per-copy sub-mesh visibility cannot be measured.')
			exportWithMeasurement(comp, outM, none)
			return
		}
		var job = { comp: comp, out: outM, attempt: 1, subAttempt: 1, from: from, frame: fromFrame, timing: false, subState: null }
		var setupNotes = []
		// Timing first: the sub-mesh probe snapshots the scene and later deletes
		// everything newer than that snapshot, which must not include this probe.
		if (timing) {
			try {
				prepareTimingMeasurement(comp)
				job.timing = true
			} catch (e) {
				try { discardTimingMeasurement() } catch (err) {}
				job.timingResult = failMeasurement('Timing measurement setup failed: ' + (e && e.message))
				job.timing = true
			}
		}
		if (subMesh) {
			try {
				job.subState = prepareSubMeshMeasurement(comp)
			} catch (e) {
				setupNotes.push('Per-copy sub-mesh visibility could not be measured: ' + (e && e.message))
			}
			if (!job.subState) job.subResult = { values: {}, notes: setupNotes }
		}
		deferredTiming = job
		if (!armMeasurement(TIMING_TIMER_MS)) {
			deferredTiming = null
			try { discardTimingMeasurement() } catch (e) {}
			try { if (job.subState) discardSubMeshMeasurement(job.subState) } catch (e) {}
			var failed = timing ? failMeasurement('The timing measurement could not be started.') : noTiming()
			if (subMesh) failed.notes.push('The sub-mesh measurement could not be started; its copies stay visible.')
			exportWithMeasurement(comp, outM, failed)
			return
		}
		console.log(TAG + 'Measuring per-copy values, then exporting…')
		return
	}
	var out = api.presentSaveFile(api.getProjectPath() || api.getDesktopFolder(), 'Export Lottie', 'Lottie JSON (*.json)', api.getNiceName(comp) + '.json')
	if (!out) return
	if (!/\.json$/i.test(out)) out += '.json'
	var exported = exportSelected()
	optimiseAndWrite(exported.json, out, exported.note ? [exported.note] : [], exported.dirs)
	// The exporter opens comps to sample them; leave the user on the comp and
	// frame they were on rather than wherever the last sample finished.
	try { if (from && api.layerExists(from)) api.setActiveComp(from) } catch (e) {}
	try { if (fromFrame != null) api.setFrame(fromFrame) } catch (e) {}
}

// ---------- window ----------

// PageView, not TabView: TabView can't be styled, so the strip drives the pages (Easey).
var pages = new ui.PageView()
pages.add(exportPage)
pages.add(reportPage)
var tabs = tabStrip(
	[
		{ label: 'Export', icon: 'export' },
		{ label: 'Report', icon: 'report' },
	],
	function (i) {
		pages.setPage(i)
		settings.page = i
		save()
	},
	T
)
var startTab = settings.page === 1 ? 1 : 0
pages.setPage(startTab)
tabs.setSelected(startTab)

var root = new ui.VLayout()
root.setMargins(8, 8, 8, 8)
root.setSpaceBetween(8)
root.add(tabs.widget)
root.add(pages) // a PageView inside a Container stops rendering, so it goes straight in
root.add(label(PRODUCT_VERSION + ' (' + BUILD_ID + ')', 10, T.muted))
root.addStretch()

ui.setTitle(SCRIPT_NAME)
ui.add(root)
ui.setBackgroundColor(T.bg)
ui.setMinimumWidth(320)
ui.show()

checkForUpdate(GITHUB_REPO, SCRIPT_NAME, PRODUCT_VERSION)
