/* End-to-end chest test through real mouse/DOM events: right-click opens the
   chest, items move in by click and by shift-click (worn tools keep their
   wear), the contents survive closing and reopening, shift-click brings them
   back out, and breaking the chest clears it.

   Set E2E_SHOTS=<dir> to also write a screenshot of the chest screen. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8105;
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
      headless: true, executablePath: findChromium() || undefined,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });
    const page = await (await browser.newContext({ viewport: { width: 1024, height: 700 } })).newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-chest', gamemode: 'survival' }));
    await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 90000 });
    await sleep(800);

    const stage = await page.evaluate(() => {
      const g = window.GAME, ID = g.blocks.ID;
      const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
      const h = g.world.heightAt(px, pz);
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        g.world.setBlock(px + dx, h, pz + dz, ID.DIRT, { cause: 'place', by: 'test' });
        for (let dy = 1; dy <= 5; dy++) g.world.setBlock(px + dx, h + dy, pz + dz, ID.AIR, { cause: 'break', by: 'test' });
      }
      g.player.position.set(px + 0.5, h + 1, pz + 0.5);
      g.player.velocity.set(0, 0, 0);
      g.state.flags.mode = 'play'; g.state.flags.paused = false; g.state.flags.inventoryOpen = false;
      const c = { x: px, y: h + 1, z: pz + 2 };
      g.world.setBlock(c.x, c.y, c.z, ID.CHEST, { cause: 'place', by: 'test' });
      let aimed = false;
      outer:
      for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.1) for (let pitch = -0.6; pitch <= 0.6; pitch += 0.05) {
        g.player.yaw = yaw; g.player.pitch = pitch;
        const e = g.player.getEyePosition();
        const r = g.world.raycast({ x: e.x, y: e.y, z: e.z }, g.player.getLookDir(), 5);
        if (r && r.block && r.block.x === c.x && r.block.y === c.y && r.block.z === c.z) { aimed = true; break outer; }
      }
      g.inventory.reset();
      g.inventory.slots[9] = { id: 'cobblestone', count: 40 };
      g.inventory.slots[10] = { id: 'dirt', count: 5 };
      g.inventory.slots[11] = { id: 'stone_pickaxe', count: 1, wear: 30 };
      window.__c = c;
      return { aimed, c };
    });
    report.stage = stage;
    if (!stage.aimed) throw new Error('could not aim at the chest');

    await page.mouse.move(512, 350);
    await page.mouse.click(512, 350, { button: 'right' });
    await page.waitForFunction(() => window.GAME.menus.chestPos, null, { timeout: 4000 }).catch(() => {});
    report.opened = await page.evaluate(() => ({
      pos: window.GAME.menus.chestPos,
      title: (document.querySelector('#inventory-screen h1') || {}).textContent,
      chestSlots: document.querySelectorAll('#inventory-screen [data-kind="chest"]').length,
    }));

    const inv = (n) => `#inventory-screen [data-kind="inv"][data-slot="${n}"]`;
    const ch = (n) => `#inventory-screen [data-kind="chest"][data-slot="${n}"]`;
    const click = async (sel, opts) => { await page.click(sel, opts); await sleep(60); };
    await click(inv(9));                                   // pick up the cobblestone...
    await click(ch(0));                                    // ...and put it in the chest
    await click(inv(10), { modifiers: ['Shift'] });        // shift-click: dirt goes across
    await click(inv(11), { modifiers: ['Shift'] });        // ...and so does the worn pickaxe
    report.stored = await page.evaluate(() => {
      const st = window.GAME.chests.get(window.__c.x, window.__c.y, window.__c.z);
      return { slots: st.slots.map((s) => s && { ...s }).filter(Boolean), cursor: window.GAME.menus.cursor,
        invLeft: [9, 10, 11].map((i) => window.GAME.inventory.slots[i]) };
    });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'chest-screen.png') });

    // ---- close and reopen: it remembers ------------------------------------
    await page.evaluate(() => window.GAME.menus._closeInventory(false));
    await page.evaluate(() => window.GAME.menus.openChest(window.__c.x, window.__c.y, window.__c.z));
    await sleep(150);
    report.reopened = await page.evaluate(() => ({
      drawn: document.querySelector('#inventory-screen [data-kind="chest"][data-slot="0"]')._count.textContent,
      bar: (() => { const d = document.querySelector('#inventory-screen [data-kind="chest"][data-slot="2"]')._dur; return d ? d.style.display : null; })(),
    }));

    // ---- shift-click out ------------------------------------------------------
    await click(ch(0), { modifiers: ['Shift'] });
    await click(ch(2), { modifiers: ['Shift'] });
    report.retrieved = await page.evaluate(() => ({
      cobble: window.GAME.inventory.count('cobblestone'),
      pickaxe: window.GAME.inventory.slots.find((s) => s && s.id === 'stone_pickaxe'),
      chestHas: window.GAME.chests.get(window.__c.x, window.__c.y, window.__c.z).slots.filter(Boolean).map((s) => s.id),
    }));

    // ---- breaking it clears the state --------------------------------------------
    report.broken = await page.evaluate(() => {
      const g = window.GAME, c = window.__c;
      g.menus._closeInventory(false);
      g.chests.ensure(c.x, c.y, c.z).slots[3] = { id: 'coal', count: 2 };
      g.world.setBlock(c.x, c.y, c.z, g.blocks.ID.AIR, { cause: 'break', by: 'player' });
      return { state: g.chests.get(c.x, c.y, c.z) };
    });

    report.errors = errors.slice(0, 8);
    const r = report;
    r.ok = !!(r.opened.pos && r.opened.title === 'Chest' && r.opened.chestSlots === 27
      && r.stored.cursor === null
      && r.stored.slots.length === 3
      && r.stored.slots.some((s) => s.id === 'cobblestone' && s.count === 40)
      && r.stored.slots.some((s) => s.id === 'dirt' && s.count === 5)
      && r.stored.slots.some((s) => s.id === 'stone_pickaxe' && s.wear === 30)
      && r.stored.invLeft.every((s) => s === null)
      && r.reopened.drawn === '40' && r.reopened.bar === 'block'
      && r.retrieved.cobble === 40 && r.retrieved.pickaxe && r.retrieved.pickaxe.wear === 30
      && r.retrieved.chestHas.length === 1 && r.retrieved.chestHas[0] === 'dirt'
      && r.broken.state === null && errors.length === 0);
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
