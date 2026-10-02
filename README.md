# Cavalry Lottie Tools

Lottie import and export for [Cavalry](https://cavalry.studio).

- **Lottie Importer**: opens Lottie `.json` files as native Cavalry layers.
- **Lottie Optimiser**: wraps Cavalry's own Lottie export, then checks the result against each target player, optimises it, embeds assets and packages it as `.json` or `.lottie`.

## Install
Copy the `.jsc` scripts into Cavalry's Scripts folder.

## Develop
All dev files live in `dev/`.
```
cd dev
npm install
npm run dev      # watch build, symlinked into Cavalry's Scripts folder
npm test         # Node tests for the pure JSON passes
npm run release  # builds and copies the .jsc files to the repo root
```
