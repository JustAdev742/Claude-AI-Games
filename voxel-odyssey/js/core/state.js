/* =========================================================================
   state.js — settings, persistent save/load, and run-time flags.

   Settings persist immediately to localStorage. A saved game stores only the
   procedural seed plus the player's edits (block diffs), inventory, and a few
   scalars — never the whole world — so saves stay tiny.
   ========================================================================= */

const SETTINGS_KEY = 'voxel-odyssey:settings:v1';
const SAVE_KEY = 'voxel-odyssey:save:v1';

export const DEFAULT_SETTINGS = {
  renderDistance: 6,      // chunks (clamped 2..12)
  fov: 75,                // degrees
  mouseSensitivity: 1.0,  // multiplier
  invertY: false,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  musicVolume: 0.5,
  showFps: false,
  fancyGraphics: true,    // ambient occlusion + clouds + smooth shading
  viewBobbing: true,
  smoothLighting: true,
  daylightSpeed: 1.0,     // multiplier on the day/night cycle
  gamemode: 'survival',   // 'survival' | 'creative'

  // ---- look feel ----
  // Camera smoothing blends raw mouse deltas over a few frames. Kept off by
  // default: it adds input latency, which players used to raw mouse input
  // notice immediately, but it visibly helps low-DPI mice and gamepads.
  lookSmoothing: 0.0,     // 0 = raw (1:1), 1 = heavily smoothed
  gamepadEnabled: true,
  gamepadLookSpeed: 2.6,  // radians/sec at full stick deflection
  gamepadDeadzone: 0.18,

  // ---- multiplayer ----
  serverUrl: '',
  playerName: '',

  // Custom key bindings, action -> array of KeyboardEvent.code. Empty means
  // "use the defaults"; only actions the player actually rebinds are stored,
  // so adding a new action later doesn't need a settings migration.
  keyBindings: {},
};

function safeLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const k = '__vo_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch (_) {
    return null;
  }
}

export class GameState {
  constructor(events) {
    this.events = events || null;
    this.ls = safeLocalStorage();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this._loadSettings());
    this.stats = {
      blocksMined: 0,
      blocksPlaced: 0,
      distanceWalked: 0,
      mobsDefeated: 0,
      deaths: 0,
      playSeconds: 0,
    };
    // Live, non-persisted flags read by many systems.
    this.flags = {
      paused: false,
      mode: 'menu',       // 'menu' | 'play'
      debug: false,
      inventoryOpen: false,
      pointerLocked: false,
    };
  }

  /* ---- settings ---- */
  _loadSettings() {
    if (!this.ls) return {};
    try {
      const raw = this.ls.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  _persistSettings() {
    if (!this.ls) return;
    try { this.ls.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) {}
  }
  get(key) { return this.settings[key]; }
  set(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this._persistSettings();
    if (this.events) this.events.emit('settings:change', { key, value });
  }
  resetSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this._persistSettings();
    if (this.events) this.events.emit('settings:change', { key: '*', value: null });
  }

  /* ---- flags ---- */
  setFlag(name, value) { this.flags[name] = value; }
  isPaused() { return this.flags.paused; }
  get mode() { return this.flags.mode; }
  set mode(m) { this.flags.mode = m; }

  /* ---- save / load ---- */
  hasSave() {
    if (!this.ls) return false;
    return !!this.ls.getItem(SAVE_KEY);
  }
  // `data` is assembled by main.js from world/player/inventory serializers.
  saveGame(data) {
    if (!this.ls) return false;
    try {
      const payload = Object.assign({ version: 1, savedAt: data.savedAt || 0 }, data);
      this.ls.setItem(SAVE_KEY, JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('saveGame failed', err);
      return false;
    }
  }
  loadGame() {
    if (!this.ls) return null;
    try {
      const raw = this.ls.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('loadGame failed', err);
      return null;
    }
  }
  deleteSave() {
    if (!this.ls) return;
    try { this.ls.removeItem(SAVE_KEY); } catch (_) {}
  }

  /* ---- stats ---- */
  addStat(key, amount = 1) {
    if (this.stats[key] === undefined) this.stats[key] = 0;
    this.stats[key] += amount;
  }
  serializeStats() { return Object.assign({}, this.stats); }
  loadStats(obj) { if (obj) Object.assign(this.stats, obj); }
}

export default GameState;
