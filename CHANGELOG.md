# Changelog

## Unreleased
- Lottie Importer moved here from Canvalry-scripts.
- Importer: Normal blend mode maps to Cavalry's 3 (0 was ignored); Lottie Add maps to Plus Lighter.
- Importer: scalar ease tangents no longer produce NaN handles; spatial samples use an exact bezier solve.
- Importer: opens `.lottie` files (dotLottie v1 and v2).
- Importer: loads external images (`u` + `p`), not just embedded ones; embedded images are detected by their `data:` prefix.
- Exporter: comp references export as real precomps (each comp once, with its time offset and time remapping), fixing nested comps that Cavalry's writer exports frozen.
- Exporter: every layer is checked against the scene and positions around pivots corrected (Cavalry's writer shifts them by rotation × scale × pivot at whatever frame the comp last showed, or flips the anchor when the transform is connected).
- Exporter: guide layers are left out; one-key animated properties are written static (they stop lottie-web drawing the layer).
