/* The shipped artefact, tested the way a player gets it: open play.html from
   disk (file://, no server), follow a launcher link to the single-file build,
   start a world, and check that it really runs — workers included, which in a
   single file come from an embedded Blob rather than a worker file.

   Needs dist/voxel-odyssey.html built (npm run build). */
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of fs.readdirSync(base)) {
    if (d.startsWith('chromium-')) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  const report = { ok: false };
  const errors = [];
  let browser;
  try {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'voxel-odyssey.html'))) throw new Error('dist/voxel-odyssey.html is missing — run `npm run build`');
    browser = await chromium.launch({
      headless: true, executablePath: findChromium() || undefined,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });
    const page = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

    // ---- the launcher page lists every mode and links resolve ---------------
    await page.goto(pathToFileURL(path.join(ROOT, 'play.html')).href);
    const links = await page.$$eval('a.play', (as) => as.map((a) => a.getAttribute('href')));
    report.links = links;
    const target = path.join(ROOT, 'dist', 'voxel-odyssey.html');
    report.linksPointAtBundle = links.length === 3 && links.every((h) => h.startsWith('dist/voxel-odyssey.html'));

    // ---- follow the "very slow computer" link --------------------------------
    await Promise.all([
      page.waitForURL(/voxel-odyssey\.html/),
      page.click('a.play:nth-of-type(3)'),
    ]);
    report.url = page.url().replace(pathToFileURL(ROOT).href, '');
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 30000 });
    report.settings = await page.evaluate(() => {
      const s = window.GAME.state.settings;
      return { quality: s.quality, renderDistance: s.renderDistance, renderScale: s.renderScale, maxFps: s.maxFps, shaderTier: s.shaderTier };
    });

    // ---- start a world and let the workers do their job -----------------------
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'bundle', gamemode: 'survival' }));
    await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 120000 });
    await sleep(2500);
    report.world = await page.evaluate(() => {
      const g = window.GAME, w = g.world, pool = w.meshPool;
      return {
        workers: pool.enabled, workerCount: pool.workers.length,
        chunks: w.chunks.size, meshes: w.meshes.size,
        generatedByWorkers: pool.stats.generated, meshedByWorkers: pool.stats.meshed,
        rendering: g.renderer.info.render.calls > 0,
        renderDistance: g.state.renderDistance,
      };
    });
    report.errors = errors.slice(0, 5);

    // ---- workers blocked (a strict sandbox/CSP): the game must still run -------
    // Two ways that can fail: the constructor throws, or the worker dies after
    // being created. Either way the main thread has to take over everything.
    const blocked = {};
    for (const [name, script] of [
      ['ctorThrows', () => { window.Worker = function () { throw new Error('workers blocked (test)'); }; }],
      ['diesAfterStart', () => {
        window.Worker = class { constructor() { setTimeout(() => { if (this.onerror) this.onerror({ message: 'worker died (test)' }); }, 80); } postMessage() {} terminate() {} };
      }],
    ]) {
      const p2 = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
      const errs = [];
      p2.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
      await p2.addInitScript(script);
      await p2.goto(pathToFileURL(target).href);
      await p2.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 30000 });
      await p2.evaluate(() => window.GAME.events.emit('game:new', { seed: 'blocked', gamemode: 'survival' }));
      await p2.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 120000 });
      await sleep(1500);
      blocked[name] = await p2.evaluate(() => {
        const w = window.GAME.world;
        return { workers: w.meshPool.enabled, chunks: w.chunks.size, meshes: w.meshes.size, pending: w.meshPool.pending, genPending: w._genPending.size };
      });
      blocked[name].errors = errs.slice(0, 3);
      await p2.context().close();
    }
    report.blocked = blocked;

    const s = report.settings, w = report.world;
    report.ok = !!(report.linksPointAtBundle
      && /quality=low/.test(report.url) && /distance=3/.test(report.url)
      && s.quality === 'low' && s.renderDistance === 3 && Math.abs(s.renderScale - 0.6) < 1e-6 && s.maxFps === 30
      && w.workers && w.workerCount >= 1
      && w.generatedByWorkers > 0 && w.meshedByWorkers > 0
      && w.chunks > 20 && w.meshes > 10 && w.rendering
      && errors.length === 0
      && Object.values(blocked).every((b) => !b.workers && b.chunks > 20 && b.meshes > 10 && b.pending === 0 && b.genPending === 0 && b.errors.length === 0));
  } catch (e) {
    report.error = String((e && e.stack) || e);
  } finally {
    if (browser) await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})();
