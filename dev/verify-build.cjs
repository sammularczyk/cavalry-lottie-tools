#!/usr/bin/env node
// Verify a BUILD_ID shown in the Cavalry settings menu against the build on disk.
// Usage: node verify-build.cjs <6-char build ID>

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { hashBuildId } = require('./buildId.cjs')

const DEV = __dirname
const REPO = path.resolve(DEV, '..')
const BUILD_INFO_FILE = path.join(DEV, 'src', 'modules', 'buildInfo.js')
const BUNDLE_NAME = 'Lottie Optimiser'
const BUNDLES = [
	`${BUNDLE_NAME}.js`, // dev build
	`${BUNDLE_NAME} (unencrypted).js`, // release build, before encryption
]
const SHIPPED = `${BUNDLE_NAME}.jsc` // copied into the repo root by `npm run release`

function sha(file) {
	return crypto
		.createHash('sha256')
		.update(fs.readFileSync(file))
		.digest('hex')
}

const code = (process.argv[2] || '').trim().toUpperCase()
if (!code) {
	console.error('Usage: node verify-build.cjs <6-char build ID>')
	process.exit(1)
}

const info = fs.readFileSync(BUILD_INFO_FILE, 'utf8')
const buildTime = info.match(/\/\/ Build time: (.+)/)?.[1]
const buildId = info.match(/BUILD_ID = "([^"]+)"/)?.[1]

if (!buildTime || !buildId) {
	console.error(
		'Could not parse buildInfo.js. Run `npm run build:info` first.'
	)
	process.exit(1)
}

const built = new Date(buildTime)
const ageMin = Math.round((Date.now() - built.getTime()) / 60000)
const expected = hashBuildId(String(built.getTime()))

console.log(`source : ${buildId}  (${buildTime}, ${ageMin} min ago)`)
if (expected !== buildId) {
	console.error(
		`✗ buildInfo.js is inconsistent: ${buildTime} hashes to ${expected}`
	)
	process.exit(3)
}

if (code !== buildId) {
	console.error(`✗ ${code} is not the current build (${buildId} expected)`)
	process.exit(2)
}
console.log(`✓ ${code} matches the current build`)

let foundInBundle = false
for (const name of BUNDLES) {
	const file = path.join(DEV, 'build', name)
	if (!fs.existsSync(file)) continue
	foundInBundle = true
	if (!fs.readFileSync(file, 'utf8').includes(buildId)) {
		console.error(`✗ build/${name} is stale — rebuild before shipping`)
		process.exit(4)
	}
	console.log(`✓ ${code} is in build/${name}`)
}
if (!foundInBundle)
	console.error(
		'⚠ no bundle in dev/build — run `npm run dev` or `npm run release`'
	)

const shipped = path.join(REPO, SHIPPED)
const builtJsc = path.join(DEV, 'build', SHIPPED)
if (fs.existsSync(shipped) && fs.existsSync(builtJsc)) {
	console.log(
		sha(shipped) === sha(builtJsc)
			? `✓ ${SHIPPED} at the repo root is the freshly built bundle`
			: `⚠ ${SHIPPED} at the repo root is stale — run \`npm run release\` to copy it`
	)
}
