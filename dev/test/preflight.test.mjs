import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkLottie, describePlayers, FEATURES, PLAYERS } from '../src/modules/players.js'

const L = (over) => ({ ty: 4, ind: 1, ip: 0, op: 10, nm: 'L', ks: {}, shapes: [], ...over })
const ids = (issues) => issues.map((i) => i.feature.id)

test('clean files have no issues', () => {
	for (const f of ['basic.json', 'cavalry-duplicator-osc.json']) {
		const j = JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url)))
		assert.deepEqual(ids(checkLottie(j)), [], f)
	}
})

test('every feature has a label, a note and only known players', () => {
	const known = new Set(PLAYERS.map((p) => p.id))
	for (const f of FEATURES) {
		assert.ok(f.label && f.note, f.id)
		for (const id in f.support) assert.ok(known.has(id), f.id + ' ' + id)
	}
})

test('finds features in layers, shapes, masks and precomps; worst first', () => {
	const j = {
		nm: 'Main',
		layers: [
			L({ ind: 1, nm: 'Cam', ty: 13 }),
			L({ ind: 2, nm: 'Matte', td: 1 }),
			L({ ind: 3, nm: 'Target', tt: 4, masksProperties: [{ mode: 's', o: { a: 0, k: 50 } }] }),
		],
		assets: [{ id: 'c1', nm: 'Pre', layers: [L({ nm: 'Shapes', shapes: [{ ty: 'gr', nm: 'G', it: [{ ty: 'mm', nm: 'Merge' }, { ty: 'rp' }] }] })] }],
	}
	const issues = checkLottie(j)
	assert.deepEqual(ids(issues).slice(0, 2).sort(), ['camera', 'lumaInv'])
	for (const id of ['maskModes', 'maskOpacity', 'mergePaths', 'repeater', 'mattesAndroid']) assert.ok(ids(issues).includes(id), id)
	assert.deepEqual(issues.find((i) => i.feature.id === 'mergePaths').where, ['Pre › Shapes › G › Merge'])
})

test('only selected targets are reported', () => {
	const j = { layers: [L({ ty: 13 }), L({ ind: 2, shapes: [{ ty: 'mm' }] })] }
	const web = checkLottie(j, ['webSvg'])
	assert.deepEqual(ids(web).sort(), ['camera', 'mergePaths'])
	assert.deepEqual(web.find((i) => i.feature.id === 'camera').players, { webSvg: 'fatal' })
	assert.deepEqual(ids(checkLottie(j, ['webHtml', 'skottie'])), ['mergePaths'])
	assert.deepEqual(ids(checkLottie({ layers: [L({ shapes: [{ ty: 'mm' }] })] }, ['skottie'])), [])
})

test('matte gap, expressions and frame-by-frame layers', () => {
	const gap = { layers: [L({ ind: 1, td: 1 }), L({ ind: 2 }), L({ ind: 3, tt: 1, tp: 1 })] }
	assert.ok(ids(checkLottie(gap, ['android'])).includes('matteGap'))
	const ok = { layers: [L({ ind: 1, td: 1 }), L({ ind: 3, tt: 1, tp: 1 })] }
	assert.ok(!ids(checkLottie(ok, ['android'])).includes('matteGap'))
	const expr = { layers: [L({ ks: { o: { a: 0, k: 100, x: 'wiggle(1,2)' } } })] }
	assert.deepEqual(ids(checkLottie(expr, ['webLight'])), ['expressions'])
	const nuclear = JSON.parse(fs.readFileSync(new URL('./fixtures/cavalry-duplicator-nuclear.json', import.meta.url)))
	assert.ok(ids(checkLottie(nuclear)).includes('nuclear'))
})

test('describePlayers groups by level', () => {
	assert.equal(describePlayers({ iosCA: 'fatal', android: 'dropped', iosMT: 'fatal' }), 'Fails: iOS · Core Animation, iOS · Main Thread · Dropped: Android')
})

test('flags motion-path keys whose ease dips below 0 (lottie-web jumps to the end)', () => {
	const p = (y) => ({ a: 1, k: [{ t: 0, s: [0, 0], to: [10, 0], ti: [-10, 0], o: { x: 0.3, y }, i: { x: 0.7, y: 1 } }, { t: 10, s: [100, 0] }] })
	const has = (y) => ids(checkLottie({ layers: [L({ ks: { p: p(y) } })] })).includes('motionPathDip')
	assert.equal(has(-0.02), true)
	assert.equal(has(0), false)
})
