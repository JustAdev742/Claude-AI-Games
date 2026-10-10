/* End-to-end touch-controls test on an emulated phone (touch events only —
   no mouse, no keyboard). Drives the whole stack: DOM pointer events ->
   TouchControls -> Input -> Player/World.

   Set E2E_SHOTS=<dir> to also write a screenshot of the touch HUD. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8099;
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
    const ctx = await browser.newContext({
      viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    const cdp = await ctx.newCDPSession(page);

    // Raw touch helpers. Each finger has a stable id so several can be down at once.
    const fingers = new Map();
    const send = (type) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: [...fingers.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })),
    });
    const down = async (id, x, y) => { fingers.set(id, { x, y }); await send('touchStart'); };
    const move = async (id, x, y) => { fingers.set(id, { x, y }); await send('touchMove'); };
    // Lifting a finger: CDP ends every point it is given, so end this one
    // alone and re-assert the rest of the fingers as still down.
    const up = async (id) => {
      const p = fingers.get(id);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id, x: p.x, y: p.y }] });
      fingers.delete(id);
      return p;
    };
    const centre = async (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const tap = async (sel, ms = 90) => { const c = await centre(sel); await down(9, c.x, c.y); await sleep(ms); await up(9); };

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-touch', gamemode: 'survival' }));
    // The loading screen swallows touches until the first chunks are meshed.
    await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 90000 });
    await sleep(800);

    await page.evaluate(() => {
      const g = window.GAME, ID = g.blocks.ID;
      const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
      const h = g.world.heightAt(px, pz);
      for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
        g.world.setBlock(px + dx, h, pz + dz, ID.DIRT, { cause: 'place', by: 'test' });
        for (let dy = 1; dy <= 6; dy++) g.world.setBlock(px + dx, h + dy, pz + dz, ID.AIR, { cause: 'break', by: 'test' });
      }
      g.player.position.set(px + 0.5, h + 1, pz + 0.5);
      g.player.velocity.set(0, 0, 0);
      g.player.yaw = 0; g.player.pitch = 0;
      g.state.flags.mode = 'play'; g.state.flags.paused = false; g.state.flags.inventoryOpen = false;
      g.inventory.reset();
      g.inventory.slots[0] = { id: 'cobblestone', count: 16 };
      g.inventory.slots[1] = { id: 'dirt', count: 8 };
      g.inventory.slots[2] = { id: 'stone_pickaxe', count: 1 };
      g.inventory.setSelected(0);
      window.__aimAtFloor = (yaw) => {
        for (const p of [0.9, -0.9]) {
          g.player.yaw = yaw; g.player.pitch = p;
          const e = g.player.getEyePosition();
          const r = g.world.raycast({ x: e.x, y: e.y, z: e.z }, g.player.getLookDir(), 5);
          if (r && r.block) return r;
        }
        return null;
      };
      window.__stage = { px, pz, h };
    });
    await sleep(500);

    // ---- the controls exist and are showing -------------------------------
    report.ui = await page.evaluate(() => ({
      bodyTouch: document.body.classList.contains('touch'),
      shown: getComputedStyle(document.getElementById('touch-controls')).display,
      active: window.GAME.input.touch.active,
      ids: ['touch-stick', 'touch-break', 'touch-place', 'touch-jump', 'touch-sneak', 'touch-inv', 'touch-pause', 'touch-look']
        .filter((id) => !document.getElementById(id)),
    }));
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'touch-hud.png') });

    // ---- stick: push forward, the player walks ------------------------------
    const p0 = await page.evaluate(() => ({ ...window.GAME.player.position }));
    const stick = await centre('#touch-stick');
    await down(1, stick.x, stick.y);
    await move(1, stick.x, stick.y - 46);
    await sleep(900);
    report.stickState = await page.evaluate(() => ({ ...window.GAME.input.touch, held: [...window.GAME.input.touch.held] }));
    await up(1);
    const p1 = await page.evaluate(() => ({ ...window.GAME.player.position }));
    await sleep(150);
    report.walked = { dist: Math.hypot(p1.x - p0.x, p1.z - p0.z) };
    report.stickReleased = await page.evaluate(() => ({ x: window.GAME.input.touch.moveX, y: window.GAME.input.touch.moveY }));

    // ---- drag to look --------------------------------------------------------
    const yaw0 = await page.evaluate(() => window.GAME.player.yaw);
    const pitch0 = await page.evaluate(() => window.GAME.player.pitch);
    await down(2, 520, 120);
    for (let i = 1; i <= 8; i++) { await move(2, 520 + i * 12, 120 + i * 6); await sleep(16); }
    await up(2);
    await sleep(80);
    const look = await page.evaluate(() => ({ yaw: window.GAME.player.yaw, pitch: window.GAME.player.pitch }));
    report.look = { dyaw: look.yaw - yaw0, dpitch: look.pitch - pitch0 };

    // ---- two fingers at once: walk and look together ---------------------------
    const q0 = await page.evaluate(() => ({ ...window.GAME.player.position, yaw: window.GAME.player.yaw }));
    await down(1, stick.x, stick.y);
    await move(1, stick.x, stick.y - 46);
    await down(2, 520, 150);
    for (let i = 1; i <= 8; i++) { await move(2, 520 + i * 10, 150); await sleep(30); }
    await up(2); await up(1);
    const q1 = await page.evaluate(() => ({ ...window.GAME.player.position, yaw: window.GAME.player.yaw }));
    report.multitouch = { moved: Math.hypot(q1.x - q0.x, q1.z - q0.z), turned: Math.abs(q1.yaw - q0.yaw) };

    // ---- jump button ---------------------------------------------------------
    await page.evaluate(() => { const p = window.GAME.player; p.velocity.set(0, 0, 0); });
    await sleep(300);
    const jc = await centre('#touch-jump');
    await down(3, jc.x, jc.y);
    await sleep(120);
    report.jump = await page.evaluate(() => ({ vy: window.GAME.player.velocity.y, held: window.GAME.input.touch.held.has('jump') }));
    await up(3);
    report.jumpReleased = await page.evaluate(() => !window.GAME.input.touch.held.has('jump'));
    await sleep(700);

    // ---- hotbar tap ------------------------------------------------------------
    await tap('#hotbar .slot:nth-child(3)');
    report.hotbar = await page.evaluate(() => window.GAME.inventory.selected);
    await tap('#hotbar .slot:nth-child(1)');

    // ---- mine with the button (hold), place with the button (tap) --------------
    const target = await page.evaluate(() => {
      const r = window.__aimAtFloor(0);
      return r ? { ...r.block, id: r.blockId } : null;
    });
    report.target = target;
    // Mining dirt barehanded takes ~1s; select the pickaxe slot for the wear check too.
    await page.evaluate(() => window.GAME.inventory.setSelected(2));
    const bc = await centre('#touch-break');
    await down(4, bc.x, bc.y);
    await sleep(2200);
    await up(4);
    report.broke = target ? await page.evaluate((t) => window.GAME.world.getBlock(t.x, t.y, t.z) !== t.id, target) : false;
    report.toolWorn = await page.evaluate(() => (window.GAME.inventory.slots[2] || {}).wear || 0);

    await page.evaluate(() => window.GAME.inventory.setSelected(0));
    const place = await page.evaluate(() => {
      const r = window.__aimAtFloor(Math.PI / 2);
      return r && r.place ? { ...r.place } : null;
    });
    report.placeTarget = place;
    if (place) {
      await tap('#touch-place', 120);
      await sleep(150);
      report.placed = await page.evaluate((t) => window.GAME.world.getBlock(t.x, t.y, t.z) === window.GAME.blocks.ID.COBBLESTONE, place);
    }

    // ---- menus hide the controls; closing brings them back ----------------------
    await tap('#touch-inv');
    await sleep(200);
    report.inventory = await page.evaluate(() => ({
      open: window.GAME.menus.invOpen, controls: getComputedStyle(document.getElementById('touch-controls')).display,
      active: window.GAME.input.touch.active,
    }));
    await page.evaluate(() => window.GAME.menus._closeInventory(false));
    await sleep(200);
    report.afterInventory = await page.evaluate(() => ({
      controls: getComputedStyle(document.getElementById('touch-controls')).display, active: window.GAME.input.touch.active,
    }));

    await tap('#touch-pause');
    await sleep(250);
    report.pause = await page.evaluate(() => ({
      paused: window.GAME.state.flags.paused, controls: getComputedStyle(document.getElementById('touch-controls')).display,
    }));

    report.errors = errors.slice(0, 8);
    const r = report;
    r.ok = !!(r.ui.bodyTouch && r.ui.shown === 'block' && r.ui.active && r.ui.ids.length === 0
      && r.stickState.moveY < -0.5 && r.walked.dist > 1.2
      && r.stickReleased.x === 0 && r.stickReleased.y === 0
      && Math.abs(r.look.dyaw) > 0.08 && Math.abs(r.look.dpitch) > 0.02
      && r.multitouch.moved > 0.8 && r.multitouch.turned > 0.05
      && r.jump.held && r.jump.vy > 2 && r.jumpReleased
      && r.hotbar === 2
      && r.target && r.broke && r.toolWorn >= 1
      && r.placeTarget && r.placed
      && r.inventory.open && r.inventory.controls === 'none' && !r.inventory.active
      && r.afterInventory.controls === 'block' && r.afterInventory.active
      && r.pause.paused && r.pause.controls === 'none'
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
