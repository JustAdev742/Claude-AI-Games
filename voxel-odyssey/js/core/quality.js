/* =========================================================================
   quality.js — presets, hardware detection and the adaptive governor.

   Three pieces, all aimed at one thing: playable on an old laptop.

     PRESETS       Low / Medium / High, each a bundle of settings (view
                   distance, render scale, shader tier, effects, caps).
     detect()      a first-run guess at the right preset from the GPU string,
                   core count, memory and screen size. It only chooses a
                   starting point; the governor corrects it from real frame
                   times.
     Governor      watches the frame rate while you play and trades pixels for
                   speed when it drops — render scale first (the cheapest knob
                   to turn: pixel count is what weak GPUs run out of), then
                   view distance — and hands pixels back when there is headroom.

   Pure logic where possible (classify, governor decisions) so it can be unit
   tested without a browser.
   ========================================================================= */

export const PRESETS = {
  low: {
    renderDistance: 4, renderScale: 0.75, shaderTier: 0, fancyGraphics: false,
    particleScale: 0.4, mobScale: 0.6, streamBudgetMs: 3, lightBudget: 12000, maxFps: 0,
  },
  medium: {
    renderDistance: 6, renderScale: 1, shaderTier: 1, fancyGraphics: false,
    particleScale: 0.7, mobScale: 0.85, streamBudgetMs: 4, lightBudget: 20000, maxFps: 0,
  },
  high: {
    renderDistance: 8, renderScale: 1, shaderTier: 2, fancyGraphics: true,
    particleScale: 1, mobScale: 1, streamBudgetMs: 5, lightBudget: 32000, maxFps: 0,
  },
};

export const PRESET_KEYS = Object.keys(PRESETS.high);

/* ---- hardware detection ---------------------------------------------------- */

// Read the GPU's name through a throwaway context. Returns '' when the browser
// hides it (some privacy settings do).
export function readGpuName() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();      // do not keep a spare context alive
    return String(name || '');
  } catch (_) { return ''; }
}

export function gatherHardware() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof screen !== 'undefined' ? screen : { width: 1280, height: 720 };
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return {
    gpu: readGpuName(),
    cores: nav.hardwareConcurrency || 2,
    memory: nav.deviceMemory || 0,             // GB, Chrome only; 0 = unknown
    mobile: /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '') || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches),
    dpr,
    pixels: scr.width * scr.height * dpr * dpr,  // device pixels on the screen
  };
}

// Pick a preset name from hardware facts. Deliberately conservative: choosing
// too low costs some prettiness, too high costs playability.
export function classify(hw) {
  const gpu = (hw.gpu || '').toLowerCase();
  // Software rasterisers: no GPU at all.
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/.test(gpu)) return 'low';
  if (hw.mobile) return hw.cores >= 8 ? 'medium' : 'low';

  let tier;
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|apple m\d|apple gpu|arc /.test(gpu)) tier = 'high';
  else if (/iris|xe graphics|uhd|vega|radeon graphics|radeon\(tm\) graphics/.test(gpu)) tier = 'medium';
  else if (/intel|hd graphics|radeon hd|mobility|gma|powervr|mali|adreno/.test(gpu)) tier = 'low';
  else tier = 'medium';                                    // unknown GPU

  // Weak CPUs / little memory drag the whole machine down regardless of GPU.
  if (hw.cores <= 2 || (hw.memory && hw.memory <= 2)) tier = 'low';
  else if (hw.cores <= 4 && tier === 'high') tier = 'medium';
  return tier;
}

// A render-scale cap from how many pixels the screen has: a 4K or retina panel
// has several times the work of a 1366x768 one at the same settings.
export function scaleForPixels(pixels, tier) {
  const basePixels = tier === 'high' ? 4.2e6 : tier === 'medium' ? 2.4e6 : 1.4e6;
  if (pixels <= basePixels) return 1;
  return Math.max(0.5, Math.min(1, Math.sqrt(basePixels / pixels)));
}

/* Settings that a preset (plus the screen) implies. */
export function settingsForPreset(name, hw) {
  const p = Object.assign({}, PRESETS[name] || PRESETS.medium);
  if (hw && hw.pixels) p.renderScale = Math.min(p.renderScale, scaleForPixels(hw.pixels, name));
  p.renderScale = Math.round(p.renderScale * 20) / 20;
  return p;
}

/* ---- the adaptive governor ------------------------------------------------- */

const SCALE_MIN = 0.5;
const SCALE_STEP_DOWN = 0.1;
const SCALE_STEP_UP = 0.05;
const RD_MIN = 3;
const TARGET_FPS = 45;                // below this for a while, shed load
const COMFORT_FPS = 62;               // above this for a long while, take load back

/* Decides, from smoothed frame times, whether to lower or raise the load.
   Kept free of DOM/GL so its behaviour can be tested with synthetic frame
   times. `limits` bounds how high it may go (the preset's own values). */
export class Governor {
  constructor(limits) {
    this.limits = Object.assign({ renderScale: 1, renderDistance: 8 }, limits);
    this.scale = this.limits.renderScale;
    this.renderDistance = this.limits.renderDistance;
    this.ms = 16.7;                   // smoothed wall-clock frame time
    this.cpuShare = 0;                // fraction of the frame spent in JS
    this._slow = 0;                   // seconds spent below target
    this._fast = 0;                   // seconds spent comfortably above it
    this._hold = 3;                   // seconds to wait after a change before judging again
    this._sinceDown = 99;
    this.log = [];                    // decisions, for tests and the debug overlay
  }

  setLimits(limits) {
    this.limits = Object.assign({}, this.limits, limits);
    this.scale = Math.min(this.scale, this.limits.renderScale);
    this.renderDistance = Math.min(this.renderDistance, this.limits.renderDistance);
  }

  /* Feed one frame. `frameMs` is wall-clock time since the last frame, `cpuMs`
     the JS time the frame took. Returns { scale, renderDistance, changed }. */
  frame(frameMs, cpuMs) {
    // A stall (tab hidden, debugger, big GC) says nothing about steady speed.
    if (frameMs > 400) return this._result(false);
    this.ms += (frameMs - this.ms) * 0.08;
    this.cpuShare += ((cpuMs / Math.max(frameMs, 1)) - this.cpuShare) * 0.08;
    const dt = frameMs / 1000;
    this._hold -= dt;
    this._sinceDown += dt;
    if (this._hold > 0) return this._result(false);

    const fps = 1000 / this.ms;
    if (fps < TARGET_FPS) { this._slow += dt; this._fast = 0; }
    else if (fps > COMFORT_FPS) { this._fast += dt; this._slow = Math.max(0, this._slow - dt); }
    else { this._slow = Math.max(0, this._slow - dt); this._fast = Math.max(0, this._fast - dt * 0.5); }

    let changed = false;
    if (this._slow >= 1.2) {
      this._slow = 0;
      this._hold = 2.5;                // let the change take effect before judging it
      this._sinceDown = 0;
      // JS-bound frames do not get faster with fewer pixels: shed view
      // distance (less to generate, mesh and draw) instead.
      const cpuBound = this.cpuShare > 0.6;
      if (!cpuBound && this.scale > SCALE_MIN + 1e-6) {
        this.scale = Math.max(SCALE_MIN, Math.round((this.scale - SCALE_STEP_DOWN) * 100) / 100);
        this.log.push(`scale ↓ ${this.scale}`);
        changed = true;
      } else if (this.renderDistance > RD_MIN) {
        this.renderDistance--;
        this.log.push(`distance ↓ ${this.renderDistance}`);
        changed = true;
      }
    } else if (this._fast >= 8 && this._sinceDown > 12) {
      this._fast = 0;
      this._hold = 3;
      if (this.renderDistance < this.limits.renderDistance) {
        this.renderDistance++;
        this.log.push(`distance ↑ ${this.renderDistance}`);
        changed = true;
      } else if (this.scale < this.limits.renderScale - 1e-6) {
        this.scale = Math.min(this.limits.renderScale, Math.round((this.scale + SCALE_STEP_UP) * 100) / 100);
        this.log.push(`scale ↑ ${this.scale}`);
        changed = true;
      }
    }
    if (this.log.length > 12) this.log.shift();
    return this._result(changed);
  }

  _result(changed) { return { scale: this.scale, renderDistance: this.renderDistance, changed }; }
}

/* ---- the runtime manager ---------------------------------------------------- */

export class Quality {
  constructor(game) {
    this.game = game;
    this.governor = new Governor({});
    this.hardware = null;
    this._applying = false;
    this._unsubs = [];
    this._toldSlow = false;
    this._lastScale = 1;
    this._lastDistance = 99;
  }

  // Called once at startup, BEFORE the engine exists: on a first run (or when
  // the player picked "Auto") choose a preset from the hardware and write it
  // into the settings, so even the renderer's creation-time options (MSAA)
  // start out right.
  static prepare(state) {
    const s = state.settings;
    if (s.quality !== 'auto') return null;
    const hw = gatherHardware();
    const name = classify(hw);
    let fresh = false;
    if (!s._autoApplied) {
      const p = settingsForPreset(name, hw);
      for (const k of PRESET_KEYS) s[k] = p[k];
      s._autoApplied = name;
      state._persistSettings();
      fresh = true;
    }
    return { hw, name, fresh };
  }

  init(prepared) {
    this.hardware = prepared ? prepared.hw : null;
    const game = this.game, state = game.state;
    this._syncLimits();
    const ev = game.events;
    if (ev) {
      this._unsubs.push(ev.on('settings:change', (e) => this._onSetting(e)));
    }
    this.applyAll();
    // Say so when the first-run guess is the Low preset, once the world is up
    // (a toast during the loading screen would go unseen).
    if (prepared && prepared.fresh && prepared.name === 'low' && ev) {
      const off = ev.on('world:ready', () => {
        game.toast('Modest graphics detected — using the Low preset. Settings → Performance has more options.', 'warn');
        if (typeof off === 'function') off();
      });
    }
    return this;
  }

  // The governor may lower things, but never past what the player chose.
  _syncLimits() {
    const s = this.game.state.settings;
    this.governor.setLimits({ renderScale: s.renderScale, renderDistance: s.renderDistance });
    this.governor.scale = s.renderScale;
    this.governor.renderDistance = s.renderDistance;
    this._lastScale = s.renderScale;
    this._lastDistance = s.renderDistance;
  }

  // Choose a preset by name ('auto' re-detects). Writes the bundle into settings.
  setPreset(name) {
    const state = this.game.state;
    this._applying = true;
    try {
      state.set('quality', name);
      let preset = name;
      if (name === 'auto') {
        this.hardware = this.hardware || gatherHardware();
        preset = classify(this.hardware);
      }
      if (PRESETS[preset]) {
        const p = settingsForPreset(preset, this.hardware || gatherHardware());
        for (const k of PRESET_KEYS) state.set(k, p[k]);
      }
    } finally { this._applying = false; }
    this._syncLimits();
    this.applyAll();
  }

  _onSetting({ key }) {
    if (this._applying) return;
    // Touching an individual quality knob makes the choice "custom".
    if (PRESET_KEYS.includes(key) && key !== 'maxFps' && this.game.state.settings.quality !== 'custom') {
      this.game.state.set('quality', 'custom');
    }
    if (key === 'renderScale' || key === 'renderDistance' || key === '*') this._syncLimits();
    this.applyAll();
  }

  // Push the current settings into the systems that act on them.
  applyAll() {
    const g = this.game, s = g.state.settings;
    if (g.engine) {
      g.engine.setRenderScale(this.governor.scale);
      g.engine.maxFps = s.maxFps || 0;
    }
    if (g.world && g.world.setShaderTier) g.world.setShaderTier(s.shaderTier);
    if (g.sky && g.sky.setClouds) g.sky.setClouds(!!s.fancyGraphics || s.shaderTier >= 1);
  }

  // Per-frame: run the governor while actually playing.
  update(frameMs, cpuMs) {
    const g = this.game, s = g.state.settings, f = g.state.flags;
    if (!s.dynamicResolution || f.mode !== 'play' || f.paused || f.inventoryOpen || document.hidden) return;
    const r = this.governor.frame(frameMs, cpuMs);
    if (!r.changed) return;
    if (!this._toldSlow && (r.scale < this._lastScale || r.renderDistance < this._lastDistance)) {
      this._toldSlow = true;
      g.toast('Running slowly — easing the picture quality to keep it smooth. Settings → Performance to change this.', 'warn');
    }
    this._lastScale = r.scale; this._lastDistance = r.renderDistance;
    g.engine.setRenderScale(r.scale);
    // The governor lowers the effective distance without rewriting the player's
    // setting, so the choice survives a restart; World reads this override.
    g.state.runtime = g.state.runtime || {};
    g.state.runtime.renderDistance = r.renderDistance;
  }
}

export default Quality;
