/* Deeper headless interaction test: drives the game's systems through real
   operations (block edits, raycast, inventory, crafting, mobs, particles,
   audio, day/night, player movement) and reports any thrown errors. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8092;
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
  let report = { ok: false };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromium() || undefined,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.addInitScript(() => {
      window.__we = [];
      window.addEventListener('error', (e) => window.__we.push((e.error && e.error.stack) || e.message || `${e.filename}:${e.lineno}`));
      window.addEventListener('unhandledrejection', (e) => window.__we.push('REJECT: ' + ((e.reason && e.reason.stack) || e.reason)));
    });

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 20000 });
    await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'interact', gamemode: 'survival' }));
    await sleep(3500); // let spawn ring stream

    // ---- API-level operations ----
    const ops = await page.evaluate(async () => {
      const g = window.GAME;
      const out = [];
      const T = (name, fn) => { try { const r = fn(); out.push({ op: name, ok: true, info: r }); } catch (e) { out.push({ op: name, ok: false, err: e.message }); } };

      T('audio.resume', () => { g.audio.resume(); return 'ok'; });
      T('audio.play break', () => { g.audio.play('break'); g.audio.play('step', { surface: 'grass' }); g.audio.play('hurt'); return 'ok'; });

      T('sky night', () => { g.sky.setTime(0.0); return { phase: g.sky.getPhase(), light: +g.sky.getLightLevel().toFixed(2) }; });
      T('sky day', () => { g.sky.setTime(0.5); return { phase: g.sky.getPhase(), light: +g.sky.getLightLevel().toFixed(2) }; });

      const px = Math.round(g.player.position.x), pz = Math.round(g.player.position.z);
      T('world.heightAt', () => g.world.heightAt(px, pz));
      T('world.setBlock+getBlock', () => {
        const y = g.world.heightAt(px, pz) + 2;
        g.world.setBlock(px, y, pz, g.blocks.ID.GLOWSTONE, { cause: 'place', by: 'test' });
        const got = g.world.getBlock(px, y, pz);
        g.world.setBlock(px, y, pz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
        return { placed: got, isGlow: got === g.blocks.ID.GLOWSTONE };
      });
      T('world.raycast down', () => {
        const eye = g.player.getEyePosition();
        const r = g.world.raycast({ x: eye.x, y: eye.y, z: eye.z }, { x: 0, y: -1, z: 0 }, 12);
        return r ? { hit: true, block: r.block, blockId: r.blockId } : { hit: false };
      });

      T('inventory.add/count', () => {
        g.inventory.add('diamond', 5);
        const c = g.inventory.count('diamond');
        return { count: c };
      });
      T('hotbar select', () => { g.inventory.setSelected(3); g.inventory.scrollSelected(1); return g.inventory.selected; });

      T('crafting.match planks', () => {
        const grid = [null, null, null, null, 'log', null, null, null, null];
        const m = g.crafting.match(grid);
        return m ? m.output : null;
      });
      T('crafting.list', () => g.crafting.list().length);

      T('entities.spawn mob', () => {
        const p = g.player.position;
        const m = g.entities.spawn('zombie', p.x + 3, g.world.heightAt(Math.round(p.x + 3), Math.round(p.z)) + 1, p.z);
        return { spawned: !!m, count: g.entities.entities.length };
      });
      T('entities.dropItem', () => {
        const p = g.player.position;
        const e = g.entities.dropItem(p.x + 1, p.y + 1, p.z, 'diamond', 1);
        return { dropped: !!e, items: g.entities.items.length };
      });

      T('particles burst', () => { g.particles.blockBreak(px, g.world.heightAt(px, pz), pz, g.blocks.ID.STONE); g.events.emit('block:break', { x: px, y: 30, z: pz, blockId: 1 }); return 'ok'; });

      T('player.hurt/heal', () => {
        const h0 = g.player.health;
        g.player.hurt(6, 'test');
        const h1 = g.player.health;
        g.player.heal(3);
        const h2 = g.player.health;
        return { h0, h1, h2 };
      });

      T('menus inventory open', () => { g.menus.toggleInventory(); return { open: g.state.flags.inventoryOpen, isOpen: g.menus.isOpen() }; });
      T('menus inventory close', () => { g.menus.toggleInventory(); return { open: g.state.flags.inventoryOpen }; });
      T('menus settings', () => { g.menus.showSettings('pause'); const open = g.menus.isOpen(); g.menus.hide(); return { open }; });

      T('save roundtrip', () => {
        const data = { savedAt: 1, seed: g.seed, edits: g.world.serialize().edits, inventory: g.inventory.serialize(), player: g.player.serialize(), sky: g.sky.serialize(), stats: g.state.serializeStats(), gamemode: 'survival' };
        const okSave = g.state.saveGame(data);
        const loaded = g.state.loadGame();
        return { okSave, hasSave: g.state.hasSave(), loadedSeed: loaded && loaded.seed === g.seed };
      });

      return out;
    });

    // ---- movement: dispatch real key events and check the player moves ----
    // Use creative flight so terrain collision can't mask the result.
    const startPos = await page.evaluate(() => {
      const g = window.GAME;
      g.state.flags.mode = 'play'; g.state.flags.paused = false; g.state.flags.inventoryOpen = false;
      g.player.setGamemode('creative'); g.player.flying = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      return { x: g.player.position.x, z: g.player.position.z };
    });
    const inputState = await page.evaluate(() => ({
      isDown: GAME.input.isDown('KeyW'),
      action: GAME.input.action('forward'),
      mode: GAME.mode, paused: GAME.state.flags.paused,
    }));
    await sleep(900);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
    const endPos = await page.evaluate(() => ({ x: GAME.player.position.x, z: GAME.player.position.z }));
    const moved = Math.hypot(endPos.x - startPos.x, endPos.z - startPos.z);

    // ---- fall & land: verify the player rests ON the surface (collision fix) ----
    await page.evaluate(() => {
      const g = window.GAME;
      g.player.setGamemode('survival'); g.player.flying = false;
      const px = Math.round(g.player.position.x), pz = Math.round(g.player.position.z);
      const h = g.world.heightAt(px, pz);
      g.player.position.set(px + 0.5, h + 6, pz + 0.5);
      g.player.velocity.set(0, 0, 0);
    });
    await sleep(2200);
    const landing = await page.evaluate(() => {
      const g = window.GAME;
      const px = Math.round(g.player.position.x), pz = Math.round(g.player.position.z);
      const h = g.world.heightAt(px, pz);
      return {
        onGround: g.player.onGround,
        feetY: +g.player.position.y.toFixed(2),
        surfaceTop: h + 1,
        restsOnSurface: Math.abs(g.player.position.y - (h + 1)) < 0.6,
        launched: g.player.position.y > h + 4,
      };
    });

    // let mobs/particles/entities update for a few seconds to catch update() errors
    await sleep(3000);

    const finalState = await page.evaluate(() => ({
      winErrors: (window.__we || []).slice(0, 10),
      frame: GAME.engine.frame,
      health: GAME.player.health,
      entities: GAME.entities.entities.length,
      items: GAME.entities.items.length,
      mode: GAME.mode,
    }));

    const opFails = ops.filter((o) => !o.ok);
    report = {
      ok: opFails.length === 0 && errors.length === 0 && finalState.winErrors.length === 0 && moved > 0.3
        && landing.onGround && landing.restsOnSurface && !landing.launched,
      moved: +moved.toFixed(2),
      inputState,
      landing,
      opFailures: opFails,
      opCount: ops.length,
      ops,
      consoleErrors: errors.slice(0, 10),
      finalState,
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
