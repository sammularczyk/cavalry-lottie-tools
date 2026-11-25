# Changelog

## Lottie Optimiser 1.3.0 (unreleased additions)
- **shareSameShape now reuses the exporter's own precomp assets.** Groups whose geometry, colour curve and hold-blink pattern match an existing asset demote onto it instead of duplicating their full curves in the main layer (master copies included). Hold-blink matching tolerates the final key's omitted `h` flag.
- **binaryWindows profitability guard.** A paint-driven blink split no longer fires when the blinking paint is a minor part of a large layer (a 1.5KB blink beside an 8.5KB colour curve made each window clone more expensive than the dead frames saved).
- **decomposeSharedPaints (new pass).** The exporter writes one precomp per (colour curve, blink phase) combination, so copies sharing an expensive animated colour curve but blinking on different phases each store their own curve. The pass groups single-fill shape assets by byte-identical colour curve, retargets every family member's refs to one representative (its blink forced to static full) and moves each blink onto the ref layer's own opacity, which Lottie multiplies with the asset's paint. Profitability guard skips families where added ref blink bytes exceed the dropped layers.
- **cullFalloffHidden also follows shapeOpacity chains** (not just shapeVisibility) and accepts base values of 1 and 100, so falloff-driven `shapeOpacity` rigs cull hidden cells too.
- **stripZeroOpacity (new pass).** Removes anything that is 0% opacity at every frame: layers with an all-zero opacity (static or animated), fill paints with an all-zero opacity, and groups whose own opacity is all-zero. Complements the static-only layer removal; sub-mesh falloff rigs that bake some copies to zero now lose them entirely.
- **cullFalloffHidden now culls ref layers too.** Precomp ref layers (the demoted duplicator copies) are tested against the decoded static falloff at their on-screen position and dropped when they land at exact zero — previously only in-layer groups were culled, so stacked duplicators kept their hole cells.
- **binaryWindows layer-opacity split profitability guard.** A layer-driven blink split that would deep-copy the layer more often than the dropped blink curve saves is skipped.
- Grid duplicator exports: 1.4MB → 524KB on the reference scene, pixel-perfect (0.000% worst-frame difference over 24 frames).

## Lottie Optimiser 1.3.0 (2026-10-08)
- Optimisation improvements
- UI updates

## Lottie Optimiser 1.2.0 (2026-10-08)
- Added support for **Tapered Strokes**, **Auto-Animate deformer** and **Shader Arrays**
- Improved fidelity of gradients and added gradient stroke support
- Updated UI

## Lottie Optimiser 1.0.0, Lottie Importer 1.1.0 (2026-10-02)
Initial release
