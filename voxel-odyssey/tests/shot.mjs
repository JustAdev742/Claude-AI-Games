/* Grab a gameplay screenshot for eyeballing visual changes.
   Usage: node tests/shot.mjs [outfile] [timeOfDay] [spec-json]
   spec: { biome: 'desert'|'jungle'|..., seed, view: 'vista'|'ground'|'tree'|'water'|'underwater', yaw, pitch, dist, log: 'pine'|'birch',
           give: [item ids], hold: hotbar index, mobs: ['pig', ...], torches: [[right,forward],...], blocks: [[right,forward,'chest'],...], weather: 'rain', wait: ms }
   'vista'  hover above the spawn and look down over the terrain (default)
   'ground' stand on the surface at spawn, looking at the horizon
   'tree'   stand a few blocks from the nearest log, looking at its crown
   'water'  stand on the shoreline nearest spawn, looking over open water
   'underwater' sink just below the surface */
import { createRequire } from 'module';
import { spawn } from 'child_process';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8094;
const OUT = process.argv[2] || '/tmp/shot.png';
const TOD = process.argv[3] !== undefined ? Number(process.argv[3]) : 0.32;
const SPEC = Object.assign({ seed: 'vista', view: 'vista' }, process.argv[4] ? JSON.parse(process.argv[4]) : {});
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
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 25000 });
  await page.evaluate((s) => window.GAME.events.emit('game:new', { seed: s, gamemode: 'creative' }), SPEC.seed);
  await sleep(7000);
  const info = await page.evaluate(({ tod, spec }) => {
    const g = window.GAME;
    g.state.flags.mode = 'play'; g.state.flags.paused = false;
    g.sky.setTime(tod);
    g.player.setGamemode('creative');
    const w = g.world, B = g.blocks.ID;
    const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
    let yaw = spec.yaw ?? 0.7, pitch = spec.pitch ?? -0.28, note = '';
    let x = px + 0.5, z = pz + 0.5, y = w.heightAt(px, pz) + 14, flying = true;
    const want = spec.log === 'pine' ? [B.PINE_LOG] : spec.log === 'birch' ? [B.BIRCH_LOG] : [B.LOG, B.BIRCH_LOG, B.PINE_LOG];
    const isLog = (id) => want.includes(id);
    if (spec.biome || spec.climate) {
      // Teleport to the nearest column of a named biome (or one inside a
      // climate box {tMin,tMax,mMin,mMax}) and stand on it.
      const cl = spec.climate;
      const want = (bx, bz) => {
        if (g.worldgen.heightAt(bx, bz) <= 30) return false;
        if (spec.biome && g.worldgen.biomeAt(bx, bz) !== spec.biome) return false;
        if (cl) {
          const c = g.worldgen.columnInfo(bx, bz);
          if (c.temperature < (cl.tMin ?? 0) || c.temperature > (cl.tMax ?? 1) || c.moisture < (cl.mMin ?? 0) || c.moisture > (cl.mMax ?? 1)) return false;
        }
        return true;
      };
      let found = null;
      for (let r = 0; r <= 900 && !found; r += 10) {
        const steps = Math.max(1, Math.round(r / 5));
        for (let a = 0; a < steps && !found; a++) {
          const ang = (a / steps) * Math.PI * 2;
          const bx = px + Math.round(Math.cos(ang) * r), bz = pz + Math.round(Math.sin(ang) * r);
          if (want(bx, bz)) found = { bx, bz };
        }
      }
      if (found) {
        // Chunks around the target are not loaded yet: aim the player there and let streaming catch up.
        x = found.bx + 0.5; z = found.bz + 0.5;
        y = g.worldgen.heightAt(found.bx, found.bz) + (spec.view === 'ground' ? 1.01 : 12);
        flying = spec.view !== 'ground';
        note = `${spec.biome || 'climate'} at ${found.bx},${found.bz}`;
      } else note = `no ${spec.biome || 'climate'} match within 900`;
    } else if (spec.view === 'ground') {
      y = w.heightAt(px, pz) + 1.01; flying = false; pitch = spec.pitch ?? 0.05;
    } else if (spec.view === 'tree') {
      let best = null;
      for (let dx = -60; dx <= 60 && !best; dx++) for (let dz = -60; dz <= 60; dz++) {
        const h = w.heightAt(px + dx, pz + dz);
        // heightAt may report the canopy, so look for a trunk anywhere in the
        // few blocks below the reported top as well as just above it.
        let hit = false;
        for (let yy = h + 1; yy >= h - 7 && !hit; yy--) hit = isLog(w.getBlock(px + dx, yy, pz + dz));
        if (hit && (!best || dx * dx + dz * dz < best.d)) best = { dx, dz, h, d: dx * dx + dz * dz };
      }
      if (best) {
        const d = spec.dist ?? 7, tx = px + best.dx, tz = pz + best.dz;
        x = tx + 0.5 - Math.sin(yaw) * d; z = tz + 0.5 - Math.cos(yaw) * d;
        y = w.heightAt(Math.floor(x), Math.floor(z)) + 2.6; flying = true; pitch = spec.pitch ?? 0.12;
        note = `tree at ${tx},${tz}`;
      } else note = 'no tree found';
    } else if (spec.view === 'underwater') {
      // Open water near spawn with a clear column of at least 4 blocks (no ravine
      // walls): hang 1.2 blocks under the surface.
      let best = null;
      for (let dx = -90; dx <= 90; dx++) for (let dz = -90; dz <= 90; dz++) {
        const d = dx * dx + dz * dz;
        if (best && d >= best.d) continue;
        let deep = true;
        for (let k = -2; k <= 2 && deep; k++) for (let m = -2; m <= 2 && deep; m++) deep = w.heightAt(px + dx + k * 2, pz + dz + m * 2) >= 18 && w.heightAt(px + dx + k * 2, pz + dz + m * 2) <= 24;
        if (deep) best = { dx, dz, d };
      }
      if (best) {
        x = px + best.dx + 0.5; z = px * 0 + pz + best.dz + 0.5; y = 26.6; flying = true;
        yaw = spec.yaw ?? 0.7; pitch = spec.pitch ?? 0.2;
        note = `underwater at ${px + best.dx},${pz + best.dz}`;
      } else note = 'no deep water found';
    } else if (spec.view === 'water') {
      let best = null;
      for (let dx = -70; dx <= 70; dx++) for (let dz = -70; dz <= 70; dz++) {
        const h = w.heightAt(px + dx, pz + dz);
        if (h >= 28 && w.getBlock(px + dx + 1, 28, pz + dz) === B.WATER && (!best || dx * dx + dz * dz < best.d)) best = { dx, dz, h, d: dx * dx + dz * dz };
      }
      if (best) {
        x = px + best.dx + 0.5; z = pz + best.dz + 0.5; y = best.h + 1.01; flying = false;
        yaw = spec.yaw ?? -Math.PI / 2; pitch = spec.pitch ?? -0.08;
        note = `shore at ${px + best.dx},${px + best.dz}`;
      } else note = 'no shore found';
    }
    // Optionally hold something: spec.give = ['iron_sword', ...] fills slots
    // from 5 upward, spec.hold = hotbar index to select.
    (spec.give || []).forEach((id, i) => { g.inventory.slots[5 + i] = { id, count: 1 }; });
    if (spec.hold !== undefined) {
      g.inventory.selected = spec.hold;
      g.events.emit('hotbar:select', { index: spec.hold, item: g.inventory.selectedItem() });
    }
    // spec.mobs = ['pig', 'zombie', ...]: line them up in front of the camera.
    (spec.mobs || []).forEach((type, i) => {
      const d = 4 + i * 2.2, sx = x - Math.sin(yaw) * d + Math.cos(yaw) * (i % 2 ? 1.8 : -1.8), sz = z - Math.cos(yaw) * d - Math.sin(yaw) * (i % 2 ? 1.8 : -1.8);
      const gy = w.heightAt(Math.floor(sx), Math.floor(sz)) + 1;
      g.entities.spawn(type, sx, gy, sz);
    });
    // spec.torches = [[dx, dz], ...]: torches on the ground near the camera; spec.weather = 'rain' | 'snow'.
    // Offsets are (right, forward) relative to the view direction.
    (spec.torches || []).forEach(([right, fwd]) => {
      const tx = Math.floor(x - Math.sin(yaw) * fwd + Math.cos(yaw) * right), tz = Math.floor(z - Math.cos(yaw) * fwd - Math.sin(yaw) * right);
      g.world.setBlock(tx, w.heightAt(tx, tz) + 1, tz, B.TORCH, { cause: 'place', by: 'test' });
    });
    // spec.blocks = [[right, forward, 'chest'], ...]: place named blocks on the ground ahead.
    (spec.blocks || []).forEach(([right, fwd, key]) => {
      const bx = Math.floor(x - Math.sin(yaw) * fwd + Math.cos(yaw) * right), bz = Math.floor(z - Math.cos(yaw) * fwd - Math.sin(yaw) * right);
      g.world.setBlock(bx, w.heightAt(bx, bz) + 1, bz, g.blocks.byKey(key).id, { cause: 'place', by: 'test' });
    });
    if (spec.weather) g.weather.setWeather(spec.weather, 1);
    g.player.flying = flying;
    g.player.position.set(x, y, z);
    g.player.velocity.set(0, 0, 0);
    g.player.yaw = yaw; g.player.pitch = pitch;
    g.state.flags.debug = false;
    return note;
  }, { tod: TOD, spec: SPEC });
  if (info) console.log(info);
  await sleep(SPEC.wait ?? ((SPEC.biome || SPEC.climate) ? 9000 : 4500));
  await page.screenshot({ path: OUT });
  console.log('wrote', OUT);
} finally {
  if (browser) await browser.close();
  server.kill('SIGKILL');
}
