# Changelog

## Unreleased
- Lottie Importer moved here from Canvalry-scripts.
- Importer: Normal blend mode maps to Cavalry's 3 (0 was ignored); Lottie Add maps to Plus Lighter.
- Importer: scalar ease tangents no longer produce NaN handles; spatial samples use an exact bezier solve.
- Importer: opens `.lottie` files (dotLottie v1 and v2).
- Importer: loads external images (`u` + `p`), not just embedded ones; embedded images are detected by their `data:` prefix.
