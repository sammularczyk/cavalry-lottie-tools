// Deflate and zip in plain JS (Cavalry has unzip but no zip, and shell tools need the
// user to trust the script). Pure: bytes in, bytes out; runs in Node too.

export function utf8(str) {
	const out = []
	for (let i = 0; i < str.length; i++) {
		let c = str.charCodeAt(i)
		if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
			const d = str.charCodeAt(i + 1)
			if (d >= 0xdc00 && d < 0xe000) (c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)), i++
		}
		if (c < 0x80) out.push(c)
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
	}
	return Uint8Array.from(out)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64(bytes) {
	let s = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
		s += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)]
		s += b === undefined ? '=' : B64[((b & 15) << 2) | ((c || 0) >> 6)]
		s += c === undefined ? '=' : B64[c & 63]
	}
	return s
}
export function fromBase64(s) {
	s = s.replace(/[^A-Za-z0-9+/]/g, '')
	const out = new Uint8Array(Math.floor((s.length * 3) / 4))
	let n = 0
	for (let i = 0; i < s.length; i += 4) {
		const v = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]) : 0))
		const x = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3]
		out[n++] = x >> 16
		if (i + 2 < s.length) out[n++] = (x >> 8) & 255
		if (i + 3 < s.length) out[n++] = x & 255
	}
	return out.slice(0, n)
}

let CRC = null
export function crc32(bytes) {
	if (!CRC) {
		CRC = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			CRC[n] = c >>> 0
		}
	}
	let c = 0xffffffff
	for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

// Length and distance code tables (RFC 1951 3.2.5).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

// Huffman code lengths (at most `limit` bits) for symbol frequencies.
// ponytail: halves frequencies until the tree fits the limit, not package-merge.
function codeLengths(freq, limit) {
	for (let f = freq.slice(); ; f = f.map((v) => (v ? Math.max(1, v >> 1) : 0))) {
		const lens = new Array(f.length).fill(0)
		let nodes = []
		f.forEach((v, i) => v && nodes.push({ w: v, sym: i }))
		if (nodes.length === 1) {
			lens[nodes[0].sym] = 1
			return lens
		}
		while (nodes.length > 1) {
			nodes.sort((x, y) => x.w - y.w)
			const [x, y] = nodes.splice(0, 2)
			nodes.push({ w: x.w + y.w, kids: [x, y] })
		}
		let ok = true
		const walk = (n, d) => {
			if (n.kids) n.kids.forEach((k) => walk(k, d + 1))
			else if ((lens[n.sym] = d) > limit) ok = false
		}
		if (nodes.length) walk(nodes[0], 0)
		if (ok) return lens
	}
}

// Canonical codes from lengths (RFC 1951 3.2.2).
function canonical(lens) {
	const max = Math.max(0, ...lens), count = new Array(max + 1).fill(0), next = [0]
	lens.forEach((l) => l && count[l]++)
	for (let b = 1, code = 0; b <= max; b++) next[b] = code = (code + (count[b - 1] || 0)) << 1
	return lens.map((l) => (l ? next[l]++ : 0))
}

// Raw deflate: LZ77 with hash chains and lazy matching, one dynamic-Huffman block.
export function deflateRaw(data) {
	// 1. tokens: literal byte, or [length, distance]
	const WIN = 32768, MAXCHAIN = 64
	const head = new Int32Array(1 << 15).fill(-1)
	const prev = new Int32Array(WIN)
	const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff
	const insert = (i) => {
		if (i + 2 >= data.length) return
		const h = hash(i)
		prev[i & (WIN - 1)] = head[h]
		head[h] = i
	}
	const match = (i) => {
		let best = 0, dist = 0
		if (i + 2 >= data.length) return [0, 0]
		let j = head[hash(i)], chain = MAXCHAIN
		const max = Math.min(258, data.length - i)
		while (j >= 0 && i - j <= WIN && chain-- > 0) {
			if (data[j + best] === data[i + best]) {
				let l = 0
				while (l < max && data[j + l] === data[i + l]) l++
				if (l > best) {
					best = l
					dist = i - j
					if (l === max) break
				}
			}
			j = prev[j & (WIN - 1)]
		}
		return [best, dist]
	}
	const pick = (table, v) => {
		let i = table.length - 1
		while (table[i] > v) i--
		return i
	}
	const toks = []
	const litF = new Array(286).fill(0), distF = new Array(30).fill(0)
	for (let i = 0; i < data.length; ) {
		const [len, dist] = match(i)
		insert(i)
		if (len >= 3) {
			const [len2] = match(i + 1) // lazy: a longer match one byte on wins
			if (len2 > len) {
				toks.push(data[i])
				litF[data[i]]++
				i++
				continue
			}
			const lc = pick(LEN_BASE, len), dc = pick(DIST_BASE, dist)
			toks.push([len, dist, lc, dc])
			litF[257 + lc]++
			distF[dc]++
			for (let k = 1; k < len; k++) insert(i + k)
			i += len
		} else {
			toks.push(data[i])
			litF[data[i]]++
			i++
		}
	}
	litF[256] = 1
	if (!distF.some((v) => v)) distF[0] = 1

	// 2. trees
	const litL = codeLengths(litF, 15), distL = codeLengths(distF, 15)
	const litC = canonical(litL), distC = canonical(distL)
	let hlit = 286
	while (hlit > 257 && !litL[hlit - 1]) hlit--
	let hdist = 30
	while (hdist > 1 && !distL[hdist - 1]) hdist--
	const seq = litL.slice(0, hlit).concat(distL.slice(0, hdist))
	const rle = [] // [symbol, extraBits, extraValue]
	for (let i = 0; i < seq.length; ) {
		let run = 1
		while (i + run < seq.length && seq[i + run] === seq[i]) run++
		if (seq[i] === 0 && run >= 3) {
			const n = Math.min(run, 138)
			rle.push(n >= 11 ? [18, 7, n - 11] : [17, 3, n - 3])
			i += n
		} else if (seq[i] !== 0 && run >= 4) {
			rle.push([seq[i], 0, 0])
			const n = Math.min(run - 1, 6)
			rle.push([16, 2, n - 3])
			i += 1 + n
		} else {
			rle.push([seq[i], 0, 0])
			i++
		}
	}
	const clF = new Array(19).fill(0)
	rle.forEach((r) => clF[r[0]]++)
	const clL = codeLengths(clF, 7), clC = canonical(clL)
	const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
	let hclen = 19
	while (hclen > 4 && !clL[ORDER[hclen - 1]]) hclen--

	// 3. bits
	const out = []
	let bitBuf = 0, bitCount = 0
	const bits = (v, n) => {
		bitBuf |= v << bitCount
		bitCount += n
		while (bitCount >= 8) {
			out.push(bitBuf & 255)
			bitBuf >>>= 8
			bitCount -= 8
		}
	}
	const huff = (code, n) => {
		let r = 0 // Huffman codes go most-significant bit first
		for (let i = 0; i < n; i++) r = (r << 1) | ((code >> i) & 1)
		bits(r, n)
	}
	bits(1, 1) // final block
	bits(2, 2) // dynamic Huffman
	bits(hlit - 257, 5)
	bits(hdist - 1, 5)
	bits(hclen - 4, 4)
	for (let i = 0; i < hclen; i++) bits(clL[ORDER[i]], 3)
	for (const [sym, n, v] of rle) {
		huff(clC[sym], clL[sym])
		if (n) bits(v, n)
	}
	for (const t of toks) {
		if (typeof t === 'number') huff(litC[t], litL[t])
		else {
			const [len, dist, lc, dc] = t
			huff(litC[257 + lc], litL[257 + lc])
			if (LEN_EXTRA[lc]) bits(len - LEN_BASE[lc], LEN_EXTRA[lc])
			huff(distC[dc], distL[dc])
			if (DIST_EXTRA[dc]) bits(dist - DIST_BASE[dc], DIST_EXTRA[dc])
		}
	}
	huff(litC[256], litL[256])
	if (bitCount) out.push(bitBuf & 255)
	return Uint8Array.from(out)
}

// Bytes a web server would send gzipped (deflate + 18 bytes of gzip header/trailer).
export const gzipSize = (text) => deflateRaw(utf8(text)).length + 18

// files: [{ name, data: Uint8Array, store? }] -> zip bytes (deflated unless store).
export function zip(files) {
	const parts = [], central = []
	let offset = 0
	const u16 = (v) => [v & 255, (v >> 8) & 255]
	const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
	for (const f of files) {
		const name = utf8(f.name)
		const packed = f.store ? f.data : deflateRaw(f.data)
		const method = f.store ? 0 : 8
		const crc = crc32(f.data)
		// version, flags (UTF-8 names), method, time, date (1980-01-01)
		const common = [...u16(20), ...u16(0x800), ...u16(method), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(packed.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)]
		const local = Uint8Array.from([...u32(0x04034b50), ...common])
		parts.push(local, name, packed)
		central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name)
		offset += local.length + name.length + packed.length
	}
	const cdSize = central.reduce((m, p) => m + p.length, 0)
	const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)])
	const all = parts.concat(central, [end])
	const bytes = new Uint8Array(all.reduce((m, p) => m + p.length, 0))
	let at = 0
	for (const p of all) bytes.set(p, at), (at += p.length)
	return bytes
}
