import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { hashBuildId } = createRequire(import.meta.url)('../buildId.cjs')

test('hashBuildId is 6 uppercase alphanumeric characters', () => {
	for (const ts of ['1795652977577', '1795653232457', '0', '9999999999999']) {
		assert.match(hashBuildId(ts), /^[0-9A-Z]{6}$/)
	}
})

test('hashBuildId is stable for the same timestamp', () => {
	assert.equal(hashBuildId('1795652977577'), hashBuildId('1795652977577'))
})

test('hashBuildId spreads adjacent timestamps', () => {
	const ids = new Set(
		Array.from({ length: 50 }, (_, i) =>
			hashBuildId(String(1795653000000 + i))
		)
	)
	assert.equal(ids.size, 50)
})

test('hashBuildId matches the generated build info', () => {
	const { readFileSync, existsSync } = createRequire(import.meta.url)('fs')
	const file = new URL('../src/modules/buildInfo.js', import.meta.url)
	if (!existsSync(file)) return // not built yet
	const info = readFileSync(file, 'utf8')
	const time = info.match(/\/\/ Build time: (.+)/)?.[1]
	const id = info.match(/BUILD_ID = "([^"]+)"/)?.[1]
	assert.equal(hashBuildId(String(Date.parse(time))), id)
})
