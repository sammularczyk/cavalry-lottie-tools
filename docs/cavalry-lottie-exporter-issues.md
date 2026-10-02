# Cavalry Lottie exporter: issues and recommended fixes

Found on 2026-10-02 by comparing exports against Cavalry's own renders, in lottie-web (SVG/Canvas) and ThorVG (dotLottie). Each issue was reproduced on a real scene (an After Effects card imported into Cavalry), and most also in minimal probe comps.

| # | Issue | Effect | Recommended fix |
|---|---|---|---|
| 1 | Comp references are inlined as one shape layer. Nested references that have their own `timeOffset` export as a frozen frame. | Nested precomps don't animate (flames, spinning dreidels). | Export each referenced comp once as a Lottie precomp asset. Write references as `ty:0` layers with `st` = timeOffset and `tm` from timeRemapping. |
| 2 | Every comp reference is written out in full. | Duplicate content inflates files: 4 coin copies = 244 KB of a 463 KB file. | Same as 1: reference one shared asset. |
| 3 | Position around a pivot: exported p = P − R·S·anchor, with R/S taken at whatever frame the comp last showed (`comp.time`), not the frame being written. When the transform is connected (rigs), there's no shift but the anchor's x sign is flipped. | Layers with a pivot are offset, and drift when rotating or scaling (text, sprigs). | Write p = P (the position) and a = (pivot.x, −pivot.y). Don't add compensation. |
| 4 | Rotation dropped on some comp references: 3 of 5 identical references exported with r = 0. | Content upright instead of rotated. | Always write the reference's rotation and scale. |
| 5 | Group opacity animation dropped (exported as a static 100). | Show/hide animation lost. | Export group opacity keys. |
| 6 | Children inherit their parent's opacity in Cavalry; Lottie parenting doesn't. | Children of faded groups stay visible. | Multiply ancestors' opacity into each drawing layer (constant, or keyed). |
| 7 | Hold keyframes (interpolation 2) are exported as eased segments. | Values that should snap fade instead (stroke-width toggles). | Write `h:1` on hold keys. |
| 8 | Masks on groups are dropped, with their mask shapes. | Unclipped content. | Write the mask on every drawing layer under the group, in each layer's space; a Lottie mask on a parent doesn't clip its children. Modes: 0 union→`a`, 1 subtract→`s`, 2 intersect→`a` (first) / `i`. |
| 9 | A layer that ends on the comp's last frame gets op = endFrame, but Cavalry's end frame is inclusive and Lottie's op exclusive. | One-frame flash every time a precomp loops. | op = endFrame + 1. |
| 10 | Guide layers (`guideLayer` ≠ 0) and their children are exported. | Stray guide shapes appear. | Skip guide layers and their descendants. |
| 11 | Static values written as animated with one key (`a:1`, one keyframe). | lottie-web stops drawing the layer entirely, and raw exports render blank. | Write `a:0` with the value. |
| 12 | Animated keyframes baked to one key per frame (flame scale: 3 × ~490 keys, 130 KB). | Huge files. | Export the scene keyframes and eases when they map directly. Bake only for magic easing or drivers. |
| 13 | Every group becomes a full Lottie layer (502 of 839 layers drew nothing; 362 KB). | Bloated files, and slower players. | Fold static, non-drawing groups into their children's transforms. |
| 13b | Every path is wrapped in groups inside groups, each with a full transform, even when those transforms are the identity. | ~13% of the file is transforms that do nothing. | Write a group only where it has a non-identity transform, its own fill/stroke scope or a modifier; otherwise write the items into the parent. |
| 14 | Data hygiene: `v:"4.6.8"`, float32 noise (`59.90163803100586`), empty `nm`/`mn`, zero skew/`ao` on every layer. | Larger files. | Write a current `v`, round to sensible precision, and omit default fields. |
| 15 | Skew isn't exported (documented limitation). | Skewed content renders unskewed. | Write `sk`/`sa`. |

Workarounds for all of these, except skew, are in `src/modules/precomps.js` and `src/modules/passes.js` of cavalry-lottie-tools.
