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
- Exporter: clipping masks on groups (dropped by Cavalry's writer) are rebuilt on every drawing layer under the group, sampled from the scene.
- Exporter: layers running to their comp's last frame no longer vanish on it (Cavalry's end frame is inclusive, Lottie's exclusive), fixing a one-frame flash each time a precomp loops.
- Exporter: parent opacity is folded into children (Cavalry children inherit it, Lottie children don't), and group opacity is read from the scene (the writer drops it).
- Exporter: static rotation and scale are taken from the scene (the writer exported some comp references unrotated).
- Optimiser: "Hold one-frame jumps" (on by default) holds the key before a value that jumps between adjacent frames, so players drawing in-between frames don't slide it; optional "Hold every frame-by-frame key" steps exactly like Cavalry's frames.
- Exporter: hold (step) keys are restored from the scene; Cavalry's writer exports them as eases, so values Cavalry holds then snaps (the dreidel lines' stroke width) faded across the gap.
- Optimiser: still group layers fold into their children ("Fold still group layers").
- Exporter: keyframed transforms the writer baked per frame use the scene's keys and eases instead, when they reproduce the bake on every frame.
