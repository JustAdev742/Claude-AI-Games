/* Verify the three reported bugs are actually fixed, from the player's view:
   W walks the way the camera faces, mouse look isn't permanently downgraded
   by a transient pointer-lock refusal, and the sun cannot be seen through
   solid rock. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/Claude-AI-Games/voxel-odyssey';
const PORT = 8087;
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
const errors = [];
let out = { ok: false };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: findChromium() || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 25000 });
  await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'fixes', gamemode: 'creative' }));
  await sleep(4000);

  /* ---- 1. WASD directions match where the camera is pointing ---- */
  const movement = await page.evaluate(async () => {
    const g = window.GAME, THREE = g.THREE;
    g.state.flags.mode = 'play'; g.state.flags.paused = false;
    g.player.setGamemode('creative'); g.player.flying = true;

    const test = async (code, label) => {
      // Face a deliberately non-axis-aligned direction so a sign error can't
      // hide behind symmetry.
      g.player.yaw = 0.9; g.player.pitch = 0;
      g.player.velocity.set(0, 0, 0);
      g.player.position.set(0, 80, 0);
      await new Promise((r) => requestAnimationFrame(r));

      const before = g.player.position.clone();
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      const moved = g.player.position.clone().sub(before);
      moved.y = 0;

      // The camera's own forward/right, taken from the camera matrix rather
      // than recomputed — so the test can't repeat the same maths error.
      const fwd = new THREE.Vector3();
      g.camera.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

      const dist = moved.length();
      return {
        label,
        dist: +dist.toFixed(2),
        alongForward: +(moved.dot(fwd) / (dist || 1)).toFixed(3),
        alongRight: +(moved.dot(right) / (dist || 1)).toFixed(3),
      };
    };

    return {
      W: await test('KeyW', 'forward'),
      S: await test('KeyS', 'back'),
      A: await test('KeyA', 'left'),
      D: await test('KeyD', 'right'),
    };
  });

  /* ---- 2. a transient pointer-lock refusal must not be permanent ---- */
  const lockRecovery = await page.evaluate(async () => {
    const g = window.GAME, input = g.input;

    // Simulate Chrome's post-Escape cooldown: refuse once, then allow.
    let calls = 0;
    const realRequest = HTMLCanvasElement.prototype.requestPointerLock;
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      calls++;
      if (calls === 1) return Promise.reject(new Error('transient refusal'));
      return realRequest.apply(this, arguments);
    };

    input.virtualLock = false;
    input._lockFailures = 0;
    input.requestLock();
    await new Promise((r) => setTimeout(r, 50));
    const afterRefusal = { virtual: input.virtualLock, failures: input._lockFailures };

    // The retry timer should fire and try the real API again.
    await new Promise((r) => setTimeout(r, 1600));
    const retried = { calls, stillGivingUp: input._lockFailures >= 4 };

    HTMLCanvasElement.prototype.requestPointerLock = realRequest;
    return { afterRefusal, retried };
  });

  /* ---- 3. edge-turn keeps rotation unbounded in the fallback ---- */
  const edge = await page.evaluate(async () => {
    const g = window.GAME, input = g.input;
    input.virtualLock = true; input.locked = true;
    input._pointerX = 2;                       // hard against the left border
    input._pointerY = window.innerHeight / 2;
    const e = input.edgeTurn();

    const yaw0 = g.player.yaw;
    await new Promise((r) => setTimeout(r, 400));
    const turned = Math.abs(g.player.yaw - yaw0) > 0.05;

    input._pointerX = window.innerWidth / 2;   // centre: no edge turn
    const centre = input.edgeTurn();
    input.virtualLock = false; input.locked = false;
    return { atEdge: +e.x.toFixed(2), atCentre: +centre.x.toFixed(2), turned };
  });

  /* ---- 4. the sun must not be visible through solid rock ---- */
  const occlusion = await page.evaluate(async () => {
    const g = window.GAME;

    // Seal the player inside a solid stone shell, well underground.
    const cx = 200, cy = 24, cz = 200;
    for (let x = -4; x <= 4; x++)
      for (let y = -4; y <= 4; y++)
        for (let z = -4; z <= 4; z++)
          g.world.setBlock(cx + x, cy + y, cz + z, g.blocks.ID.STONE, { cause: 'place', by: 'test' });
    // Hollow out a 1x2x1 pocket to stand in.
    g.world.setBlock(cx, cy, cz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
    g.world.setBlock(cx, cy + 1, cz, g.blocks.ID.AIR, { cause: 'break', by: 'test' });

    g.player.flying = true;
    g.player.position.set(cx + 0.5, cy, cz + 0.5);
    g.player.velocity.set(0, 0, 0);

    // Noon, and aim straight at the sun.
    g.sky.setTime(0.5);
    await new Promise((r) => setTimeout(r, 400));
    const dir = g.sky.getSunDirection(new g.THREE.Vector3());
    g.player.yaw = Math.atan2(-dir.x, -dir.z);
    g.player.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));

    // Let several frames render so the shell is meshed and lit.
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));

    return { cx, cy, cz, sunDir: { x: +dir.x.toFixed(2), y: +dir.y.toFixed(2), z: +dir.z.toFixed(2) } };
  });

  await sleep(600);
  await page.screenshot({ path: '/home/user/Claude-AI-Games/voxel-odyssey/dist/occlusion-sealed.png' });


  // Sample by rendering the scene into an offscreen target and reading THAT.
  // readPixels on the default framebuffer after presentation is undefined
  // without preserveDrawingBuffer, which we don't want to force on in
  // production just to be testable.
  const samplePatch = () => page.evaluate(() => {
    const g = window.GAME, THREE = g.THREE;
    const r = g.renderer;
    const size = 64;
    const rt = new THREE.WebGLRenderTarget(size, size);
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(g.engine.scene, g.camera);
    const buf = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    r.setRenderTarget(prev);
    rt.dispose();

    // Average the centre patch, where the sun is aimed.
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let y = size / 2 - 6; y < size / 2 + 6; y++) {
      for (let x = size / 2 - 6; x < size / 2 + 6; x++) {
        const i = (y * size + x) * 4;
        rr += buf[i]; gg += buf[i + 1]; bb += buf[i + 2]; n++;
      }
    }
    return { r: Math.round(rr / n), g: Math.round(gg / n), b: Math.round(bb / n) };
  });

  const centrePixel = await samplePatch();

  // Now open the ceiling and confirm the sun IS visible — proving the test
  // detects the sun at all, rather than the screen simply being dark.
  await page.evaluate(({ cx, cy, cz }) => {
    const g = window.GAME;
    for (let y = cy + 1; y <= cy + 8; y++) {
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
        g.world.setBlock(cx + x, y, cz + z, g.blocks.ID.AIR, { cause: 'break', by: 'test' });
      }
    }
  }, occlusion);
  await sleep(2500);
  const openPixel = await samplePatch();
  await page.screenshot({ path: '/home/user/Claude-AI-Games/voxel-odyssey/dist/occlusion-open.png' });

  const brightness = (p) => (p.r + p.g + p.b) / 3;

  out = {
    ok: errors.length === 0
      // W must move ALONG the camera forward, S against it.
      && movement.W.alongForward > 0.95 && movement.S.alongForward < -0.95
      && movement.D.alongRight > 0.95 && movement.A.alongRight < -0.95
      && movement.W.dist > 1
      // One refusal must not permanently disable real pointer lock.
      && lockRecovery.afterRefusal.failures === 1
      && !lockRecovery.retried.stillGivingUp
      && lockRecovery.retried.calls >= 2
      // Edge-turn active at the border, silent at the centre.
      && Math.abs(edge.atEdge) > 1 && edge.atCentre === 0 && edge.turned
      // Sealed in rock the view is dark; opened up the sun is bright.
      && brightness(centrePixel) < 90
      && brightness(openPixel) > brightness(centrePixel) + 60,
    movement, lockRecovery, edge,
    sealedPixel: centrePixel, sealedBrightness: +brightness(centrePixel).toFixed(1),
    openPixel, openBrightness: +brightness(openPixel).toFixed(1),
    errors: errors.slice(0, 6),
  };
} catch (e) {
  out = { ok: false, fatal: (e && e.stack) || String(e), errors: errors.slice(0, 6) };
} finally {
  if (browser) await browser.close();
  server.kill('SIGKILL');
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
