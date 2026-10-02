# Cavalry Lottie exporter: issues and recommended fixes

Found on 2026-10-02 by comparing exports against Cavalry's own renders, in lottie-web (SVG/Canvas) and ThorVG (dotLottie). Each issue was reproduced on a real scene (an After Effects card imported into Cavalry), and most also in minimal probe comps.

**Impact on that card:** Cavalry exports 463 KB, with frozen precomps, misplaced text and flashing loops. With every fix below applied, the same card is 228 KB, and it renders like Cavalry. The After Effects export of the original is 352 KB. Most of the saving comes from 2, 7 and 15–18.

## Rendering

| # | Issue | Effect | Recommended fix |
|---|---|---|---|
| 1 | Comp references are inlined as one shape layer. Nested references that have their own `timeOffset` export as a frozen frame. | Nested precomps don't animate (flames, spinning dreidels). | Export each referenced comp once as a Lottie precomp asset. Write references as `ty:0` layers with `st` = timeOffset and `tm` from timeRemapping. |
| 2 | Every comp reference is written out in full. | Duplicate content inflates files: 4 coin copies = 244 KB of a 463 KB file. | Same as 1: reference one shared asset. |
| 3 | Position around a pivot: exported p = P − R·S·anchor, with R/S taken at whatever frame the comp last showed (`comp.time`), not the frame being written. When the transform is connected (rigs), there's no shift but the anchor's x sign is flipped. | Layers with a pivot are offset, and drift when rotating or scaling (text, sprigs). | Write p = P (the position) and a = (pivot.x, −pivot.y). Don't add compensation. |
| 4 | Rotation dropped on some comp references: 3 of 5 identical references exported with r = 0. | Content upright instead of rotated. | Always write the reference's rotation and scale. |
| 5 | Group opacity animation dropped (exported as a static 100). | Show/hide animation lost. | Export group opacity keys. |
| 6 | Children inherit their parent's opacity in Cavalry; Lottie parenting doesn't. | Children of faded groups stay visible. | Multiply ancestors' opacity into each drawing layer (constant, or keyed). |
| 7 | Path shapes (editable shapes) are written as `gr{gr{path, fill}, fill}`: the same fill or stroke on the inner group and again on the outer one, so players paint the path twice. Primitives (rectangle, ellipse) are written once. | See-through colours render stronger than in Cavalry (a 50% red shows as 75%), and edges darken. Also doubles the paint data. | Write each paint once, after the path. |
| 8 | Hold keyframes (interpolation 2) are exported as eased segments. | Values that should snap fade instead (stroke-width toggles). | Write `h:1` on hold keys. |
| 9 | Baked keys are written once per frame, but players draw in-between frames (120 Hz screens, time-remapped precomps). | Values that jump between two frames (a baked path wrapping round, a layer snapping into place) slide across the gap instead of snapping. | Write `h:1` on a baked key when the value jumps to the next one. |
| 10 | Masks on groups are dropped, with their mask shapes. | Unclipped content. | Write the mask on every drawing layer under the group, in each layer's space; a Lottie mask on a parent doesn't clip its children. Modes: 0 union→`a`, 1 subtract→`s`, 2 intersect→`a` (first) / `i`. |
| 11 | A layer that ends on the comp's last frame gets op = endFrame, but Cavalry's end frame is inclusive and Lottie's op exclusive. | One-frame flash every time a precomp loops. | op = endFrame + 1. |
| 12 | Guide layers (`guideLayer` ≠ 0) and their children are exported. | Stray guide shapes appear. | Skip guide layers and their descendants. |
| 13 | Static values written as animated with one key (`a:1`, one keyframe). | lottie-web stops drawing the layer entirely, and raw exports render blank. | Write `a:0` with the value. |
| 14 | Skew isn't exported (documented limitation). | Skewed content renders unskewed. | Write `sk`/`sa`. |

## File size

| # | Issue | Effect | Recommended fix |
|---|---|---|---|
| 15 | Animated keyframes baked to one key per frame (flame scale: 3 × ~490 keys, 130 KB). | Huge files. | Export the scene keyframes and eases when they map directly. Bake only for magic easing or drivers. |
| 16 | Every group becomes a full Lottie layer (502 of 839 layers drew nothing; 362 KB). | Bloated files, and slower players. | Fold static, non-drawing groups into their children's transforms. |
| 17 | Every shape is its own Lottie layer. | 4× the layers of an After Effects export (355 vs 82); each layer carries a header and a full transform. | Write neighbouring shapes with the same parent and timing as groups in one layer. |
| 18 | A filled and stroked path is written as two groups, each holding its own copy of the path. | Paths stored twice. | Write one copy of the path followed by its stroke and fill. |
| 19 | Every path is wrapped in groups inside groups, each with a full transform, even when those transforms are the identity. | ~13% of the file is transforms that do nothing. | Write a group only where it has a non-identity transform, its own fill/stroke scope or a modifier; otherwise write the items into the parent. |
| 20 | Data hygiene: `v:"4.6.8"`, float32 noise (`59.90163803100586`), empty `nm`/`mn`, zero skew/`ao` on every layer. | Larger files. | Write a current `v`, round to sensible precision, and omit default fields. |

Workarounds for all of these, except skew, are in `src/modules/precomps.js` and `src/modules/passes.js` of cavalry-lottie-tools.
