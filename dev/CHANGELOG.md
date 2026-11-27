# Changelog

## Lottie Optimiser 1.5.0 (unreleased)
- **Duplicators built from a composition now export properly**, each copy keeping its own position and delay.
- **Timing driven by a Random or Noise needs two Export clicks**, since nothing outside Cavalry can reproduce those offsets.
- **Cell grids filled from an image array now export the actual pictures**, one per copy in the array's order.
- **Shader image fills export as real images** instead of flat squares of their material colour, including when the artwork sits in a nested comp that a duplicator repeats.
- **See-through fills stay see-through.** Cavalry writes a fill's transparency into the colour, which no player reads; it now goes into the fill's opacity, where players expect it.
- **Falloff reveals and other keyed changes play smoothly**, and on and off visibility switches instantly rather than easing. The measurement bakes a handful of frames inside each keyed span and nowhere else.
- **Measurement follows the range you play** and copes with scaled groups and wrapped distributions.
- **Titles and other text in short groups no longer disappear** from the export.
- **Exports of a trimmed playback range no longer start on the wrong colour or frame.**
- **Hidden and faded copies are reproduced per copy**, including ones that change state partway through.
- **Helper nodes such as falloffs no longer leak into the export** as empty layers or console errors.
- **Exports with embedding turned off save into their own folder**, so they never mix with an earlier export.
- **The export can no longer delete your own layers** if its measurement data comes back malformed.
- **Anything invisible for the whole animation is left out**, including cells a falloff fades to nothing.
- **Anything repeated is stored once**: shared artwork, colour animations, blinks and duplicator animations collapse to one copy each, keeping their own timing.
- **Scaled duplicators keep their size** after the rewrite, and other shapes on the same layer survive it.
- **Optimised exports come out more than half the size**, with no visible difference from the original.
- **The Build ID in the settings menu is now a short six-character code**, easy to quote when reporting a problem.

## Lottie Optimiser 1.3.0 (2026-10-08)
- Optimisation improvements
- UI updates

## Lottie Optimiser 1.2.0 (2026-10-08)
- Added support for **Tapered Strokes**, **Auto-Animate deformer** and **Shader Arrays**
- Improved fidelity of gradients and added gradient stroke support
- Updated UI

## Lottie Optimiser 1.0.0, Lottie Importer 1.1.0 (2026-10-02)
Initial release
