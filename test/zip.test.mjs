import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import * as Z from '../src/modules/zip.js'

test('deflateRaw round-trips through zlib, utf8 and all', () => {
	const text = JSON.stringify({ nm: 'Ünïcödé 🎉 layer', k: Array.from({ length: 2000 }, (_, i) => ({ t: i, s: [i % 17, (i * 7) % 13] })) })
	const bytes = Z.utf8(text)
	assert.deepEqual(Buffer.from(bytes), Buffer.from(text, 'utf8'))
	assert.equal(zlib.inflateRawSync(Buffer.from(Z.deflateRaw(bytes))).toString('utf8'), text)
	assert.equal(zlib.inflateRawSync(Buffer.from(Z.deflateRaw(new Uint8Array(0)))).length, 0)
})

test('base64 and crc32 match Node', () => {
	const b = Uint8Array.from([0, 1, 2, 250, 251, 252, 253])
	for (let n = 0; n <= b.length; n++) {
		const s = b.slice(0, n)
		assert.equal(Z.base64(s), Buffer.from(s).toString('base64'))
		assert.deepEqual(Buffer.from(Z.fromBase64(Z.base64(s))), Buffer.from(s))
	}
	assert.equal(Z.crc32(Z.utf8('The quick brown fox jumps over the lazy dog')), 0x414fa339)
})

test('zip: entries read back with the right names, data and methods', () => {
	const files = [
		{ name: 'manifest.json', data: Z.utf8('{"version":"2"}') },
		{ name: 'a/anim.json', data: Z.utf8('{"v":"5.7.0","layers":[]}'.repeat(50)) },
		{ name: 'i/img.png', data: Uint8Array.from([137, 80, 78, 71]), store: true },
	]
	const z = Buffer.from(Z.zip(files))
	// walk the central directory
	const end = z.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]))
	let at = z.readUInt32LE(end + 16)
	for (const f of files) {
		assert.equal(z.readUInt32LE(at), 0x02014b50)
		const method = z.readUInt16LE(at + 10), csize = z.readUInt32LE(at + 20), nlen = z.readUInt16LE(at + 28), off = z.readUInt32LE(at + 42)
		assert.equal(z.slice(at + 46, at + 46 + nlen).toString(), f.name)
		const data = z.slice(off + 30 + nlen, off + 30 + nlen + csize)
		assert.deepEqual(method ? zlib.inflateRawSync(data) : data, Buffer.from(f.data))
		at += 46 + nlen
	}
})
