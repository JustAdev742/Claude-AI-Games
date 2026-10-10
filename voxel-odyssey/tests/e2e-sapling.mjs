/* End-to-end sapling test with real mouse events: plant a sapling by
   right-clicking the ground, refuse to plant on sand, then let time pass and
   watch it become a tree that actually renders.

   Set E2E_SHOTS=<dir> to also write screenshots of the sapling and the tree. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8104;
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

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(800);
  const errors = [];
  const report = { ok: false };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromium() || undefined,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });
    const page = await (await browser.newContext({ viewport: { width: 1024, height: 640 } })).newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-sapling', gamemode: 'survival' }));
    await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 90000 });
    await sleep(800);

    // Stage: a flat patch of GRASS (so the soil check is real), with a sand strip to the side.
    await page.evaluate(() => {
      const g = window.GAME, ID = g.blocks.ID;
      const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
      const h = g.world.heightAt(px, pz);
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        g.world.setBlock(px + dx, h, pz + dz, dx > 3 ? ID.SAND : ID.GRASS, { cause: 'place', by: 'test' });
        for (let dy = 1; dy <= 12; dy++) g.world.setBlock(px + dx, h + dy, pz + dz, ID.AIR, { cause: 'break', by: 'test' });
      }
      g.player.position.set(px + 0.5, h + 1, pz + 0.5);
      g.player.velocity.set(0, 0, 0);
      g.state.flags.mode = 'play'; g.state.flags.paused = false; g.state.flags.inventoryOpen = false;
      g.inventory.reset();
      g.inventory.slots[0] = { id: 'sapling_oak', count: 3 };
      g.inventory.slots[1] = { id: 'sapling_pine', count: 1 };
      g.inventory.setSelected(0);
      window.__stage = { px, pz, h };
      // Aim at the floor. With `wantId`, search every heading for a floor block of that type.
      window.__aim = (yaw, wantId) => {
        const yaws = wantId === undefined ? [yaw] : Array.from({ length: 32 }, (_, i) => (i / 32) * Math.PI * 2);
        for (const y of yaws) for (const p of [0.9, -0.9, 0.6, -0.6]) {
          g.player.yaw = y; g.player.pitch = p;
          const e = g.player.getEyePosition();
          const r = g.world.raycast({ x: e.x, y: e.y, z: e.z }, g.player.getLookDir(), 5);
          if (r && r.block && r.place && (wantId === undefined || r.blockId === wantId)) return { block: { ...r.block }, place: { ...r.place }, id: r.blockId };
        }
        return null;
      };
    });
    await sleep(600);

    // ---- plant on grass with a real right-click --------------------------------
    const aimGrass = await page.evaluate(() => window.__aim(0));
    report.aimGrass = aimGrass;
    await page.mouse.move(512, 320);
    await page.mouse.click(512, 320, { button: 'right' });
    await sleep(300);
    report.planted = await page.evaluate((t) => ({
      block: window.GAME.world.getBlock(t.place.x, t.place.y, t.place.z), sapling: window.GAME.blocks.ID.SAPLING_OAK,
      left: window.GAME.inventory.slots[0] ? window.GAME.inventory.slots[0].count : 0,
      tracked: window.GAME.growth.saplings.size,
    }), aimGrass);

    // ---- refuse on sand --------------------------------------------------------
    const aimSand = await page.evaluate(() => {
      const s = window.__stage; const g = window.GAME;
      // stand next to the sand strip and aim down at it
      g.player.position.set(s.px + 4.5, s.h + 1, s.pz + 0.5);
      return window.__aim(0, g.blocks.ID.SAND);
    });
    report.aimSand = aimSand;
    await page.evaluate(() => window.GAME.inventory.setSelected(1));
    await page.mouse.click(512, 320, { button: 'right' });
    await sleep(300);
    report.onSand = await page.evaluate((t) => ({
      block: window.GAME.world.getBlock(t.place.x, t.place.y, t.place.z), air: window.GAME.blocks.ID.AIR,
      pineLeft: window.GAME.inventory.slots[1] ? window.GAME.inventory.slots[1].count : 0,
    }), aimSand);

    // ---- screenshot the sapling, then let it grow ---------------------------------
    await page.evaluate((t) => {
      const g = window.GAME;
      g.player.position.set(t.place.x + 0.5, t.place.y + 0.1, t.place.z + 3.5);
      g.player.yaw = 0; g.player.pitch = 0.05; g.inventory.setSelected(8);
    }, aimGrass);
    await sleep(500);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'sapling.png') });

    report.grew = await page.evaluate((t) => {
      const g = window.GAME;
      const events = [];
      g.events.on('tree:grown', (e) => events.push(e));
      for (let i = 0; i < 260; i++) g.growth.update(1);
      const logs = [];
      for (let y = t.place.y; y < t.place.y + 8; y++) logs.push(g.world.getBlock(t.place.x, y, t.place.z));
      return { logs, LOG: g.blocks.ID.LOG, events, below: g.world.getBlock(t.place.x, t.place.y - 1, t.place.z), DIRT: g.blocks.ID.DIRT };
    }, aimGrass);
    await sleep(2500);       // let the chunk remesh with the new tree
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'sapling-grown.png') });
    report.rendered = await page.evaluate((t) => {
      // The tree must exist in GPU geometry, not just in the voxel array: find a
      // log-textured vertex inside the trunk's column among the chunk meshes.
      const g = window.GAME; const layer = g.world.atlas.layerFor(g.blocks.ID.LOG, 0);
      let hits = 0;
      g.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.aTexIdx) return;
        const a = o.geometry.attributes, pos = a.position;
        for (let i = 0; i < a.aTexIdx.count; i++) {
          if (a.aTexIdx.getX(i) !== layer) continue;
          const wx = pos.getX(i) + o.position.x, wy = pos.getY(i) + o.position.y, wz = pos.getZ(i) + o.position.z;
          if (wx >= t.place.x - 0.01 && wx <= t.place.x + 1.01 && wz >= t.place.z - 0.01 && wz <= t.place.z + 1.01 && wy >= t.place.y && wy <= t.place.y + 4) hits++;
        }
      });
      return hits;
    }, aimGrass);

    report.errors = errors.slice(0, 8);
    const r = report;
    r.ok = !!(r.aimGrass && r.planted.block === r.planted.sapling && r.planted.left === 2 && r.planted.tracked === 1
      && r.aimSand && r.aimSand.id === 4 && r.onSand.block === r.onSand.air && r.onSand.pineLeft === 1
      && r.grew.logs.slice(0, 4).every((id) => id === r.grew.LOG) && r.grew.events.length === 1 && r.grew.events[0].kind === 'oak' && r.grew.below === r.grew.DIRT
      && r.rendered > 0 && errors.length === 0);
  } catch (e) {
    report.error = String(e && e.stack || e);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGKILL');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
main();
