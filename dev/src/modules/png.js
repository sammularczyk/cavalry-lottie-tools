// Decode a PNG back to pixels, then crop and re-encode it — in plain JS.
//
// It has to be plain JS: cropping through a shell (`sips`, ImageMagick) needs
// `api.runProcess`, which the MCP script sandbox does not provide, and Cavalry
// exposes no image-crop call of its own. The only bytes available are those
// `api.encodeBinary` hands back for a rendered frame.
//
// Only what Cavalry's own renderer writes has to be understood: 8-bit
// greyscale/RGB/RGBA, non-interlaced. Anything else is refused rather than
// guessed at.

import { crc32, deflateRaw } from './zip.js'

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

function u32(b, at) {
	return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

function paeth(a, b, c) {
	const p = a + b - c
	const pa = Math.abs(p - a)
	const pb = Math.abs(p - b)
	const pc = Math.abs(p - c)
	if (pa <= pb && pa <= pc) return a
	return pb <= pc ? b : c
}

// Inflate a zlib stream (RFC 1950 wrapper, RFC 1951 body).
//
// The output is one buffer that doubles as needed, because a back-reference can
// reach into any earlier block and copying block-by-block would mean rebuilding
// the whole prefix for every long-distance match.
function inflate(data) {
	let bitPos = 16 // past the two zlib header bytes
	const bit = () => {
		const at = bitPos >> 3
		if (at >= data.length) throw new Error('png: truncated deflate stream')
		const v = (data[at] >> (bitPos & 7)) & 1
		bitPos++
		return v
	}
	const bits = (n) => {
		let v = 0
		for (let i = 0; i < n; i++) v |= bit() << i
		return v
	}
	const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
	const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
	const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
	const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

	let out = new Uint8Array(Math.max(1024, data.length * 4))
	let n = 0
	const room = (need) => {
		if (n + need <= out.length) return
		let size = out.length
		while (size < n + need) size *= 2
		const bigger = new Uint8Array(size)
		bigger.set(out.subarray(0, n))
		out = bigger
	}

	// Canonical Huffman table: count per length, symbols ordered by code.
	const buildTree = (lens) => {
		const counts = new Array(16).fill(0)
		for (const l of lens) counts[l]++
		counts[0] = 0
		const offs = new Array(16).fill(0)
		for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + counts[i]
		const syms = new Array(lens.length)
		lens.forEach((l, s) => {
			if (l) syms[offs[l]++] = s
		})
		return { counts, syms }
	}
	const decode = (tree) => {
		let code = 0
		let first = 0
		let index = 0
		for (let len = 1; len < 16; len++) {
			code |= bit()
			const count = tree.counts[len]
			if (count && code - count < first) return tree.syms[index + (code - first)]
			index += count
			first = (first + count) << 1
			code <<= 1
		}
		throw new Error('png: bad huffman code')
	}

	let fixedLit = null
	let fixedDist = null
	let last = 0
	while (!last) {
		last = bits(1)
		const type = bits(2)
		if (type === 0) {
			// Stored block: realign, then a 16-bit length and its complement.
			bitPos = (bitPos + 7) & ~7
			const at = bitPos >> 3
			const len = data[at] | (data[at + 1] << 8)
			const check = data[at + 2] | (data[at + 3] << 8)
			if ((len ^ 0xffff) !== check) throw new Error('png: bad stored block length')
			room(len)
			out.set(data.subarray(at + 4, at + 4 + len), n)
			n += len
			bitPos = (at + 4 + len) * 8
			continue
		}
		let litTree
		let distTree
		if (type === 1) {
			if (!fixedLit) {
				const l = new Array(288)
				for (let i = 0; i < 144; i++) l[i] = 8
				for (let i = 144; i < 256; i++) l[i] = 9
				for (let i = 256; i < 280; i++) l[i] = 7
				for (let i = 280; i < 288; i++) l[i] = 8
				fixedLit = buildTree(l)
				fixedDist = buildTree(new Array(30).fill(5))
			}
			litTree = fixedLit
			distTree = fixedDist
		} else if (type === 2) {
			const hlit = bits(5) + 257
			const hdist = bits(5) + 1
			const hclen = bits(4) + 4
			const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
			const cl = new Array(19).fill(0)
			for (let i = 0; i < hclen; i++) cl[order[i]] = bits(3)
			const clTree = buildTree(cl)
			const lens = []
			while (lens.length < hlit + hdist) {
				const sym = decode(clTree)
				if (sym < 16) lens.push(sym)
				else if (sym === 16) {
					const prev = lens[lens.length - 1] || 0
					const k = 3 + bits(2)
					for (let i = 0; i < k; i++) lens.push(prev)
				} else if (sym === 17) {
					const k = 3 + bits(3)
					for (let i = 0; i < k; i++) lens.push(0)
				} else if (sym === 18) {
					const k = 11 + bits(7)
					for (let i = 0; i < k; i++) lens.push(0)
				} else {
					throw new Error('png: bad code length symbol')
				}
			}
			litTree = buildTree(lens.slice(0, hlit))
			distTree = buildTree(lens.slice(hlit))
		} else {
			throw new Error('png: reserved deflate block type')
		}
		for (;;) {
			const sym = decode(litTree)
			if (sym < 256) {
				room(1)
				out[n++] = sym
			} else if (sym === 256) {
				break
			} else {
				const li = sym - 257
				if (li >= LEN_BASE.length) throw new Error('png: bad length symbol')
				const len = LEN_BASE[li] + bits(LEN_EXTRA[li])
				const di = decode(distTree)
				if (di >= DIST_BASE.length) throw new Error('png: bad distance symbol')
				const dist = DIST_BASE[di] + bits(DIST_EXTRA[di])
				if (dist > n) throw new Error('png: back-reference before start')
				room(len)
				const from = n - dist
				for (let i = 0; i < len; i++) out[n++] = out[from + i]
			}
		}
	}
	return out.subarray(0, n)
}

// Wrap raw deflate data in a zlib stream: 2-byte header, deflate body, Adler-32.
function zlibWrap(raw, bytes) {
	let a = 1
	let b = 0
	for (let i = 0; i < bytes.length; i++) {
		a = (a + bytes[i]) % 65521
		b = (b + a) % 65521
	}
	const out = new Uint8Array(raw.length + 6)
	out[0] = 0x78
	out[1] = 0x01
	out.set(raw, 2)
	out[raw.length + 2] = (b >> 8) & 255
	out[raw.length + 3] = b & 255
	out[raw.length + 4] = (a >> 8) & 255
	out[raw.length + 5] = a & 255
	return out
}

// A PNG file from raw RGBA pixels.
function encodePng(rgba, w, h) {
	const raw = []
	for (let y = 0; y < h; y++) {
		raw.push(0) // filter: none
		for (let x = 0; x < w; x++) {
			const at = (y * w + x) * 4
			raw.push(rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3])
		}
	}
	const chunk = (type, body) => {
		const out = []
		const len = body.length
		out.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255)
		const typed = []
		for (let i = 0; i < 4; i++) typed.push(type.charCodeAt(i))
		for (const v of body) typed.push(v)
		for (const v of typed) out.push(v)
		const c = crc32(typed)
		out.push((c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255)
		return out
	}
	const ihdr = []
	const push32 = (arr, v) => arr.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
	push32(ihdr, w)
	push32(ihdr, h)
	ihdr.push(8, 6, 0, 0, 0) // 8-bit, RGBA, deflate, no filter, no interlace
	const out = []
	for (const v of SIG) out.push(v)
	for (const v of chunk('IHDR', ihdr)) out.push(v)
	for (const v of chunk('IDAT', zlibWrap(deflateRaw(Uint8Array.from(raw)), raw))) out.push(v)
	for (const v of chunk('IEND', [])) out.push(v)
	return out
}

// Decode a PNG to { w, h, rgba }.
export function decodePng(bytes) {
	if (bytes.length < 8) return null
	for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null
	let pos = 8
	let w = 0
	let h = 0
	let depth = 0
	let colour = 0
	let interlace = 0
	const idat = []
	while (pos + 8 <= bytes.length) {
		const len = u32(bytes, pos)
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
		const body = bytes.slice(pos + 8, pos + 8 + len)
		pos += 12 + len
		if (type === 'IHDR') {
			w = u32(body, 0)
			h = u32(body, 4)
			depth = body[8]
			colour = body[9]
			interlace = body[12]
		} else if (type === 'IDAT') {
			for (const v of body) idat.push(v)
		} else if (type === 'IEND') break
	}
	if (!w || !h || depth !== 8 || interlace !== 0) return null
	const channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : 0
	if (!channels) return null
	const raw = inflate(idat)
	if (!raw || raw.length < h * (1 + w * channels)) return null
	const rgba = new Uint8Array(w * h * 4)
	const stride = w * channels
	let prev = new Uint8Array(stride)
	for (let y = 0; y < h; y++) {
		const filter = raw[y * (stride + 1)]
		const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
		const cur = new Uint8Array(stride)
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? cur[i - channels] : 0
			const b = prev[i]
			const c = i >= channels ? prev[i - channels] : 0
			let v = line[i]
			if (filter === 1) v += a
			else if (filter === 2) v += b
			else if (filter === 3) v += (a + b) >> 1
			else if (filter === 4) v += paeth(a, b, c)
			cur[i] = v & 255
		}
		for (let x = 0; x < w; x++) {
			const at = (y * w + x) * 4
			const src = x * channels
			if (channels === 1) {
				rgba[at] = rgba[at + 1] = rgba[at + 2] = cur[src]
				rgba[at + 3] = 255
			} else if (channels === 3) {
				rgba[at] = cur[src]
				rgba[at + 1] = cur[src + 1]
				rgba[at + 2] = cur[src + 2]
				rgba[at + 3] = 255
			} else {
				rgba[at] = cur[src]
				rgba[at + 1] = cur[src + 1]
				rgba[at + 2] = cur[src + 2]
				rgba[at + 3] = cur[src + 3]
			}
		}
		prev = cur
	}
	return { w: w, h: h, rgba: rgba }
}

// Crop a rectangle out of a decoded image, clamped to its bounds.
export function cropPixels(img, x, y, w, h) {
	const ox = Math.max(0, Math.min(img.w - 1, Math.round(x)))
	const oy = Math.max(0, Math.min(img.h - 1, Math.round(y)))
	const ow = Math.max(1, Math.min(img.w - ox, Math.round(w)))
	const oh = Math.max(1, Math.min(img.h - oy, Math.round(h)))
	const out = new Uint8Array(ow * oh * 4)
	for (let yy = 0; yy < oh; yy++) {
		const src = ((oy + yy) * img.w + ox) * 4
		const dst = yy * ow * 4
		for (let bb = 0; bb < ow * 4; bb++) out[dst + bb] = img.rgba[src + bb]
	}
	return { w: ow, h: oh, rgba: out }
}

// A PNG file (byte array) holding a cropped rectangle of another PNG file.
export function cropPng(bytes, x, y, w, h) {
	const img = decodePng(bytes)
	if (!img) return null
	const cell = cropPixels(img, x, y, w, h)
	return { bytes: encodePng(cell.rgba, cell.w, cell.h), w: cell.w, h: cell.h }
}
