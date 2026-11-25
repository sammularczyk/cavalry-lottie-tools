# Changelog

## Lottie Optimiser 1.3.0 (unreleased additions)
- **shareSameShape now reuses the exporter's own precomp assets.** Groups whose geometry, colour curve and hold-blink pattern match an existing asset demote onto it instead of duplicating their full curves in the main layer (master copies included). Hold-blink matching tolerates the final key's omitted `h` flag.
- **binaryWindows profitability guard.** A paint-driven blink split no longer fires when the blinking paint is a minor part of a large layer (a 1.5KB blink beside an 8.5KB colour curve made each window clone more expensive than the dead frames saved).
- Grid duplicator exports: 1.4MB → 796KB on the reference scene, pixel-perfect (0.000% worst-frame difference over 24 frames).

## Lottie Optimiser 1.3.0 (2026-10-08)
- Optimisation improvements
- UI updates

## Lottie Optimiser 1.2.0 (2026-10-08)
- Added support for **Tapered Strokes**, **Auto-Animate deformer** and **Shader Arrays**
- Improved fidelity of gradients and added gradient stroke support
- Updated UI

## Lottie Optimiser 1.0.0, Lottie Importer 1.1.0 (2026-10-02)
Initial release
