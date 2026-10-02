// Curve fitting for keyframes and paths. Pure maths on numbers and points; passes.js
// maps Lottie data onto it.

const EPS = 1e-9
const clamp01 = (v) => Math.min(1, Math.max(0, v))

// ---------- eases ----------
// A Lottie ease is a cubic bezier from (0,0) to (1,1) with handles (x1,y1) (the key's `o`)
// and (x2,y2) (its `i`). x is time through the segment, y is progress.

const cub = (a, b, s) => {
	const r = 1 - s
	return 3 * r * r * s * a + 3 * r * s * s * b + s * s * s
}
const cubD = (a, b, s) => {
	const r = 1 - s
	return 3 * r * r * a + 6 * r * s * (b - a) + 3 * s * s * (1 - b)
}
const cubDD = (a, b, s) => 6 * (1 - s) * (b - 2 * a) + 6 * s * (1 - 2 * b + a)

// Bezier parameter where x(s) = u. x is monotonic for x1, x2 in [0, 1].
export function easeParam(x1, x2, u) {
	let s = u
	for (let n = 0; n < 6; n++) {
		const d = cubD(x1, x2, s)
		if (Math.abs(d) < 1e-6) break
		s -= (cub(x1, x2, s) - u) / d
	}
	if (s >= 0 && s <= 1 && Math.abs(cub(x1, x2, s) - u) < 1e-7) return s
	let lo = 0,
		hi = 1
	for (let n = 0; n < 30; n++) {
		s = (lo + hi) / 2
		if (cub(x1, x2, s) < u) lo = s
		else hi = s
	}
	return s
}

export const easeAt = (e, u) => cub(e.y1, e.y2, easeParam(e.x1, e.x2, u))

// Least-squares handles c1, c2 of the 1D cubic 0 → c1 → c2 → 1 through targets at ss.
function fitHandles(ss, targets) {
	let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0
	for (let j = 0; j < ss.length; j++) {
		const s = ss[j], r = 1 - s
		const b1 = 3 * r * r * s, b2 = 3 * r * s * s, t = targets[j] - s * s * s
		a11 += b1 * b1
		a12 += b1 * b2
		a22 += b2 * b2
		r1 += b1 * t
		r2 += b2 * t
	}
	const det = a11 * a22 - a12 * a12
	if (Math.abs(det) < 1e-12) return null
	return [(r1 * a22 - r2 * a12) / det, (a11 * r2 - a12 * r1) / det]
}

// Ease with given x handles whose y handles best fit progress ps at times us.
function easeForX(us, ps, x1, x2) {
	const y = fitHandles(us.map((u) => easeParam(x1, x2, u)), ps)
	return y && { x1, y1: y[0], x2, y2: y[1] }
}

export const LINEAR = { x1: 0, y1: 0, x2: 1, y2: 1 }
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]

// An ease through progress ps at times us (both 0..1) whose error err(ease), in the
// caller's units, is within tol; null if none is found. Starts from a least-squares fit
// of the points (u, p) as a 2D curve, then searches the time handles.
export function fitEase(us, ps, err, tol) {
	if (err(LINEAR) <= tol) return LINEAR
	let ss = us.slice()
	let best = null
	for (let it = 0; it < 4; it++) {
		const x = fitHandles(ss, us),
			y = fitHandles(ss, ps)
		if (!x || !y) break
		const e = { x1: clamp01(x[0]), y1: y[0], x2: clamp01(x[1]), y2: y[1] }
		best = e
		// move each parameter to the curve's nearest point (Newton), as in Schneider's fit
		ss = ss.map((s, j) => {
			const dx = cub(e.x1, e.x2, s) - us[j], dy = cub(e.y1, e.y2, s) - ps[j]
			const x1 = cubD(e.x1, e.x2, s), y1 = cubD(e.y1, e.y2, s)
			const den = x1 * x1 + y1 * y1 + dx * cubDD(e.x1, e.x2, s) + dy * cubDD(e.y1, e.y2, s)
			return Math.abs(den) < EPS ? s : clamp01(s - (dx * x1 + dy * y1) / den)
		})
	}
	best = best ? easeForX(us, ps, best.x1, best.x2) : null
	if (!best) best = easeForX(us, ps, 0.5, 0.5)
	if (!best) return null
	let bestErr = err(best)
	for (let step = 0.2; step > 0.005 && bestErr > tol; step /= 2) {
		for (let moves = 0; moves < 12 && bestErr > tol; moves++) {
			let moved = false
			for (const [a, b] of DIRS) {
				const c = easeForX(us, ps, clamp01(best.x1 + a * step), clamp01(best.x2 + b * step))
				if (!c) continue
				const ce = err(c)
				if (ce < bestErr) (best = c), (bestErr = ce), (moved = true)
			}
			if (!moved) break
		}
	}
	return bestErr <= tol ? best : null
}

// ---------- 2D beziers ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const mul = (a, k) => [a[0] * k, a[1] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
const len = (a) => Math.hypot(a[0], a[1])

function bez(P, t) {
	const r = 1 - t, b0 = r * r * r, b1 = 3 * r * r * t, b2 = 3 * r * t * t, b3 = t * t * t
	return [b0 * P[0][0] + b1 * P[1][0] + b2 * P[2][0] + b3 * P[3][0], b0 * P[0][1] + b1 * P[1][1] + b2 * P[2][1] + b3 * P[3][1]]
}
function bezD(P, t) {
	const r = 1 - t
	const d = (i) => 3 * r * r * (P[1][i] - P[0][i]) + 6 * r * t * (P[2][i] - P[1][i]) + 3 * t * t * (P[3][i] - P[2][i])
	return [d(0), d(1)]
}
function bezDD(P, t) {
	const d = (i) => 6 * (1 - t) * (P[2][i] - 2 * P[1][i] + P[0][i]) + 6 * t * (P[3][i] - 2 * P[2][i] + P[1][i])
	return [d(0), d(1)]
}

// Parameter of the point on P nearest q, one Newton step from t.
function nearer(P, q, t) {
	const d = sub(bez(P, t), q), d1 = bezD(P, t), d2 = bezDD(P, t)
	const den = dot(d1, d1) + dot(d, d2)
	return Math.abs(den) < EPS ? t : clamp01(t - dot(d, d1) / den)
}

const sample = (P, m) => Array.from({ length: m + 1 }, (_, i) => bez(P, i / m))

function distToSegment(p, a, b) {
	const ab = sub(b, a), l2 = dot(ab, ab)
	const t = l2 < EPS ? 0 : clamp01(dot(sub(p, a), ab) / l2)
	return len(sub(p, add(a, mul(ab, t))))
}
function distToPolyline(p, poly) {
	let d = Infinity
	for (let i = 0; i < poly.length - 1; i++) d = Math.min(d, distToSegment(p, poly[i], poly[i + 1]))
	return poly.length === 1 ? len(sub(p, poly[0])) : d
}
// Both-ways (Hausdorff) distance between two polylines.
const polyDistance = (a, b) => Math.max(...a.map((p) => distToPolyline(p, b)), ...b.map((p) => distToPolyline(p, a)))

function chordParams(pts) {
	const ts = [0]
	for (let j = 1; j < pts.length; j++) ts.push(ts[j - 1] + len(sub(pts[j], pts[j - 1])))
	const total = ts[ts.length - 1]
	return total < EPS ? null : ts.map((t) => t / total)
}

// ---------- motion paths ----------
// Positions moving along a curve: one spatial bezier (the keys' `to`/`ti`) plus an ease
// over its length, which is how players interpolate spatial keys. pts[0] and the last
// point are the keys' values; us are the samples' times through the segment.
// -> { ease, to, ti } or null.
export function fitMotionPath(us, pts, tol) {
	const A = pts[0], B = pts[pts.length - 1]
	let ts = chordParams(pts)
	if (!ts) return null
	let P = null
	for (let it = 0; it < 4; it++) {
		let a11 = 0, a12 = 0, a22 = 0, rx1 = 0, ry1 = 0, rx2 = 0, ry2 = 0
		ts.forEach((t, j) => {
			const r = 1 - t, b0 = r * r * r, b1 = 3 * r * r * t, b2 = 3 * r * t * t, b3 = t * t * t
			const rx = pts[j][0] - b0 * A[0] - b3 * B[0], ry = pts[j][1] - b0 * A[1] - b3 * B[1]
			a11 += b1 * b1
			a12 += b1 * b2
			a22 += b2 * b2
			rx1 += b1 * rx
			ry1 += b1 * ry
			rx2 += b2 * rx
			ry2 += b2 * ry
		})
		const det = a11 * a22 - a12 * a12
		if (Math.abs(det) < 1e-12) return null
		const C1 = [(rx1 * a22 - rx2 * a12) / det, (ry1 * a22 - ry2 * a12) / det]
		const C2 = [(a11 * rx2 - a12 * rx1) / det, (a11 * ry2 - a12 * ry1) / det]
		P = [A, C1, C2, B]
		ts = ts.map((t, j) => (j === 0 ? 0 : j === ts.length - 1 ? 1 : nearer(P, pts[j], t)))
	}
	if (pts.some((q, j) => len(sub(bez(P, ts[j]), q)) > tol)) return null
	// arc length table: players move along the curve by length
	const N = 100
	const L = [0]
	let prev = A
	for (let i = 1; i <= N; i++) {
		const q = bez(P, i / N)
		L.push(L[i - 1] + len(sub(q, prev)))
		prev = q
	}
	const total = L[N]
	if (total < EPS) return null
	const fracAt = (t) => {
		const x = t * N, i = Math.min(N - 1, Math.floor(x))
		return (L[i] + (L[i + 1] - L[i]) * (x - i)) / total
	}
	const fracs = ts.map(fracAt)
	if (fracs.some((f, j) => j && f < fracs[j - 1] - 1e-6)) return null // doubles back along the curve
	const pointAt = (f) => {
		const d = f * total
		if (d <= 0) return bez(P, 0)
		if (d >= total) return bez(P, 1)
		let lo = 0, hi = N
		while (hi - lo > 1) {
			const m = (lo + hi) >> 1
			if (L[m] <= d) lo = m
			else hi = m
		}
		return bez(P, (lo + (d - L[lo]) / Math.max(L[hi] - L[lo], EPS)) / N)
	}
	// lottie-web can't go back past a motion path's start: progress below 0 (an ease
	// handle under 0) jumps to the segment's end. Handles at or above 0 never dip below.
	const atLeast0 = (e) => (e.y1 < 0 || e.y2 < 0 ? Object.assign({}, e, { y1: Math.max(0, e.y1), y2: Math.max(0, e.y2) }) : e)
	const err = (e) => {
		let worst = 0
		for (let j = 0; j < pts.length; j++) worst = Math.max(worst, len(sub(pointAt(easeAt(e, us[j])), pts[j])))
		return worst
	}
	let ease = fitEase(us, fracs, err, tol)
	if (ease && ease !== atLeast0(ease)) {
		const fixed = atLeast0(ease)
		ease = err(fixed) <= tol ? fixed : fitEase(us, fracs, (e) => err(atLeast0(e)), tol)
		ease = ease && atLeast0(ease)
	}
	return ease && { ease, to: sub(P[1], A), ti: sub(P[2], B) }
}

// ---------- static paths ----------

const isZero = (p) => Math.abs(p[0]) < EPS && Math.abs(p[1]) < EPS
const unit = (p) => {
	const l = len(p)
	return l < EPS ? null : [p[0] / l, p[1] / l]
}

// Removes vertices from a Lottie path ({c, v, i, o}; tangents relative to their vertex)
// while it stays within tol of the original everywhere. Neighbours keep their tangent
// directions, so corners stay corners; a point with no handles (a baked polyline) may
// instead take the outline's direction there, so dense straight segments refit as curves.
// Vertex 0 stays (trim paths and dashes start there). -> { shape, removed } or null.
export function simplifyPath(shape, tol) {
	const r = simplifyPathSet([shape], tol)
	return r && { shape: r.shapes[0], removed: r.removed }
}

// Direction of the original outline v at vertex j, from its neighbours (doubled points
// skipped); one-sided at an open path's ends.
function tangentAt(v, j, closed) {
	const n = v.length
	const step = (d) => {
		for (let s = 1; s < n; s++) {
			const q = j + d * s
			if (!closed && (q < 0 || q >= n)) return v[j]
			const p = v[(q + n) % n]
			if (len(sub(p, v[j])) > EPS) return p
		}
		return v[j]
	}
	return unit(sub(step(1), step(-1)))
}

// simplifyPath for several paths with the same points (keys of a morph): a vertex goes
// only if it can go from every one, so they still morph point to point. Each keeps its
// own handles. -> { shapes, removed } (removed per path) or null.
export function simplifyPathSet(shapes, tol) {
	const n = shapes[0].v.length
	const closed = !!shapes[0].c
	if (n < 3 || shapes.some((sh) => sh.v.length !== n || !!sh.c !== closed)) return null
	const segPts = (vv, ii, oo, a, b) => [vv[a], add(vv[a], oo[a]), add(vv[b], ii[b]), vv[b]]
	const nSeg = closed ? n : n - 1
	const st = shapes.map((sh) => {
		const v = sh.v.map((p) => p.slice()), I = sh.i.map((p) => p.slice()), O = sh.o.map((p) => p.slice())
		const orig = Array.from({ length: nSeg }, (_, j) => {
			const b = (j + 1) % n
			return sample(segPts(v, I, O, j, b), isZero(O[j]) && isZero(I[b]) ? 1 : 12)
		})
		return { v, I, O, orig, v0: sh.v }
	})
	const idx = st[0].v.map((_, j) => j)
	// handle directions to try leaving a (sign 1) or arriving at b (sign -1), from that
	// end's own handle if it has one, else smooth through it, else straight at its neighbour
	const dirs = (s, j, sign, own, other, toward) => {
		if (!isZero(own)) return [unit(own)]
		const t = tangentAt(s.v0, idx[j], closed)
		const smooth = isZero(other) ? t && mul(t, sign) : unit(mul(other, -1))
		return [smooth, ...toward.map((q) => unit(sub(q, s.v[j])))].filter(Boolean).slice(0, 2)
	}
	// new handles [C1, C2] for the segment a..b replacing a..k..b in one path, or null
	const refit = (s, a, k, b) => {
		const { v, I, O, orig } = s
		const S = []
		for (let j = idx[a]; j !== idx[b]; j = (j + 1) % n) S.push(...(S.length ? orig[j].slice(1) : orig[j]))
		const P0 = v[a], P3 = v[b]
		const left = segPts(v, I, O, a, k), right = segPts(v, I, O, k, b)
		if (isZero(O[a]) && isZero(I[k]) && isZero(O[k]) && isZero(I[b]) && polyDistance(S, [P0, P3]) <= tol) return [P0, P3] // straight lines stay straight
		for (const d1 of dirs(s, a, 1, O[a], I[a], [left[2], left[3]]))
			for (const d2 of dirs(s, b, -1, I[b], O[b], [right[1], right[0]])) {
				const fit = fitAlongTangents(S, P0, P3, d1, d2)
				if (!fit) continue
				const C1 = add(P0, mul(d1, fit[0])), C2 = add(P3, mul(d2, fit[1]))
				if (polyDistance(S, sample([P0, C1, C2, P3], 24)) <= tol) return [C1, C2]
			}
		return null
	}
	let removed = 0
	for (let changed = true; changed; ) {
		changed = false
		for (let k = 1; k < idx.length - (closed ? 0 : 1); k++) {
			if (idx.length <= (closed ? 3 : 2)) break
			const a = k - 1, b = (k + 1) % idx.length
			const fits = []
			for (const s of st) {
				const f = refit(s, a, k, b)
				if (!f) break
				fits.push(f)
			}
			if (fits.length < st.length) continue
			st.forEach((s, j) => {
				s.O[a] = sub(fits[j][0], s.v[a])
				s.I[b] = sub(fits[j][1], s.v[b])
				for (const arr of [s.v, s.I, s.O]) arr.splice(k, 1)
			})
			idx.splice(k, 1)
			removed++
			changed = true
			k--
		}
	}
	return removed ? { shapes: shapes.map((sh, j) => Object.assign({}, sh, { v: st[j].v, i: st[j].I, o: st[j].O })), removed } : null
}

// Handle lengths along fixed directions d1 (from P0) and d2 (from P3) fitting pts.
function fitAlongTangents(pts, P0, P3, d1, d2) {
	let ts = chordParams(pts)
	if (!ts) return null
	let alpha = null
	const chord = len(sub(P3, P0))
	for (let it = 0; it < 3; it++) {
		let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0
		ts.forEach((t, j) => {
			const r = 1 - t, b0 = r * r * r, b1 = 3 * r * r * t, b2 = 3 * r * t * t, b3 = t * t * t
			const A1 = mul(d1, b1), A2 = mul(d2, b2)
			const res = sub(pts[j], add(mul(P0, b0 + b1), mul(P3, b2 + b3)))
			a11 += dot(A1, A1)
			a12 += dot(A1, A2)
			a22 += dot(A2, A2)
			r1 += dot(A1, res)
			r2 += dot(A2, res)
		})
		const det = a11 * a22 - a12 * a12
		alpha = Math.abs(det) < 1e-12 ? null : [(r1 * a22 - r2 * a12) / det, (a11 * r2 - a12 * r1) / det]
		if (!alpha || alpha[0] < EPS || alpha[1] < EPS) alpha = [chord / 3, chord / 3]
		const P = [P0, add(P0, mul(d1, alpha[0])), add(P3, mul(d2, alpha[1])), P3]
		ts = ts.map((t, j) => (j === 0 ? 0 : j === ts.length - 1 ? 1 : nearer(P, pts[j], t)))
	}
	return alpha
}
