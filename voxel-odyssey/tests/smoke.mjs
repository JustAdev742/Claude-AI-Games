/* Headless browser smoke test for Voxel Odyssey.
   - serves the project over http
   - loads index.html in Chromium (routing CDN fetches through the agent proxy)
   - starts a new world and verifies it renders without console/page errors
   - writes tests/screenshot.png for visual inspection

   Run: node tests/smoke.mjs
*/
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}/index.html`;

function findChromium() {
  const fs = require('fs');
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith('chromium-')) {
        const p = path.join(base, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. static server
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(800);

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const launchOpts = {
    headless: true,
    args: ['--ignore-certificate-errors', '--use-gl=swiftshader', '--enable-webgl', '--no-sandbox'],
  };
  const exe = findChromium();
  if (exe) launchOpts.executablePath = exe;
  if (proxy) launchOpts.proxy = { server: proxy, bypass: '127.0.0.1,localhost' };

  const errors = [];
  const warnings = [];
  let result = { ok: false };
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    page.on('console', (msg) => {
      const t = msg.type();
      const text = msg.text();
      if (t === 'error') errors.push(text);
      else if (t === 'warning') warnings.push(text);
    });
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + (err && err.message ? err.message : String(err))));

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

    // Wait for the game context + all systems to exist.
    await page.waitForFunction(() => {
      const g = window.GAME;
      return g && g.world && g.player && g.sky && g.hud && g.menus && g.entities && g.inventory;
    }, { timeout: 20000 });

    // Start a new world deterministically (skip the click→pointerlock gesture path).
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'smoke-test', gamemode: 'survival' }));

    // Let it generate + run for a few seconds.
    await sleep(5000);

    const probe = await page.evaluate(() => {
      const g = window.GAME;
      const meshes = g.scene.children.filter((c) => c.isMesh || c.isGroup).length;
      return {
        frame: g.engine.frame,
        fps: Math.round(g.engine.fps),
        sceneChildren: g.scene.children.length,
        meshish: meshes,
        playerY: g.player.position ? Math.round(g.player.position.y) : null,
        mode: g.mode,
        worldActive: g.worldActive,
        time: g.sky.timeOfDay,
        loadingHidden: document.getElementById('loading-screen').classList.contains('hidden'),
      };
    });

    await page.screenshot({ path: path.join(ROOT, 'tests', 'screenshot.png') });

    // brief second sample to confirm the loop is advancing
    const f1 = probe.frame;
    await sleep(700);
    const f2 = await page.evaluate(() => window.GAME.engine.frame);

    const benign = (e) => /pointer ?lock|user gesture|AudioContext|was prevented|permissions policy|favicon/i.test(e);
    const realErrors = errors.filter((e) => !benign(e));

    result = {
      ok: realErrors.length === 0 && probe.worldActive && f2 > f1 && probe.sceneChildren > 3,
      probe,
      loopAdvanced: f2 > f1,
      realErrors,
      benignErrorsCount: errors.length - realErrors.length,
      warningsCount: warnings.length,
      sampleWarnings: warnings.slice(0, 5),
    };
  } catch (err) {
    result = { ok: false, fatal: (err && err.stack) || String(err), errors };
  } finally {
    if (browser) await browser.close();
    server.kill('SIGKILL');
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
