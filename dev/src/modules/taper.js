// Tapered strokes as filled outlines. A Lottie stroke has one width; Cavalry's Tapered Width
// draws Width × its width curve at each point. Measured against Cavalry's renders:
// - the curve's x is the distance along the contour (0 at its start, 1 at its end), always the
//   whole contour, so a trim cuts the taper rather than squeezing it;
// - Start/End Width don't apply (the curve replaces them; its default is a straight 0 → 1);
// - Travel wraps the trim round open contours too, and each piece left gets round caps whose
//   radius is half the width there (Projecting falls back to Round when tapered; Flat has none).
// ponytail: inside one curve with very uneven handles Cavalry's distance runs a little between
// arc length and the curve parameter (≤2% of the contour on real paths); arc length is used.

// Width curve points [{x, y, lx, ly, rx, ry}] (handles as offsets, any order) -> f(x) in 0..1.
export function widthCurve(points) {
	const pts = points.slice().sort((a, b) => a.x - b.x)
	const bez = (a, b, c, d, u) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u * u * c + u ** 3 * d
	return (X) => {
		if (X <= pts[0].x) return pts[0].y
		if (X >= pts[pts.length - 1].x) return pts[pts.length - 1].y
		let j = 0
		while (X > pts[j + 1].x) j++
		const p = pts[j], q = pts[j + 1]
		const xs = [p.x, p.x + p.rx, q.x + q.lx, q.x], ys = [p.y, p.y + p.ry, q.y + q.ly, q.y]
		let lo = 0, hi = 1
		for (let k = 0; k < 40; k++) {
			const m = (lo + hi) / 2
			if (bez(...xs, m) < X) lo = m
			else hi = m
		}
		return bez(...ys, (lo + hi) / 2)
	}
}

// A Lottie shape {v, i, o, c} as a dense polyline with cumulative lengths.
function flatten(shape, steps) {
	const { v, i, o, c } = shape
	const pts = [v[0]], len = [0]
	const n = c ? v.length : v.length - 1
	for (let j = 0; j < n; j++) {
		const a = v[j], b = v[(j + 1) % v.length]
		const p1 = [a[0] + o[j][0], a[1] + o[j][1]], p2 = [b[0] + i[(j + 1) % v.length][0], b[1] + i[(j + 1) % v.length][1]]
		for (let k = 1; k <= steps; k++) {
			const u = k / steps, w = [(1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3]
			const q = [0, 1].map((d) => w[0] * a[d] + w[1] * p1[d] + w[2] * p2[d] + w[3] * b[d])
			const prev = pts[pts.length - 1]
			pts.push(q)
			len.push(len[len.length - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]))
		}
	}
	return { pts, len, total: len[len.length - 1] }
}

// Point and unit direction at fraction f of a polyline's length.
function at(poly, f) {
	const L = Math.min(Math.max(f, 0), 1) * poly.total
	let j = 1
	while (j < poly.len.length - 1 && poly.len[j] < L) j++
	const a = poly.pts[j - 1], b = poly.pts[j], seg = poly.len[j] - poly.len[j - 1] || 1
	const u = (L - poly.len[j - 1]) / seg
	const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
	return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], d: [(b[0] - a[0]) / d, (b[1] - a[1]) / d] }
}

// The pieces of a contour a trim leaves, as [from, to] fractions. trim: {start, end, travel} in %.
export function trimWindows(trim) {
	if (!trim) return [[0, 1]]
	let a = Math.min(trim.start, trim.end), b = Math.max(trim.start, trim.end)
	if (b - a >= 100) return [[0, 1]]
	if (b - a <= 0) return []
	a = (a + trim.travel) / 100
	b = (b + trim.travel) / 100
	const k = Math.floor(a)
	a -= k
	b -= k
	return b <= 1 ? [[a, b]] : [[a, 1], [0, b - 1]]
}

// Smooth handles through a closed polygon (Catmull-Rom), as a Lottie shape.
function smooth(points) {
	const n = points.length
	const t = points.map((_, j) => {
		const a = points[(j - 1 + n) % n], b = points[(j + 1) % n]
		return [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6]
	})
	return { c: true, v: points, i: t.map(([x, y]) => [-x, -y]), o: t }
}

// Filled outlines of a tapered stroke on one contour.
// shape: Lottie path; width: stroke Width; curve: widthCurve(); trim: {start, end, travel} | null;
// round: round caps. Each outline has a fixed point count, so frames can share slots.
export function taperOutlines(shape, width, curve, trim, round, opts = {}) {
	const n = opts.samples || 32, capSteps = opts.capSteps || 6
	if (!shape || !shape.v || shape.v.length < 2) return []
	const poly = flatten(shape, opts.flatten || 24)
	if (!(poly.total > 0)) return []
	const half = (f) => (width * Math.max(curve(f), 0)) / 2
	const side = (f, s) => {
		const { p, d } = at(poly, f)
		const h = half(f)
		return [p[0] - d[1] * h * s, p[1] + d[0] * h * s]
	}
	const cap = (f, out) => {
		// half circle round the end at f, from one side to the other; out: +1 past the end, -1 before the start
		const { p, d } = at(poly, f)
		const h = half(f), pts = []
		for (let k = 1; k < capSteps; k++) {
			const ang = Math.PI / 2 - (Math.PI * k) / capSteps
			const along = Math.cos(ang) * h * out, across = Math.sin(ang) * h * out
			pts.push([p[0] + d[0] * along - d[1] * across, p[1] + d[1] * along + d[0] * across])
		}
		return pts
	}
	const out = []
	for (const [a, b] of trimWindows(trim)) {
		const fs = Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n)
		if (shape.c && a === 0 && b === 1) {
			// a whole closed contour: a ring, the inner edge reversed so a nonzero fill leaves the hole
			out.push(smooth(fs.slice(0, n).map((f) => side(f, 1))), smooth(fs.slice(0, n).map((f) => side(f, -1)).reverse()))
			continue
		}
		const left = fs.map((f) => side(f, 1)), right = fs.map((f) => side(f, -1)).reverse()
		const blank = () => Array.from({ length: capSteps - 1 }, () => left[0]) // keeps the count fixed without caps
		const endCap = round ? cap(b, 1) : blank().map(() => left[n])
		const startCap = round ? cap(a, -1) : blank().map(() => right[n])
		out.push(smooth(left.concat(endCap, right, startCap)))
	}
	return out
}

// An outline drawn as nothing, with another's point count (fills a slot on frames with fewer pieces).
export function emptyLike(shape) {
	const p = shape.v[0]
	return { c: true, v: shape.v.map(() => p.slice()), i: shape.v.map(() => [0, 0]), o: shape.v.map(() => [0, 0]) }
}
