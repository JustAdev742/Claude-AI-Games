/* Performance benchmark: loads a fixed world, then measures a stationary
   phase (steady-state rendering) and a flythrough (chunk streaming under
   movement). Prints JSON.

   Software rendering (swiftshader) stands in for a weak GPU: it is fill-rate
   bound, so changes that cut fragment work or draw load show up here, and the
   CPU-side sections (generation, lighting, meshing, uploads) are measured
   directly by the in-game profiler (core/perf.js).

   Usage: node tests/bench.mjs [--settings '{"renderDistance":6}'] [--size 800x450]
                               [--still 6] [--fly 14] [--file dist/voxel-odyssey.html] [--label name]
   --file benchmarks a built single-file bundle (via file://) instead of the source. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const SETTINGS = JSON.parse(arg('settings', '{}'));
const [W, H] = arg('size', '800x450').split('x').map(Number);
const STILL = Number(arg('still', 6));
const FLY = Number(arg('fly', 14));
const FILE = arg('file', '');
const LABEL = arg('label', FILE ? 'bundle' : 'source');
const PORT = 8110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  const fs = require('fs');
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of fs.readdirSync(base)) {
    if (d.startsWith('chromium-')) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const server = FILE ? null : spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
await sleep(800);
let browser;
const out = { label: LABEL, size: `${W}x${H}`, settings: SETTINGS };
try {
  browser = await chromium.launch({
    headless: true, executablePath: findChromium() || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--enable-precise-memory-info'],
  });
  const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(FILE ? 'file://' + path.resolve(ROOT, FILE) : `http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 60000 });
  await page.evaluate((s) => {
    const q = window.GAME.quality;
    // `quality` picks a preset (which writes its bundle of settings); anything
    // else is applied as an individual setting afterwards.
    if (s.quality) q.setPreset(s.quality);
    for (const [k, v] of Object.entries(s)) if (k !== 'quality') window.GAME.state.set(k, v);
    window.GAME.state.set('dynamicResolution', !!s.dynamicResolution);   // off unless asked: a benchmark must not move its own goalposts
  }, SETTINGS);

  // ---- time to playable --------------------------------------------------
  const t0 = Date.now();
  await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'bench', gamemode: 'creative' }));
  await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 240000 });
  out.loadSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  // Let background streaming finish so the "still" phase measures steady-state
  // rendering rather than chunks arriving.
  await page.waitForFunction(() => {
    const w = window.GAME.world;
    return w._plan && w._planIdx >= w._plan.length && w.remeshQueue.size === 0 && w.meshPool.pending === 0;
  }, null, { timeout: 120000 }).catch(() => {});
  await sleep(1500);

  // ---- measurement harness inside the page ---------------------------------
  await page.evaluate(() => {
    const g = window.GAME;
    g.state.flags.mode = 'play'; g.state.flags.paused = false;
    g.player.setGamemode('creative'); g.player.flying = true;
    const px = g.player.position.x, pz = g.player.position.z;
    g.player.position.set(px, g.world.heightAt(Math.floor(px), Math.floor(pz)) + 18, pz);
    g.player.velocity.set(0, 0, 0);
    g.player.yaw = 0.6; g.player.pitch = -0.25;
    g.sky.setTime(0.45);
    window.__run = (seconds, speed) => new Promise((resolve) => {
      g.perf.resetWindow();
      for (const k in g.perf.avg) g.perf.avg[k] = 0;
      const frames = []; let last = performance.now(); const start = last;
      const startGeo = g.renderer.info.memory.geometries;
      const hx = -Math.sin(0.6), hz = -Math.cos(0.6);
      const tick = (now) => {
        const dt = (now - last) / 1000; last = now;
        frames.push(dt * 1000);
        if (speed > 0) {
          const y = g.player.position.y;
          g.player.position.x += hx * speed * dt; g.player.position.z += hz * speed * dt;
          g.player.position.y = y; g.player.velocity.set(0, 0, 0);
        }
        if (now - start < seconds * 1000) requestAnimationFrame(tick);
        else {
          const sorted = frames.slice(1).sort((a, b) => a - b);
          const p = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1);
          const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
          const info = g.renderer.info;
          resolve({
            frames: sorted.length, fps: +(1000 / mean).toFixed(1), frameMs: { mean: +mean.toFixed(1), p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +sorted[sorted.length - 1].toFixed(1) },
            hitchesOver40ms: sorted.filter((f) => f > 40).length, hitchesOver100ms: sorted.filter((f) => f > 100).length,
            cpuMs: Object.fromEntries(Object.entries(g.perf.avg).map(([k, v]) => [k, +v.toFixed(2)])),
            worstMs: Object.fromEntries(Object.entries(g.perf.worst).map(([k, v]) => [k, +v.toFixed(1)]).filter(([, v]) => v > 8)),
            draw: { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, newGeometries: info.memory.geometries - startGeo },
            tris: (() => { const o = { opaque: 0, water: 0, cross: 0, verts: 0, bytes: 0 }; for (const set of g.world.meshes.values()) for (const k of ['opaque', 'water', 'cross']) { const m = set[k]; if (m) { o[k] += m.geometry.index.count / 3; o.verts += m.geometry.attributes.aPos.count; for (const a of Object.values(m.geometry.attributes)) o.bytes += a.array.byteLength; o.bytes += m.geometry.index.array.byteLength; } } return o; })(),
            chunks: g.world.chunks.size, meshes: g.world.meshes.size, workers: g.world.meshPool.enabled,
            heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
          });
        }
      };
      requestAnimationFrame(tick);
    });
  });
  out.still = await page.evaluate((s) => window.__run(s, 0), STILL);
  out.fly = await page.evaluate((s) => window.__run(s, 14), FLY);
  out.errors = errors.slice(0, 5);
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGKILL');
}
console.log(JSON.stringify(out, null, 1));
