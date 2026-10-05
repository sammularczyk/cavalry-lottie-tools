# Cavalry Lottie Tools

Lottie import and export for [Cavalry](https://cavalry.studio).

- **Lottie Importer**: opens Lottie `.json` files as native Cavalry layers.
- **Lottie Optimiser**: Export Cavalry comps to Lottie with even higher fidelity and lower file size than the default exporter. Customise the settings to get them even smaller, and validate your files against different runtimes.

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

## License
MIT
