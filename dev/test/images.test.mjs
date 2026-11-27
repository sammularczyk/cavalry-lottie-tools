import test from 'node:test'
import assert from 'node:assert/strict'
import { externalBundlePath, packImages } from '../src/modules/images.js'

test('externalBundlePath nests JSON inside a subfolder named after its stem', () => {
	assert.deepEqual(externalBundlePath('/Users/sam/Desktop/Card_26.json'), {
		dir: '/Users/sam/Desktop/Card_26',
		file: '/Users/sam/Desktop/Card_26/Card_26.json',
		folderName: 'Card_26',
	})
})

test('externalBundlePath avoids double-nesting when the parent folder already matches the stem', () => {
	assert.deepEqual(externalBundlePath('/Users/sam/Desktop/Card_26/Card_26.json'), {
		dir: '/Users/sam/Desktop/Card_26',
		file: '/Users/sam/Desktop/Card_26/Card_26.json',
		folderName: 'Card_26',
	})
})

test('packImages with embed=false creates images/ folder, copies files, and sets u/p/e', () => {
	const dirsCreated = []
	const copied = []
	const existing = new Set(['/tmp/export/img0.png'])

	globalThis.api = {
		filePathExists: (p) => existing.has(p),
		isDirectory: (p) => dirsCreated.includes(p),
		makeFolder: (p) => { dirsCreated.push(p); return true },
		deleteFilePath: (p) => { existing.delete(p); return true },
		copyFilePath: (src, dst) => { copied.push([src, dst]); existing.add(dst); return true },
		getFileNameFromPath: (p) => p.split('/').pop(),
		getPlatform: () => 'macOS',
	}

	const json = {
		assets: [
			{ id: 'img0', w: 100, h: 100, u: '', p: 'img0.png', e: 0 },
		],
	}

	const res = packImages(json, ['/tmp/export'], '/Users/sam/Desktop/Card_26', { embed: false, jpeg: false })
	assert.deepEqual(res, { embedded: 0, copied: 1, jpeg: 0, missing: 0 })
	assert.deepEqual(dirsCreated, ['/Users/sam/Desktop/Card_26/images'])
	assert.deepEqual(copied, [['/tmp/export/img0.png', '/Users/sam/Desktop/Card_26/images/img0.png']])
	assert.equal(json.assets[0].u, 'images/')
	assert.equal(json.assets[0].p, 'img0.png')
	assert.equal(json.assets[0].e, 0)
})
