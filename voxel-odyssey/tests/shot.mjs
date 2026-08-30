/* Grab a gameplay screenshot for eyeballing visual changes.
   Usage: node tests/shot.mjs [outfile] [timeOfDay] */
import { createRequire } from 'module';
import { spawn } from 'child_process';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/Claude-AI-Games/voxel-odyssey';
const PORT = 8094;
const OUT = process.argv[2] || '/tmp/shot.png';
const TOD = process.argv[3] !== undefined ? Number(process.argv[3]) : 0.32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChromium() {
  const b = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of fs.readdirSync(b)) if (d.startsWith('chromium-')) {
    const p = path.join(b, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return null;
}
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
await sleep(700);
let browser;
try {
  browser = await chromium.launch({
    headless: true, executablePath: findChromium() || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 620 } })).newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 25000 });
  await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'vista', gamemode: 'creative' }));
  await sleep(7000);
  await page.evaluate((tod) => {
    const g = window.GAME;
    g.state.flags.mode = 'play'; g.state.flags.paused = false;
    g.sky.setTime(tod);
    g.player.setGamemode('creative'); g.player.flying = true;
    // Rise above the terrain and look out over it: a horizon shot shows lit
    // and shadowed faces of the same blocks, which is what the sun term
    // changes.
    const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
    g.player.position.set(px + 0.5, g.world.heightAt(px, pz) + 14, pz + 0.5);
    g.player.velocity.set(0, 0, 0);
    g.player.yaw = 0.7;
    g.player.pitch = -0.28;    // positive pitch looks up, so this looks down
    g.state.flags.debug = false;
  }, TOD);
  await sleep(4500);
  await page.screenshot({ path: OUT });
  console.log('wrote', OUT);
} finally {
  if (browser) await browser.close();
  server.kill('SIGKILL');
}
