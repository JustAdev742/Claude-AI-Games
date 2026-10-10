/* End-to-end test of the performance controls in a real browser:
     - ?quality=low applies the preset (render scale, shader tier, view distance)
     - every shader tier compiles and draws a real picture (no black screen)
     - the Settings screen has the controls and the preset drop-down rewrites settings
     - the adaptive governor lowers resolution on a machine too slow for the load
       (software rendering is exactly that machine)
     - the frame cap and the profiler overlay work
   Set E2E_SHOTS=<dir> for screenshots of each tier. */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8111;
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
    const open = async (query, size = { width: 480, height: 270 }) => {
      const ctx = await browser.newContext({ viewport: size });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
      page.on('console', (m) => { if (m.type() === 'error' || /shader|compile|GLSL/i.test(m.text())) errors.push('CONSOLE: ' + m.text().slice(0, 300)); });
      await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.GAME && window.GAME.player, { timeout: 30000 });
      return { ctx, page };
    };
    const startWorld = async (page) => {
      await page.evaluate(() => window.GAME.events.emit('game:new', { seed: 'e2e-quality', gamemode: 'creative' }));
      await page.waitForFunction(() => document.getElementById('loading-screen').classList.contains('hidden'), null, { timeout: 120000 });
      await sleep(800);
      await page.evaluate(() => {
        const g = window.GAME;
        g.state.flags.mode = 'play'; g.state.flags.paused = false;
        g.player.setGamemode('creative'); g.player.flying = true;
        g.player.position.y = g.world.heightAt(Math.floor(g.player.position.x), Math.floor(g.player.position.z)) + 14;
        g.player.velocity.set(0, 0, 0); g.player.pitch = -0.2; g.sky.setTime(0.45);
      });
    };
    // Average brightness and spread of the canvas, via a screenshot drawn into a 2D canvas.
    const picture = async (page) => {
      const b64 = (await page.screenshot()).toString('base64');
      return page.evaluate(async (data) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const px = x.getImageData(0, 0, c.width, c.height).data;
        let sum = 0, sum2 = 0, n = 0;
        for (let i = 0; i < px.length; i += 16) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += l; sum2 += l * l; n++; }
        const mean = sum / n;
        return { mean: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) };
      }, b64);
    };

    // ---- 1. URL preset ------------------------------------------------------------
    {
      const { ctx, page } = await open('?quality=low');
      report.urlPreset = await page.evaluate(() => {
        const g = window.GAME, s = g.state.settings;
        return {
          quality: s.quality, scale: s.renderScale, tier: s.shaderTier, rd: s.renderDistance, fancy: s.fancyGraphics,
          engineScale: g.engine.renderScale, defines: g.world.matOpaque.defines.QUALITY,
          pixelRatio: g.renderer.getPixelRatio(),
        };
      });
      await ctx.close();
      const { ctx: c2, page: p2 } = await open('?quality=high&scale=0.6&distance=5&fps=30');
      report.urlOverrides = await p2.evaluate(() => {
        const s = window.GAME.state.settings;
        return { quality: s.quality, scale: s.renderScale, rd: s.renderDistance, maxFps: s.maxFps, engineFps: window.GAME.engine.maxFps };
      });
      await c2.close();
    }

    // ---- 2. every shader tier draws a picture ---------------------------------------
    {
      const { ctx, page } = await open('?quality=medium');
      await startWorld(page);
      report.tiers = {};
      for (const t of [2, 1, 0]) {
        await page.evaluate((tier) => { window.GAME.state.set('shaderTier', tier); }, t);
        await sleep(2500);
        const defines = await page.evaluate(() => [window.GAME.world.matOpaque, window.GAME.world.matWater, window.GAME.world.matCross, window.GAME.world.matViewmodel].map((m) => m.defines.QUALITY));
        const pic = await picture(page);
        report.tiers[t] = { defines, ...pic };
        if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `tier-${t}.png`) });
      }

      // ---- 3. settings screen ----------------------------------------------------------
      await page.evaluate(() => { window.GAME.menus.showSettings('pause'); });
      await sleep(400);
      report.settingsUi = await page.evaluate(() => ({
        selects: [...document.querySelectorAll('select.choice')].map((s) => s.options.length),
        text: document.querySelector('.menu-panel').textContent.includes('Performance'),
        sliderLabels: [...document.querySelectorAll('.menu-panel .setting label span:first-child')].map((e) => e.textContent).filter((t) => /Resolution|Brightness|Shader|Frame rate|Quality/.test(t)),
      }));
      await page.selectOption('select.choice', 'low');          // first select is the preset
      await sleep(500);
      report.afterPreset = await page.evaluate(() => {
        const s = window.GAME.state.settings, g = window.GAME;
        return { quality: s.quality, scale: s.renderScale, tier: s.shaderTier, rd: s.renderDistance, defines: g.world.matOpaque.defines.QUALITY, engineScale: g.engine.renderScale, clouds: g.sky.cloudGroup ? g.sky.cloudGroup.visible : null };
      });
      // touching one knob makes the preset "custom"
      await page.evaluate(() => window.GAME.state.set('renderScale', 0.9));
      report.afterEdit = await page.evaluate(() => window.GAME.state.settings.quality);
      await page.evaluate(() => { window.GAME.menus.hide(); window.GAME.state.flags.paused = false; window.GAME.state.flags.mode = 'play'; });

      // ---- 4. the profiler overlay -------------------------------------------------------
      await page.evaluate(() => { window.GAME.state.flags.debug = true; });
      await sleep(1200);
      report.debug = await page.evaluate(() => document.getElementById('debug').textContent);
      await page.evaluate(() => { window.GAME.state.flags.debug = false; });
      await ctx.close();
    }

    // ---- 5. the governor, on a machine that cannot keep up -----------------------------------
    {
      const { ctx, page } = await open('?quality=high', { width: 320, height: 180 });
      await page.evaluate(() => { window.GAME.state.set('dynamicResolution', true); });
      await startWorld(page);
      await page.evaluate(() => window.GAME.perf.resetWindow());
      await sleep(40000);
      report.governor = await page.evaluate(() => {
        const g = window.GAME;
        return { scale: g.engine.renderScale, effectiveRd: g.state.renderDistance, settingRd: g.state.settings.renderDistance, settingScale: g.state.settings.renderScale,
          log: g.quality.governor.log.slice(), ms: +g.quality.governor.ms.toFixed(0), pixelRatio: g.renderer.getPixelRatio() };
      });
      await ctx.close();
    }

    // ---- 6. the frame cap -------------------------------------------------------------------------
    {
      const { ctx, page } = await open('?quality=low&fps=30', { width: 320, height: 180 });
      await startWorld(page);
      await sleep(1500);
      report.frameCap = await page.evaluate(() => new Promise((resolve) => {
        let n = 0; const t0 = performance.now();
        const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve({ frames: n, seconds: 3, engineFps: window.GAME.engine.maxFps }); };
        requestAnimationFrame(tick);
      }));
      await ctx.close();
    }

    report.errors = errors.slice(0, 8);
    const r = report;
    const tiersOk = [0, 1, 2].every((t) => r.tiers[t] && r.tiers[t].defines.every((d) => d === t) && r.tiers[t].mean > 40 && r.tiers[t].sd > 15);
    r.ok = !!(r.urlPreset.quality === 'low' && r.urlPreset.scale === 0.75 && r.urlPreset.tier === 0 && r.urlPreset.rd === 4 && r.urlPreset.fancy === false
      && r.urlPreset.defines === 0 && r.urlPreset.engineScale === 0.75
      && r.urlOverrides.scale === 0.6 && r.urlOverrides.rd === 5 && r.urlOverrides.maxFps === 30 && r.urlOverrides.engineFps === 30
      && tiersOk
      && r.settingsUi.text && r.settingsUi.selects.length >= 3 && r.settingsUi.sliderLabels.length >= 4
      && r.afterPreset.quality === 'low' && r.afterPreset.tier === 0 && r.afterPreset.defines === 0 && r.afterPreset.rd === 4
      && r.afterEdit === 'custom'
      && /frame:/.test(r.debug) && /draw: [1-9]\d* calls/.test(r.debug) && /res: \d+%/.test(r.debug) && /render/.test(r.debug)
      && r.governor.scale < 1 && r.governor.log.length >= 1 && r.governor.settingScale === 1 && r.governor.pixelRatio < 1
      && r.governor.effectiveRd <= r.governor.settingRd
      && r.frameCap.frames <= 3 * 31
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
