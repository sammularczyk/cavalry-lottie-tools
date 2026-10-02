// Which Lottie players support what, and a checker that finds those features in a file.
// Pure JSON: no `api.` calls, tested in Node.
//
// Support comes from reading each player's source (lottie-web 5.13, lottie-android,
// lottie-ios, ThorVG, Skia Skottie, rlottie), which disagrees with the airbnb table in
// places. Levels: fatal (fails to load or throws), dropped (ignored or drawn wrong),
// partial (approximated or only some cases), slow (works, but costs performance or makes
// iOS fall back to its slower engine). A player missing from `support` is fine.

export const PLAYERS = [
	{ id: 'webSvg', label: 'Web · SVG' },
	{ id: 'webCanvas', label: 'Web · Canvas' },
	{ id: 'webHtml', label: 'Web · HTML' },
	{ id: 'webLight', label: 'Web · lottie_light' },
	{ id: 'android', label: 'Android' },
	{ id: 'iosCA', label: 'iOS · Core Animation' },
	{ id: 'iosMT', label: 'iOS · Main Thread' },
	{ id: 'thorvg', label: 'dotLottie · ThorVG' },
	{ id: 'skottie', label: 'Skottie (Skia)' },
	{ id: 'rlottie', label: 'rlottie (deprecated)' },
]

export const LEVELS = ['fatal', 'dropped', 'partial', 'slow']
export const LEVEL_LABEL = { fatal: 'Fails', dropped: 'Dropped', partial: 'Partly', slow: 'Slower' }

const ALL_WEB = ['webSvg', 'webCanvas', 'webHtml', 'webLight']
const each = (ids, level) => Object.fromEntries(ids.map((id) => [id, level]))

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isAnimated = (p) => p && Array.isArray(p.k) && isObj(p.k[0]) && 't' in p.k[0]
const staticValue = (p) => (p && !isAnimated(p) ? (Array.isArray(p.k) ? p.k[0] : p.k) : null)

// detect(ctx) returns true when the thing it is handed uses the feature.
// ctx.kind is 'layer' | 'shape' | 'mask' | 'file'.
export const FEATURES = [
	{
		id: 'camera',
		label: 'Camera layer',
		on: 'layer',
		detect: (L) => L.ty === 13,
		support: { ...each(['webSvg', 'webCanvas', 'webLight'], 'fatal'), ...each(['android', 'iosCA', 'iosMT', 'thorvg', 'rlottie'], 'dropped') },
		note: 'lottie-web SVG and Canvas throw on cameras; only the HTML renderer and Skottie draw them.',
	},
	{
		id: '3d',
		label: '3D layer',
		on: 'layer',
		detect: (L) => L.ddd === 1,
		support: { ...each(['webSvg', 'webCanvas', 'webLight', 'android', 'iosCA', 'iosMT', 'rlottie'], 'dropped'), thorvg: 'partial' },
		note: 'Drawn flat everywhere except lottie-web HTML and Skottie.',
	},
	{
		id: 'text',
		label: 'Text layer',
		on: 'layer',
		detect: (L) => L.ty === 5,
		support: { rlottie: 'dropped', iosCA: 'partial' },
		note: 'iOS Core Animation only draws static text; text animators make it fall back.',
	},
	{
		id: 'nuclear',
		label: 'Frame-by-frame layers',
		on: 'file',
		detect: (j) => frameLayers(j) >= 10,
		support: each(PLAYERS.map((p) => p.id), 'slow'),
		note: 'Looks like Cavalry’s Nuclear bake: one layer per frame. Much larger and slower than Automatic or Animated Mesh.',
	},
	{
		id: 'expressions',
		label: 'Expressions',
		on: 'file',
		detect: (j) => JSON.stringify(j).indexOf('"x":"') >= 0,
		support: { ...each(['webLight', 'android', 'iosCA', 'iosMT', 'rlottie'], 'dropped'), thorvg: 'partial', skottie: 'partial' },
		note: 'Only full lottie-web runs expressions; ThorVG covers about 75%.',
	},
	{
		id: 'motionPathDip',
		label: 'Motion path easing back past its start',
		on: 'file',
		detect: (j) => {
			let hit = false
			const walk = (v) => {
				if (hit || !v || typeof v !== 'object') return
				if (Array.isArray(v)) return v.forEach(walk)
				if (Array.isArray(v.to) && v.o && v.i && v.to.concat(v.ti || []).some((x) => x)) hit = [].concat(v.o.y, v.i.y).some((y) => y < 0)
				for (const k in v) walk(v[k])
			}
			walk(j)
			return hit
		},
		support: each(ALL_WEB, 'dropped'),
		note: 'An ease handle below 0 on a motion-path key: lottie-web jumps the layer to the end of that move for those frames instead of easing back. Re-optimise, or keep handles at 0 or above.',
	},
	{
		id: 'effects',
		label: 'Layer effects',
		on: 'layer',
		detect: (L) => Array.isArray(L.ef) && L.ef.some((e) => e.ty !== 5 && e.ty !== 21), // ty 5: expression controls, data only
		support: { ...each(['webCanvas', 'webLight', 'iosCA', 'iosMT', 'rlottie'], 'dropped'), android: 'partial' },
		note: 'Canvas and light builds ignore effects; Android draws drop shadow and blur only, iOS drop shadow only.',
	},
	{
		id: 'fillEffect',
		label: 'Fill effect',
		on: 'layer',
		detect: (L) => Array.isArray(L.ef) && L.ef.some((e) => e.ty === 21),
		support: each(['webCanvas', 'webLight', 'android', 'iosCA', 'iosMT', 'rlottie'], 'dropped'),
		note: 'From Cavalry’s Fill filter. Only lottie-web SVG, ThorVG and Skottie draw it; elsewhere layers keep their own colours.',
	},
	{
		id: 'luma',
		label: 'Luma matte',
		on: 'layer',
		detect: (L) => L.tt === 3,
		support: { android: 'dropped', iosCA: 'dropped', iosMT: 'dropped', webCanvas: 'partial' },
		note: 'Android draws luma mattes as alpha mattes; lottie-ios has no luma matte.',
	},
	{
		id: 'lumaInv',
		label: 'Inverted luma matte',
		on: 'layer',
		detect: (L) => L.tt === 4,
		support: { android: 'dropped', iosCA: 'fatal', iosMT: 'fatal', webCanvas: 'partial' },
		note: 'lottie-ios cannot decode tt 4, which can stop the whole file loading.',
	},
	{
		id: 'matteGap',
		label: 'Matte not directly above its layer',
		on: 'file',
		detect: (j) => layerLists(j).some((ls) => ls.some((L, i) => L.tt && L.tp != null && !(i > 0 && ls[i - 1].ind === L.tp))),
		support: { android: 'dropped', rlottie: 'dropped' },
		note: 'Android and rlottie ignore tp and use the layer directly above as the matte.',
	},
	{
		id: 'blendHigh',
		label: 'Add / Hard Mix blend mode',
		on: 'layer',
		detect: (L) => L.bm >= 16,
		support: { ...each(ALL_WEB, 'dropped'), iosCA: 'fatal', iosMT: 'fatal' },
		note: 'lottie-ios only decodes blend modes 0–15; lottie-web has no add or hard mix.',
	},
	{
		id: 'blend',
		label: 'Blend mode',
		on: 'layer',
		detect: (L) => L.bm > 5 && L.bm < 16,
		support: { android: 'partial', rlottie: 'partial' },
		note: 'Android drops modes beyond Lighten before Android 10.',
	},
	{
		id: 'maskModes',
		label: 'Subtract / intersect mask',
		on: 'mask',
		detect: (m) => m.mode === 's' || m.mode === 'i',
		support: { webCanvas: 'dropped' },
		note: 'lottie-web Canvas merges every mask into one clip and ignores the mode.',
	},
	{
		id: 'maskRare',
		label: 'Lighten / darken / difference mask',
		on: 'mask',
		detect: (m) => m.mode === 'l' || m.mode === 'd' || m.mode === 'f',
		support: { ...each(ALL_WEB, 'dropped'), ...each(['android', 'rlottie'], 'dropped'), iosMT: 'partial', skottie: 'partial' },
		note: 'Only ThorVG draws all three.',
	},
	{
		id: 'maskOpacity',
		label: 'Mask opacity',
		on: 'mask',
		detect: (m) => isAnimated(m.o) || (staticValue(m.o) != null && staticValue(m.o) < 100),
		support: { webCanvas: 'dropped' },
		note: 'lottie-web Canvas ignores mask opacity.',
	},
	{
		id: 'maskExpansion',
		label: 'Mask expansion',
		on: 'mask',
		detect: (m) => isAnimated(m.x) || (staticValue(m.x) != null && staticValue(m.x) !== 0),
		support: each(['webCanvas', 'android', 'iosCA', 'skottie', 'rlottie'], 'dropped'),
		note: 'Only lottie-web SVG/HTML and ThorVG expand masks.',
	},
	{
		id: 'mattesAndroid',
		label: 'Masks or mattes',
		on: 'layer',
		detect: (L) => !!L.tt || (Array.isArray(L.masksProperties) && L.masksProperties.length > 0),
		support: { android: 'slow' },
		note: 'Android’s biggest cost, growing with the area covered; keep them small.',
	},
	{
		id: 'mergePaths',
		label: 'Merge paths',
		on: 'shape',
		detect: (s) => s.ty === 'mm',
		support: { ...each(ALL_WEB, 'dropped'), ...each(['iosCA', 'iosMT', 'thorvg', 'rlottie'], 'dropped'), android: 'partial' },
		note: 'Only Skottie draws merge paths; Android needs enableMergePathsForKitKatAndAbove.',
	},
	{
		id: 'offsetPath',
		label: 'Offset path / pucker & bloat',
		on: 'shape',
		detect: (s) => s.ty === 'op' || s.ty === 'pb',
		support: each(['android', 'iosCA', 'iosMT', 'rlottie'], 'dropped'),
		note: 'Not on Android, iOS or rlottie.',
	},
	{
		id: 'zigZag',
		label: 'Zig zag',
		on: 'shape',
		detect: (s) => s.ty === 'zz',
		support: each(['android', 'iosCA', 'iosMT', 'skottie', 'rlottie'], 'dropped'),
		note: 'Web and ThorVG only.',
	},
	{
		id: 'twist',
		label: 'Twist',
		on: 'shape',
		detect: (s) => s.ty === 'tw',
		support: each(PLAYERS.map((p) => p.id), 'dropped'),
		note: 'No player draws twist.',
	},
	{
		id: 'repeater',
		label: 'Repeater',
		on: 'shape',
		detect: (s) => s.ty === 'rp',
		support: { iosMT: 'dropped', iosCA: 'partial' },
		note: 'iOS Core Animation can’t animate the copy count; the Main Thread engine has no repeater.',
	},
	{
		id: 'gradientHighlight',
		label: 'Radial gradient highlight',
		on: 'shape',
		detect: (s) => (s.ty === 'gf' || s.ty === 'gs') && s.t === 2 && s.h && (isAnimated(s.h) || staticValue(s.h)),
		support: each(['android', 'iosCA', 'iosMT'], 'dropped'),
		note: 'Android and iOS draw the gradient without its highlight.',
	},
	{
		id: 'animatedDash',
		label: 'Animated dash pattern',
		on: 'shape',
		detect: (s) => s.ty === 'st' && Array.isArray(s.d) && s.d.some((d) => isAnimated(d.v)),
		support: { iosCA: 'partial' },
		note: 'iOS Core Animation falls back to the Main Thread engine.',
	},
	{
		id: 'autoOrient',
		label: 'Auto-orient',
		on: 'layer',
		detect: (L) => L.ao === 1,
		support: each(['iosCA', 'iosMT'], 'dropped'),
		note: 'lottie-ios ignores auto-orient.',
	},
	{
		id: 'timeRemap',
		label: 'Time remap',
		on: 'layer',
		detect: (L) => !!L.tm,
		support: { iosCA: 'slow' },
		note: 'Complex or many time remaps make iOS fall back to the Main Thread engine.',
	},
	{
		id: 'webp',
		label: 'WebP image',
		on: 'file',
		detect: (j) => (j.assets || []).some((a) => /^data:image\/webp|\.webp$/i.test(a.p || '')),
		support: {},
		note: 'Check your target player decodes WebP before relying on it.',
	},
]

// ---------- walking ----------

export function layerLists(json) {
	const lists = []
	if (Array.isArray(json.layers)) lists.push(json.layers)
	for (const a of json.assets || []) if (Array.isArray(a.layers)) lists.push(a.layers)
	return lists
}

// Short layers that look like one-per-frame output.
function frameLayers(json) {
	let n = 0
	for (const ls of layerLists(json)) for (const L of ls) if (L.op - L.ip > 0 && L.op - L.ip <= 1.01) n++
	return n
}

// Visit every layer with a readable path ("Comp › Layer").
function forEachLayer(json, fn) {
	const names = {}
	for (const a of json.assets || []) names[a.id] = a.nm || a.id
	if (Array.isArray(json.layers)) json.layers.forEach((L) => fn(L, (json.nm || 'Root') + ' › ' + (L.nm || 'layer ' + L.ind)))
	for (const a of json.assets || [])
		if (Array.isArray(a.layers)) a.layers.forEach((L) => fn(L, (a.nm || a.id) + ' › ' + (L.nm || 'layer ' + L.ind)))
}

function forEachShape(items, path, fn) {
	if (!Array.isArray(items)) return
	for (const it of items) {
		if (!it) continue
		const p = path + (it.nm ? ' › ' + it.nm : '')
		fn(it, p)
		if (it.ty === 'gr') forEachShape(it.it, p, fn)
	}
}

// ---------- checking ----------

// -> [{ feature, where: [paths], players: {id: level} }], only issues for `targets`
// (player ids; all players when omitted), worst first.
export function checkLottie(json, targets) {
	const want = new Set(targets && targets.length ? targets : PLAYERS.map((p) => p.id))
	const hits = {}
	const hit = (f, where) => (hits[f.id] = hits[f.id] || { feature: f, where: [] }).where.push(where)
	const by = (kind) => FEATURES.filter((f) => f.on === kind)
	for (const f of by('file')) if (f.detect(json)) hit(f, json.nm || 'file')
	forEachLayer(json, (L, path) => {
		for (const f of by('layer')) if (f.detect(L)) hit(f, path)
		for (const m of L.masksProperties || []) for (const f of by('mask')) if (f.detect(m)) hit(f, path)
		forEachShape(L.shapes, path, (s, sp) => {
			for (const f of by('shape')) if (f.detect(s)) hit(f, sp)
		})
	})
	const rank = (lv) => LEVELS.indexOf(lv)
	return Object.values(hits)
		.map((h) => {
			const players = {}
			for (const id in h.feature.support) if (want.has(id)) players[id] = h.feature.support[id]
			return { feature: h.feature, where: h.where, players }
		})
		.filter((h) => Object.keys(h.players).length || h.feature.id === 'webp')
		.sort((a, b) => worst(a) - worst(b))
	function worst(h) {
		const lv = Object.values(h.players).map(rank)
		return lv.length ? Math.min(...lv) : LEVELS.length
	}
}

// "Fails: iOS · Core Animation · Dropped: Android"
export function describePlayers(players) {
	const byLevel = {}
	for (const id in players) (byLevel[players[id]] = byLevel[players[id]] || []).push(PLAYERS.find((p) => p.id === id).label)
	return LEVELS.filter((lv) => byLevel[lv])
		.map((lv) => LEVEL_LABEL[lv] + ': ' + byLevel[lv].join(', '))
		.join(' · ')
}
