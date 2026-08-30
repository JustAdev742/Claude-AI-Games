/* End-to-end controls test: unlike interact.mjs (which drives engine APIs),
   this drives REAL input events — page.mouse / KeyboardEvent — through the
   whole stack: DOM handler -> Input -> Player -> World. It exists because
   every historical "can't place / can't break" bug lived in the event layer,
   where API-level tests cannot see it.

   It runs the interaction checks TWICE:

     lock=real    pointer lock granted (a normal browser tab)
     lock=denied  requestPointerLock always rejects, so the game falls back to
                  virtual lock — this is the sandboxed-iframe case (the
                  published artifact), and it is the environment the
                  "clicking does nothing" reports came from. Breaking and
                  placing must work identically in both.

   Also covers, once: swimming out of a well onto a bank, hop height, and
   that the sun-direction shading uniform is driven by the sky.             */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8093;
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

/* Boot a fresh page with a world ready to interact with. */
async function openGame(browser, errors, denyLock) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.addInitScript(() => {
    window.__we = [];
    window.addEventListener('error', (e) => window.__we.push((e.error && e.error.stack) || e.message || `${e.filename}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => window.__we.push('REJECT: ' + ((e.reason && e.reason.stack) || e.reason)));
  });
  if (denyLock) {
    // Reproduce a sandboxed iframe without allow="pointer-lock": the API
    // exists but every request is refused.
    await page.addInitScript(() => {
      HTMLElement.prototype.requestPointerLock = function () {
        setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
        return Promise.reject(new Error('pointer lock denied (test)'));
      };
    });
  }
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
  await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-controls', gamemode: 'survival' }));
  await sleep(3500);
  return { ctx, page };
}

/* Flatten a patch of ground under the player and install an aim helper. */
async function buildStage(page) {
  await page.evaluate(() => {
    const g = window.GAME;
    const px = Math.floor(g.player.position.x), pz = Math.floor(g.player.position.z);
    const h = g.world.heightAt(px, pz);
    // Dirt, not stone: bare-hand dirt breaks in about a second, so the
    // button-hold below stays short.
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        g.world.setBlock(px + dx, h, pz + dz, g.blocks.ID.DIRT, { cause: 'place', by: 'test' });
        for (let dy = 1; dy <= 5; dy++) {
          g.world.setBlock(px + dx, h + dy, pz + dz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
        }
      }
    }
    g.player.position.set(px + 0.5, h + 1, pz + 0.5);
    g.player.velocity.set(0, 0, 0);
    g.player.yaw = 0; g.player.pitch = 0;
    g.state.flags.mode = 'play'; g.state.flags.paused = false; g.state.flags.inventoryOpen = false;

    // Sets yaw, then finds the pitch sign that actually points the look ray at
    // the floor. Written this way so the test can never quietly pass with a
    // sky-pointing ray, whatever the engine's pitch convention is.
    window.__aimAtFloor = (yaw) => {
      for (const p of [0.9, -0.9]) {
        g.player.yaw = yaw; g.player.pitch = p;
        const eye = g.player.getEyePosition();
        const dir = g.player.getLookDir();
        const r = g.world.raycast({ x: eye.x, y: eye.y, z: eye.z }, dir, 5);
        if (r && r.block) return r;
      }
      return null;
    };
    window.__stage = { px, pz, h };
  });
  await sleep(400);
}

/* The core of the test: real mouse events must break and place. */
async function interactionPhase(page) {
  // ---- mousedown registers + (re)takes capture --------------------------
  await page.mouse.move(512, 320);
  await page.mouse.down({ button: 'left' });
  await sleep(200);
  const clickState = await page.evaluate(() => ({
    leftHeld: window.GAME.input.buttons.has(0),
    locked: window.GAME.input.locked,
    realLock: document.pointerLockElement === window.GAME.renderer.domElement,
    virtualLock: window.GAME.input.virtualLock,
  }));
  await page.mouse.up({ button: 'left' });

  // ---- hold left to BREAK the aimed block -------------------------------
  const breakTarget = await page.evaluate(() => {
    const r = window.__aimAtFloor(0);
    return r ? { ...r.block, id: r.blockId } : null;
  });
  let broke = false;
  if (breakTarget) {
    await page.mouse.down({ button: 'left' });
    await sleep(2200);
    await page.mouse.up({ button: 'left' });
    broke = await page.evaluate((t) =>
      window.GAME.world.getBlock(t.x, t.y, t.z) !== t.id, breakTarget);
  }

  // ---- right click to PLACE the selected block --------------------------
  const placeInfo = await page.evaluate(() => {
    const g = window.GAME;
    g.inventory.add('cobblestone', 8);
    // Slots are { id, count } — NOT { item, count }.
    for (let i = 0; i < 9; i++) {
      const s = g.inventory.slots[i];
      if (s && s.id === 'cobblestone') { g.inventory.setSelected(i); break; }
    }
    // Face away from the freshly dug hole so the ray lands on intact floor.
    const r = window.__aimAtFloor(Math.PI / 2);
    const held = g.inventory.selectedItem();
    return {
      place: r && r.place ? { ...r.place } : null,
      held: held ? held.id : null,
      // Everything _placeBlock checks, so a failure names its own cause
      // instead of just reporting "didn't place".
      placeable: held ? g.items.isPlaceable(held.id) : false,
      blockId: held ? g.items.blockId(held.id) : null,
      targetId: r && r.place ? g.world.getBlock(r.place.x, r.place.y, r.place.z) : null,
      bodyOverlap: r && r.place ? g.player._aabbOverlapsCell(r.place.x, r.place.y, r.place.z) : null,
    };
  });
  let placed = false;
  if (placeInfo.place) {
    await page.mouse.down({ button: 'right' });
    await sleep(300);
    await page.mouse.up({ button: 'right' });
    placed = await page.evaluate((t) =>
      window.GAME.world.getBlock(t.x, t.y, t.z) === window.GAME.blocks.ID.COBBLESTONE, placeInfo.place);
  }

  return {
    ok: clickState.leftHeld && clickState.locked
      && !!breakTarget && broke && !!placeInfo.place && placed,
    clickState, breakTarget, broke, placeInfo, placed,
  };
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await sleep(800);
  const errors = [];
  let report = { ok: false };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromium() || undefined,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });

    // ================= phase A: normal tab (real pointer lock) ============
    const a = await openGame(browser, errors, /*denyLock*/ false);
    await buildStage(a.page);
    const realLockPhase = await interactionPhase(a.page);

    // ---- swimming out of a well ------------------------------------------
    // A 1x1 well: air at bank level, water BELOW it, solid banks all round,
    // so the water surface sits a full block under the bank top. This is the
    // "stuck in water, can't get onto blocks" situation exactly.
    await a.page.evaluate(() => {
      const g = window.GAME;
      const { px, pz, h } = window.__stage;
      const wx = px - 2, wz = pz - 2;   // untouched corner of the stage
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          g.world.setBlock(wx + dx, h, wz + dz, g.blocks.ID.DIRT, { cause: 'place', by: 'test' });
          for (let dy = 1; dy <= 4; dy++) {
            g.world.setBlock(wx + dx, h + dy, wz + dz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
          }
        }
      }
      g.world.setBlock(wx, h, wz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
      g.world.setBlock(wx, h - 1, wz, g.blocks.ID.WATER, { cause: 'place', by: 'test' });
      g.world.setBlock(wx, h - 2, wz, g.blocks.ID.WATER, { cause: 'place', by: 'test' });
      g.player.position.set(wx + 0.5, h - 1.5, wz + 0.5);
      g.player.velocity.set(0, 0, 0);
      g.player.pitch = 0;
      g.player.yaw = 0;          // forward = -Z: swims against the -Z bank
      window.__well = { wx, wz, h };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    });
    await sleep(3000);
    const swim = await a.page.evaluate(() => {
      const g = window.GAME;
      const { wx, wz, h } = window.__well;
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      const fx = Math.floor(g.player.position.x), fz = Math.floor(g.player.position.z);
      return {
        y: +g.player.position.y.toFixed(2),
        bankTop: h + 1,
        outOfWell: !(fx === wx && fz === wz),
        climbed: g.player.position.y >= h + 0.9,
      };
    });

    // ---- holding jump hops on land ---------------------------------------
    await a.page.evaluate(() => {
      const g = window.GAME;
      const { px, pz, h } = window.__stage;
      g.player.position.set(px + 0.5, h + 1, pz + 0.5);
      g.player.velocity.set(0, 0, 0);
      window.__maxVy = -99;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    });
    for (let i = 0; i < 12; i++) {
      await sleep(100);
      await a.page.evaluate(() => {
        window.__maxVy = Math.max(window.__maxVy, window.GAME.player.velocity.y);
      });
    }
    const hop = await a.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      return { maxVy: +window.__maxVy.toFixed(2) };
    });

    // ---- sun shading uniform is driven by the sky ------------------------
    await a.page.evaluate(() => window.GAME.sky.setTime(0.33)); // morning sun
    await sleep(300);
    const sun = await a.page.evaluate(() => {
      const g = window.GAME;
      const s = g.sky.getTerrainLight().sunDir;
      const u = g.world.uniforms && g.world.uniforms.uSunDir && g.world.uniforms.uSunDir.value;
      return {
        skyDir: s ? { x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3) } : null,
        uniform: u ? { x: +u.x.toFixed(3), y: +u.y.toFixed(3), z: +u.z.toFixed(3) } : null,
        // The sun must never point below the horizon: at night the term has
        // to follow the moon instead, or night faces shade backwards.
        wired: !!s && !!u && Math.abs(u.x - s.x) < 1e-3 && Math.abs(u.y - s.y) < 1e-3 && s.y >= 0,
      };
    });
    const midnightSun = await a.page.evaluate(() => {
      window.GAME.sky.setTime(0.0);
      const s = window.GAME.sky.getTerrainLight().sunDir;
      return { y: +s.y.toFixed(3), aboveHorizon: s.y >= 0 };
    });
    // ---- release key round trip ------------------------------------------
    // The force-lock makes every click re-capture the mouse, so a deliberate
    // release has to survive one — otherwise the player can never get the
    // cursor back — and clicking the game must still take capture back.
    await a.page.evaluate(() => {
      const g = window.GAME;
      g.state.flags.paused = false; g.state.flags.inventoryOpen = false;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', bubbles: true }));
    });
    await sleep(250);
    const afterRelease = await a.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyU', bubbles: true }));
      return { released: GAME.input.cursorReleased, locked: GAME.input.locked };
    });
    // A click somewhere that is NOT the canvas must not silently re-capture.
    await a.page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'e2e-probe';
      probe.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:60px;z-index:9999;pointer-events:auto';
      document.body.appendChild(probe);
    });
    await a.page.mouse.click(30, 30);
    await sleep(200);
    const afterOffCanvasClick = await a.page.evaluate(() => {
      const p = document.getElementById('e2e-probe');
      if (p) p.remove();
      return { released: GAME.input.cursorReleased, locked: GAME.input.locked };
    });
    // Clicking the game itself IS the request for capture.
    await a.page.mouse.click(512, 320);
    await sleep(250);
    const afterCanvasClick = await a.page.evaluate(() => ({
      released: GAME.input.cursorReleased, locked: GAME.input.locked,
    }));
    const releaseKey = {
      afterRelease, afterOffCanvasClick, afterCanvasClick,
      ok: afterRelease.released && !afterRelease.locked
        && afterOffCanvasClick.released && !afterOffCanvasClick.locked
        && !afterCanvasClick.released && afterCanvasClick.locked,
    };

    const winErrorsA = await a.page.evaluate(() => (window.__we || []).slice(0, 10));
    await a.ctx.close();

    // ================= phase B: pointer lock denied (iframe) ==============
    const b = await openGame(browser, errors, /*denyLock*/ true);
    await buildStage(b.page);
    const deniedLockPhase = await interactionPhase(b.page);
    const winErrorsB = await b.page.evaluate(() => (window.__we || []).slice(0, 10));
    await b.ctx.close();

    report = {
      ok: realLockPhase.ok && deniedLockPhase.ok
        && realLockPhase.clickState.realLock === true
        && deniedLockPhase.clickState.virtualLock === true
        && swim.climbed && swim.outOfWell
        && hop.maxVy > 5
        && releaseKey.ok
        && sun.wired && midnightSun.aboveHorizon
        && errors.length === 0 && winErrorsA.length === 0 && winErrorsB.length === 0,
      realLockPhase,
      deniedLockPhase,
      swim,
      hop,
      releaseKey,
      sun,
      midnightSun,
      consoleErrors: errors.slice(0, 10),
      winErrors: [...winErrorsA, ...winErrorsB],
    };
  } catch (err) {
    report = { ok: false, fatal: (err && err.stack) || String(err), errors };
  } finally {
    if (browser) await browser.close();
    server.kill('SIGKILL');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
main();
