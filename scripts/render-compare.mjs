import fs from 'fs'
import { optimise } from '../src/modules/passes.js'
// Usage: node scripts/render-compare.mjs <outDir> file.json...  then serve outDir and open index.html.
// Renders each file before and after optimise() with lottie-web (canvas) and reports differing pixels.
const out = process.argv[2] + '/index.html'; fs.mkdirSync(process.argv[2], { recursive: true }); const files = process.argv.slice(3)
const pairs = files.map(f => { const j = JSON.parse(fs.readFileSync(f,'utf8')); return { name: f.split('/').pop(), a: j, b: optimise(j, { exponent: true }).text } })
const html = `<!doctype html><meta charset=utf-8><body style="background:#fff"><pre id=log>running</pre>
<script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
<script>
const RENDERER = new URLSearchParams(location.search).get('r') || 'canvas';

async function render(data, frames) {
  const div = document.createElement('div'); div.style.width = '600px'; div.style.height = '300px'; document.body.appendChild(div)
  const anim = lottie.loadAnimation({ container: div, renderer: RENDERER, loop: false, autoplay: false, animationData: data, rendererSettings: { clearCanvas: true } })
  await new Promise(r => anim.isLoaded ? r() : anim.addEventListener('DOMLoaded', r))
  const out = []
  for (const f of frames) {
    anim.goToAndStop(f, true)
    let c = div.querySelector('canvas')
    if (!c) { // svg: rasterise it the way a browser would draw it
      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(div.querySelector('svg')))
      await img.decode()
      c = document.createElement('canvas'); c.width = 600; c.height = 300
      c.getContext('2d').drawImage(img, 0, 0, 600, 300)
    }
    out.push(c.getContext('2d').getImageData(0,0,c.width,c.height).data)
  }
  anim.destroy(); div.remove(); return out
}
(async () => {
  const PAIRS = await (await fetch('pairs.json')).json()
  const lines = []
  for (const p of PAIRS) {
    const a = p.a, b = JSON.parse(p.b); const n = 24
    const frames = Array.from({length:n}, (_, i) => Math.floor((a.op - a.ip - 1) * i / (n-1)))
    const ra = await render(a, frames), rb = await render(b, frames)
    let worst = 0, bad = 0
    ra.forEach((da, k) => { const db = rb[k]; let diff = 0; for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i]-db[i]); if (d > 2) diff++ } const pct = 100*diff/da.length; worst = Math.max(worst, pct); if (pct > 0.1) bad++ })
    lines.push(p.name + ': worst frame ' + worst.toFixed(3) + '% px differ, frames over 0.1%: ' + bad + '/' + n)
  }
  document.getElementById('log').textContent = 'DONE\\n' + lines.join('\\n')
})().catch(e => document.getElementById('log').textContent = 'ERR ' + e.stack)
</script>`
fs.writeFileSync(out, html); fs.writeFileSync(out.replace(/[^/]+$/, 'pairs.json'), JSON.stringify(pairs))
