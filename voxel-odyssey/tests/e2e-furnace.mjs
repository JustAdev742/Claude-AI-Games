/* End-to-end furnace + durability test, driven through real DOM/mouse events:
   right-click a furnace -> the smelting screen opens -> move ore and fuel in
   with clicks -> take the ingots out -> the block lit up while it burned; then
   a worn tool shows a durability bar and breaks the block it was used on, and
   breaking the furnace clears its state.

   Set E2E_SHOTS=<dir> to also write screenshots of the furnace screen. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8098;
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
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-furnace', gamemode: 'survival' }));
    await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 120000 });
    await sleep(800);

    // ---- stage: flat dirt, a furnace two blocks ahead ----------------------
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
      const f = { x: px + 0, y: h + 1, z: pz + 2 };
      g.world.setBlock(f.x, f.y, f.z, ID.FURNACE, { cause: 'place', by: 'test' });
      // Find a view that puts the crosshair on the furnace, whatever the
      // engine's yaw/pitch sign conventions are.
      let aimed = false;
      outer:
      for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.1) {
        for (let pitch = -0.6; pitch <= 0.6; pitch += 0.05) {
          g.player.yaw = yaw; g.player.pitch = pitch;
          const eye = g.player.getEyePosition();
          const r = g.world.raycast({ x: eye.x, y: eye.y, z: eye.z }, g.player.getLookDir(), 5);
          if (r && r.block && r.block.x === f.x && r.block.y === f.y && r.block.z === f.z) { aimed = true; break outer; }
        }
      }
      // Stock the inventory: ore + fuel in the main grid, a pickaxe in the hand.
      g.inventory.reset();
      g.inventory.slots[9] = { id: 'raw_iron', count: 3 };
      g.inventory.slots[10] = { id: 'coal', count: 2 };
      g.inventory.slots[0] = { id: 'stone_pickaxe', count: 1 };
      g.inventory.setSelected(0);
      window.__f = f;
      return { aimed, f, h };
    });
    report.stage = stage;
    if (!stage.aimed) throw new Error('could not aim at the furnace');

    // ---- real right click opens the smelting screen -------------------------
    await page.mouse.move(512, 350);
    await page.mouse.click(512, 350, { button: 'right' });
    await page.waitForFunction(() => window.GAME.menus.furnacePos, null, { timeout: 4000 }).catch(() => {});
    report.opened = await page.evaluate(() => ({
      pos: window.GAME.menus.furnacePos, inventoryOpen: window.GAME.state.flags.inventoryOpen,
      title: (document.querySelector('#inventory-screen h1') || {}).textContent,
      hasPanel: !!document.querySelector('#inventory-screen [data-kind="furnace-input"]'),
    }));

    const click = async (sel) => { await page.click(sel); await sleep(60); };
    const slot = (n) => `#inventory-screen [data-kind="inv"][data-slot="${n}"]`;
    await click(slot(9));                                       // pick up the ore
    await click('#inventory-screen [data-kind="furnace-input"]');
    await click(slot(10));                                      // pick up the coal
    await click('#inventory-screen [data-kind="furnace-fuel"]');
    // A non-fuel item must be refused by the fuel slot.
    await page.evaluate(() => { window.GAME.inventory.slots[11] = { id: 'dirt', count: 4 }; window.GAME.events.emit('inventory:change', {}); });
    await click(slot(11));
    await click('#inventory-screen [data-kind="furnace-fuel"]');
    report.afterLoad = await page.evaluate(() => {
      const st = window.GAME.furnaces.get(window.__f.x, window.__f.y, window.__f.z);
      return { input: st.input, fuel: st.fuel, cursor: window.GAME.menus.cursor };
    });
    // Put the dirt back so the cursor is free.
    await click(slot(11));

    // Let it burn: fast-forward the simulation (real frames also tick it).
    report.lit = await page.evaluate(() => {
      const g = window.GAME, f = window.__f;
      g.furnaces.update(0.2);
      return g.world.getBlock(f.x, f.y, f.z) === g.blocks.ID.FURNACE_LIT;
    });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'furnace-screen.png') });
    await page.evaluate(() => { for (let i = 0; i < 340; i++) window.GAME.furnaces.update(0.1); });
    await sleep(150);
    report.afterBurn = await page.evaluate(() => {
      const g = window.GAME, f = window.__f;
      const st = g.furnaces.get(f.x, f.y, f.z);
      const outEl = document.querySelector('#inventory-screen [data-kind="furnace-output"]');
      return {
        output: st.output, input: st.input, burn: Math.round(st.burn),
        outputDrawn: outEl ? outEl._count.textContent : null,
        block: g.world.getBlock(f.x, f.y, f.z), lit: g.blocks.ID.FURNACE_LIT, unlit: g.blocks.ID.FURNACE,
      };
    });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'furnace-done.png') });

    report.afterDark = await page.evaluate(() => {
      const g = window.GAME, f = window.__f;
      for (let i = 0; i < 600; i++) g.furnaces.update(0.1);
      return { block: g.world.getBlock(f.x, f.y, f.z), unlit: g.blocks.ID.FURNACE };
    });
    await click('#inventory-screen [data-kind="furnace-output"]');
    await click(slot(12));
    report.collected = await page.evaluate(() => ({
      ingots: window.GAME.inventory.count('iron_ingot'), cursor: window.GAME.menus.cursor,
    }));

    // ---- close, then wear a tool by really mining with it -------------------
    await page.evaluate(() => window.GAME.menus._closeInventory(false));
    await page.evaluate(() => { window.GAME.state.flags.inventoryOpen = false; window.GAME.state.flags.paused = false; });
    const target = await page.evaluate(() => {
      const g = window.GAME;
      for (const p of [0.9, -0.9]) {
        g.player.yaw = 0; g.player.pitch = p;
        const e = g.player.getEyePosition();
        const r = g.world.raycast({ x: e.x, y: e.y, z: e.z }, g.player.getLookDir(), 5);
        if (r && r.block && r.block.y < window.__f.y) return { ...r.block, id: r.blockId };
      }
      return null;
    });
    report.target = target;
    await page.mouse.move(512, 350);
    await page.mouse.down({ button: 'left' });
    await sleep(2200);
    await page.mouse.up({ button: 'left' });
    report.worn = await page.evaluate(() => {
      const s = window.GAME.inventory.slots[0];
      const bar = document.querySelector('#hotbar .slot .dur');
      const fill = bar && bar.firstChild;
      return { wear: s ? s.wear : null, barShown: bar ? bar.style.display : null, barWidth: fill ? fill.style.width : null };
    });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'worn-tool.png') });

    // A tool at its last use breaks, announces it, and leaves the slot empty.
    report.broke = await page.evaluate(() => {
      const g = window.GAME, inv = g.inventory;
      let event = null;
      g.events.on('tool:break', (e) => { event = e; });
      inv.slots[0] = { id: 'stone_pickaxe', count: 1, wear: g.items.durability('stone_pickaxe') - 1 };
      g.player._wearHeldTool(1);
      return { slot: inv.slots[0], event };
    });

    // ---- breaking the furnace clears its state ------------------------------
    report.breakFurnace = await page.evaluate(() => {
      const g = window.GAME, f = window.__f;
      const st = g.furnaces.ensure(f.x, f.y, f.z);
      st.fuel = { id: 'coal', count: 1 };
      g.world.setBlock(f.x, f.y, f.z, g.blocks.ID.AIR, { cause: 'break', by: 'player' });
      return { state: g.furnaces.get(f.x, f.y, f.z) };
    });
    // ---- the lit variant renders (texture layer exists) ---------------------
    report.litTexture = await page.evaluate(() => {
      const at = window.GAME.world.atlas;
      return at.layerFor(window.GAME.blocks.ID.FURNACE_LIT, 0) >= 0
        && at.layerFor(window.GAME.blocks.ID.FURNACE_LIT, 0) !== at.layerFor(window.GAME.blocks.ID.FURNACE, 0);
    });

    report.errors = errors.slice(0, 8);
    const r = report;
    r.ok = !!(r.opened.pos && r.opened.title === 'Furnace' && r.opened.hasPanel
      && r.afterLoad.input && r.afterLoad.input.id === 'raw_iron' && r.afterLoad.input.count === 3
      // The furnace is live: with ore in, it lights a piece of coal at once
      // (2 -> 1). The dirt offered to the fuel slot is refused and stays held.
      && r.afterLoad.fuel && r.afterLoad.fuel.id === 'coal' && r.afterLoad.fuel.count === 1
      && r.afterLoad.cursor && r.afterLoad.cursor.id === 'dirt'
      && r.lit
      && r.afterBurn.output && r.afterBurn.output.id === 'iron_ingot' && r.afterBurn.output.count === 3
      && r.afterBurn.outputDrawn === '3'
      // Three ingots take 30s of an 80s coal: still burning, so still lit...
      && r.afterBurn.burn > 0 && r.afterBurn.block === r.afterBurn.lit
      // ...and it goes dark once the fire is out.
      && r.afterDark.block === r.afterDark.unlit
      && r.collected.ingots === 3 && r.collected.cursor === null
      && r.target && r.worn.wear >= 1 && r.worn.barShown === 'block'
      && r.broke.slot === null && r.broke.event && r.broke.event.id === 'stone_pickaxe'
      && r.breakFurnace.state === null && r.litTexture
      && errors.length === 0);
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
