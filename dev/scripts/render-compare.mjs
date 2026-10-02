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
    { const im = c.getContext('2d').getImageData(0,0,c.width,c.height); im.data.w = im.width; out.push(im.data) }
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
    let worst = 0, bad = 0, vis = 0, blur = 0
    ra.forEach((da, k) => { const db = rb[k]; let diff = 0, big = 0; for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i]-db[i]); if (d > 2) diff++; if (d > 32) big++ } vis = Math.max(vis, 100*big/da.length); const W = da.w, H = da.length / 4 / W; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let c = 0; c < 3; c++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = ((y+dy)*W + x+dx)*4 + c; s += da[i] - db[i] } blur = Math.max(blur, Math.abs(s) / 9) } const pct = 100*diff/da.length; worst = Math.max(worst, pct); if (pct > 0.1) bad++ })
    lines.push(p.name + ': worst frame ' + worst.toFixed(3) + '% px differ, frames over 0.1%: ' + bad + '/' + n + ', visibly (>32/255) ' + vis.toFixed(3) + '%, worst blurred difference ' + blur.toFixed(1) + '/255')
  }
  document.getElementById('log').textContent = 'DONE\\n' + lines.join('\\n')
})().catch(e => document.getElementById('log').textContent = 'ERR ' + e.stack)
</script>`
fs.writeFileSync(out, html); fs.writeFileSync(out.replace(/[^/]+$/, 'pairs.json'), JSON.stringify(pairs))
