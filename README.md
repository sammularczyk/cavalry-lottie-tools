# Cavalry Lottie Tools

Lottie import and export for [Cavalry](https://cavalry.studio).

<a href="https://github.com/sammularczyk/cavalry-lottie-tools/releases/latest"><img width="124" height="36" alt="Download" src="https://github.com/user-attachments/assets/b5eccc22-fbe2-4dbe-b66d-df42880c7044" /></a>

Download above and copy the `.jsc` scripts into Cavalry's Scripts folder.


### Lottie Importer
Import Lottie files as native Cavalry layers.

<img width="317" height="129" alt="Lottie Importer UI" src="https://github.com/user-attachments/assets/28d9f644-8565-4d1f-816a-b05fcd8adab8" />

### Lottie Optimiser

Export Cavalry comps to Lottie with even higher fidelity and lower file size than other exporters. Saves up to 91% from the default exporter, with higher fidelity.

Customise the settings to get them even smaller, and validate your files against different runtimes.

<img width="381" height="593" alt="Screenshot 2026-10-05 at 12 22 05" src="https://github.com/user-attachments/assets/04f9a57d-a062-43bd-882d-3f1e40c46abf" />


| Preset | Description |
| --- | --- |
| Safe | Works on most renderers. Keeps layer names. |
| Smaller | Rounds numbers and points slightly. Keeps layer names. |
| Extreme | Up to 1px difference. No names, Compresses opaque images as JPEGs. |
| Custom | Mix and match techniques. |




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
