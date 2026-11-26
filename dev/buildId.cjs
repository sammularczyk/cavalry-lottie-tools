// Build ID hashing — shared by build.cjs (generates) and verify-build.cjs
// (recomputes), so the two can never drift apart.

// FNV-1a 32-bit over the timestamp, then base36 — 6 alphanumeric characters.
function hashBuildId(input) {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return (hash % 36 ** 6).toString(36).toUpperCase().padStart(6, '0')
}

module.exports = { hashBuildId }
