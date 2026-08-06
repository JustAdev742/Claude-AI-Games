/* =========================================================================
   hud.js — the in-game heads-up display.

   A pure-DOM HUD injected into #hud-layer. It is intentionally decoupled from
   the rest of the game: it reads a handful of fields off `game` at update time
   and reacts to events on the bus, so it stays correct even before a world
   exists (every read is null-guarded).

   Pieces, all matching the class names already defined in styles.css:
     #crosshair        — center reticle
     #hotbar           — 9 .slot divs, each: <canvas> (Items.drawIcon) + .count
                         + .key (1..9) + .selected highlight
     #status-bars      — 10 heart pips (= 20 HP) with half-heart support (SVG)
     #clock            — small analog day/night clock (canvas)
     #info-panel       — coords / biome / time / gamemode
     #toast-wrap       — transient toast messages
     #hotbar-label     — selected item name, fades in/out
     #screen-overlay   — full-screen hurt / underwater tints
     #debug            — fps / xyz / chunk / biome / entities (state.flags.debug)

   Public API (per ARCHITECTURE.md):
     new HUD(game)
     hud.init()
     hud.setVisible(on)
     hud.update(dt)
     hud.refreshHotbar()
     hud.toast(text, kind)
     hud.showHotbarLabel(name)
     hud.setOverlay(kind, on)   // 'hurt' | 'water'
   ========================================================================= */

import Items from '../items/items.js';
import { formatTimeOfDay, clamp } from '../core/utils.js';

const HOTBAR_SLOTS = 9;
const ICON_SIZE = 40;          // matches `.slot canvas { width:40px }`
const CLOCK_SIZE = 56;         // matches `#clock canvas { width:56px }`
const MAX_TOASTS = 5;          // cap simultaneous toast nodes
const TOAST_LIFETIME = 2800;   // ms before a toast node is removed (anim is ~2.6s)
const LABEL_LIFETIME = 1400;   // ms the hotbar item name stays visible
const HURT_FLASH_MS = 260;     // how long the hurt overlay flashes on 'player:hurt'

export class HUD {
  constructor(game) {
    this.game = game;

    // Root + element references (filled in init()).
    this.root = null;
    this.el = {};              // named element handles
    this.slots = [];           // [{ el, canvas, ctx, count, key, lastId, lastCount, selectedClass }]
    this.pips = [];            // heart pip <span> wrappers (each holds an <svg>)

    // Cached display state so we only touch the DOM when something changes.
    this._lastHealth = -1;
    this._lastInfo = '';
    this._lastDebug = '';
    this._lastSelected = -1;
    this._clockState = -1;     // quantized timeOfDay used to throttle clock redraws

    // Timers driven by update(dt) so we never rely on setTimeout living past a
    // pause / world reset.
    this._labelTimer = 0;      // seconds remaining for the hotbar label
    this._hurtTimer = 0;       // seconds remaining for the auto hurt flash
    this._overlay = { hurt: false, water: false };

    // Throttle counters for the relatively expensive info/debug text builds.
    this._infoAccum = 0;
    this._debugAccum = 0;

    // Bound handlers (kept so they can be unsubscribed in dispose()).
    this._unsubs = [];
    this._visible = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Setup                                                                  */
  /* ---------------------------------------------------------------------- */

  init() {
    if (typeof document === 'undefined') return; // headless guard
    const layer = document.getElementById('hud-layer');
    if (!layer) return;

    // A dedicated container so setVisible()/teardown is a single toggle and we
    // never clobber anything else living in #hud-layer.
    const root = document.createElement('div');
    root.className = 'hud-root';
    root.style.position = 'absolute';
    root.style.inset = '0';
    root.style.pointerEvents = 'none';
    layer.appendChild(root);
    this.root = root;

    this._buildCrosshair();
    this._buildHotbar();
    this._buildStatusBars();
    this._buildClock();
    this._buildInfoPanel();
    this._buildToastWrap();
    this._buildHotbarLabel();
    this._buildScreenOverlay();
    this._buildDebug();

    this._subscribe();

    // Prime the dynamic parts so the HUD looks right before the first update.
    this.refreshHotbar();
    this._refreshHealth(true);
    this._refreshSelectedFromInventory();
    this.setVisible(true);
  }

  _el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.id) e.id = opts.id;
    if (opts.cls) e.className = opts.cls;
    if (opts.text != null) e.textContent = opts.text;
    if (opts.html != null) e.innerHTML = opts.html;
    if (opts.parent) opts.parent.appendChild(e);
    return e;
  }

  _buildCrosshair() {
    this.el.crosshair = this._el('div', { id: 'crosshair', parent: this.root });
  }

  _buildHotbar() {
    const bar = this._el('div', { id: 'hotbar', parent: this.root });
    this.el.hotbar = bar;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slotEl = this._el('div', { cls: 'slot', parent: bar });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(ICON_SIZE * dpr);
      canvas.height = Math.round(ICON_SIZE * dpr);
      canvas.style.width = ICON_SIZE + 'px';
      canvas.style.height = ICON_SIZE + 'px';
      slotEl.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (ctx && dpr !== 1) ctx.scale(dpr, dpr);

      const key = this._el('span', { cls: 'key', text: String(i + 1), parent: slotEl });
      const count = this._el('span', { cls: 'count', parent: slotEl });

      this.slots.push({
        el: slotEl, canvas, ctx, key, count,
        lastId: undefined, lastCount: -1, selected: false,
      });
    }
  }

  _buildStatusBars() {
    const wrap = this._el('div', { id: 'status-bars', parent: this.root });
    this.el.statusBars = wrap;
    const row = this._el('div', { cls: 'bar-row', parent: wrap });
    this.el.heartRow = row;

    // 10 hearts = 20 HP. Each pip is an <span class="pip"> holding an SVG heart
    // whose fill we swap between full / half / empty.
    for (let i = 0; i < 10; i++) {
      const pip = this._el('span', { cls: 'pip', parent: row });
      pip.innerHTML = this._heartSVG('full');
      this.pips.push(pip);
    }
  }

  // Returns an SVG string for a heart in the given state.
  _heartSVG(state) {
    // A classic two-lobe heart path on a 0..16 viewBox.
    const path = 'M8 14.5 L2.2 8.4 C0.4 6.6 0.6 3.8 2.7 2.5 ' +
      'C4.2 1.6 6.1 2.1 7 3.5 L8 5 L9 3.5 ' +
      'C9.9 2.1 11.8 1.6 13.3 2.5 C15.4 3.8 15.6 6.6 13.8 8.4 Z';
    const back = '#3a0d12';
    let fillFull = '#ff5b6e';
    let fillHalf = '#ff5b6e';
    // Build the heart: always a dark "empty" base, then overlay a colored heart
    // (full) or a left-half-clipped colored heart (half).
    if (state === 'empty') {
      return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="${path}" fill="${back}" stroke="#000" stroke-width="0.8"/>` +
        `</svg>`;
    }
    if (state === 'half') {
      return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
        `<defs><clipPath id="hh"><rect x="0" y="0" width="8" height="16"/></clipPath></defs>` +
        `<path d="${path}" fill="${back}" stroke="#000" stroke-width="0.8"/>` +
        `<path d="${path}" fill="${fillHalf}" stroke="#000" stroke-width="0.8" clip-path="url(#hh)"/>` +
        `<rect x="3" y="3.5" width="2" height="2.5" fill="#ffd0d6" opacity="0.7" clip-path="url(#hh)"/>` +
        `</svg>`;
    }
    // full
    return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${path}" fill="${back}" stroke="#000" stroke-width="0.8"/>` +
      `<path d="${path}" fill="${fillFull}" stroke="#000" stroke-width="0.8"/>` +
      `<rect x="3" y="3.5" width="2.5" height="2.5" fill="#ffd0d6" opacity="0.7"/>` +
      `</svg>`;
  }

  _buildClock() {
    const wrap = this._el('div', { id: 'clock', parent: this.root });
    this.el.clock = wrap;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(CLOCK_SIZE * dpr);
    canvas.height = Math.round(CLOCK_SIZE * dpr);
    canvas.style.width = CLOCK_SIZE + 'px';
    canvas.style.height = CLOCK_SIZE + 'px';
    wrap.appendChild(canvas);
    this.el.clockCanvas = canvas;
    this.el.clockCtx = canvas.getContext('2d');
    if (this.el.clockCtx && dpr !== 1) this.el.clockCtx.scale(dpr, dpr);
    this._drawClock(0);
  }

  _buildInfoPanel() {
    this.el.info = this._el('div', { id: 'info-panel', parent: this.root });
  }

  _buildToastWrap() {
    this.el.toastWrap = this._el('div', { id: 'toast-wrap', parent: this.root });
  }

  _buildHotbarLabel() {
    this.el.label = this._el('div', { id: 'hotbar-label', parent: this.root });
  }

  _buildScreenOverlay() {
    this.el.overlay = this._el('div', { id: 'screen-overlay', parent: this.root });
  }

  _buildDebug() {
    this.el.debug = this._el('div', { id: 'debug', parent: this.root });
  }

  /* ---------------------------------------------------------------------- */
  /* Event wiring                                                           */
  /* ---------------------------------------------------------------------- */

  _subscribe() {
    const ev = this.game && this.game.events;
    if (!ev) return;
    this._unsubs.push(ev.on('inventory:change', () => this.refreshHotbar()));
    this._unsubs.push(ev.on('hotbar:select', (p) => this._onHotbarSelect(p)));
    this._unsubs.push(ev.on('player:hurt', () => this._flashHurt()));
    this._unsubs.push(ev.on('player:die', () => this._flashHurt()));
    this._unsubs.push(ev.on('toast', (p) => this.toast(p && p.text, p && p.kind)));
  }

  _onHotbarSelect(payload) {
    let index = payload && typeof payload.index === 'number' ? payload.index : null;
    if (index == null) index = this._selectedIndex();
    this._highlightSlot(index);

    // Show the selected item's name as a brief label.
    let itemKey = payload && payload.item;
    if (itemKey && typeof itemKey === 'object') itemKey = itemKey.id; // accept {id,count}
    if (!itemKey) {
      const stack = this._hotbarStacks()[index];
      itemKey = stack ? stack.id : null;
    }
    if (itemKey) this.showHotbarLabel(Items.name(itemKey));
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                            */
  /* ---------------------------------------------------------------------- */

  setVisible(on) {
    this._visible = !!on;
    if (this.root) this.root.style.display = on ? 'block' : 'none';
  }

  // Redraw all 9 hotbar slot icons + counts, and refresh the selected outline.
  refreshHotbar() {
    if (!this.slots.length) return;
    const stacks = this._hotbarStacks();
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = this.slots[i];
      const stack = stacks[i] || null;
      const id = stack ? stack.id : undefined;
      const cnt = stack ? stack.count : 0;

      // Only redraw the icon canvas when the item actually changed (cheap guard).
      if (id !== slot.lastId) {
        if (slot.ctx) {
          slot.ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
          if (id) {
            try { Items.drawIcon(slot.ctx, id, ICON_SIZE); } catch (_) { /* defensive */ }
          }
        }
        slot.lastId = id;
      }
      // Counts: only show when > 1, and only touch DOM on change.
      if (cnt !== slot.lastCount) {
        slot.count.textContent = cnt > 1 ? String(cnt) : '';
        slot.lastCount = cnt;
      }
    }
    this._refreshSelectedFromInventory();
  }

  // Toast a transient message. `kind`: 'good' | 'warn' | 'info' (default info).
  toast(text, kind = 'info') {
    if (!this.el.toastWrap || text == null) return;
    const node = document.createElement('div');
    node.className = 'toast toast-' + kind;
    node.textContent = String(text);
    // Tint by kind without needing extra CSS classes in styles.css.
    if (kind === 'good') node.style.borderColor = 'var(--accent)';
    else if (kind === 'warn') node.style.borderColor = 'var(--danger)';
    this.el.toastWrap.appendChild(node);

    // Cap the number of live toasts (oldest first).
    while (this.el.toastWrap.childElementCount > MAX_TOASTS) {
      this.el.toastWrap.removeChild(this.el.toastWrap.firstChild);
    }

    // The CSS animation fades it out; remove the node a little after that.
    setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, TOAST_LIFETIME);
  }

  // Briefly show the selected item's name above the hotbar.
  showHotbarLabel(name) {
    if (!this.el.label) return;
    if (!name) { this.el.label.classList.remove('show'); this._labelTimer = 0; return; }
    this.el.label.textContent = name;
    this.el.label.classList.add('show');
    this._labelTimer = LABEL_LIFETIME / 1000;
  }

  // Toggle a screen overlay. kind: 'hurt' | 'water'.
  setOverlay(kind, on) {
    if (kind !== 'hurt' && kind !== 'water') return;
    this._overlay[kind] = !!on;
    if (kind === 'hurt' && !on) this._hurtTimer = 0;
    this._applyOverlay();
  }

  _applyOverlay() {
    const el = this.el.overlay;
    if (!el) return;
    // 'hurt' takes visual priority over 'water' (a single overlay element).
    if (this._overlay.hurt) {
      el.className = 'hurt';
    } else if (this._overlay.water) {
      el.className = 'water';
    } else {
      el.className = '';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame update                                                       */
  /* ---------------------------------------------------------------------- */

  update(dt) {
    if (!this.root || !this._visible) return;
    if (!(dt > 0)) dt = 0; // guard NaN / negative

    // --- timed overlays / labels (frame-rate independent) ---
    if (this._hurtTimer > 0) {
      this._hurtTimer -= dt;
      if (this._hurtTimer <= 0) {
        this._overlay.hurt = false;
        this._applyOverlay();
      }
    }
    if (this._labelTimer > 0) {
      this._labelTimer -= dt;
      if (this._labelTimer <= 0 && this.el.label) {
        this.el.label.classList.remove('show');
      }
    }

    // --- health pips (cheap; reads player.health) ---
    this._refreshHealth(false);

    // --- analog clock (throttled to visible changes) ---
    this._refreshClock();

    // --- info panel (throttled to ~4 Hz) ---
    this._infoAccum += dt;
    if (this._infoAccum >= 0.25) {
      this._infoAccum = 0;
      this._refreshInfo();
    }

    // --- debug overlay (throttled to ~5 Hz, only when enabled) ---
    this._refreshDebug(dt);

    // Keep water overlay synced to the player even if nothing emitted an event,
    // so surfacing/diving updates immediately.
    this._syncWaterOverlay();
  }

  /* ---------------------------------------------------------------------- */
  /* Internal refreshers                                                    */
  /* ---------------------------------------------------------------------- */

  _player() { return this.game && this.game.player ? this.game.player : null; }

  _inventory() { return this.game && this.game.inventory ? this.game.inventory : null; }

  // Return the 9 hotbar stacks as an array (each {id,count}|null), defensively.
  _hotbarStacks() {
    const inv = this._inventory();
    if (inv) {
      if (typeof inv.hotbar === 'function') {
        const h = inv.hotbar();
        if (Array.isArray(h)) return h;
      }
      if (Array.isArray(inv.slots)) return inv.slots.slice(0, HOTBAR_SLOTS);
    }
    return new Array(HOTBAR_SLOTS).fill(null);
  }

  _selectedIndex() {
    const inv = this._inventory();
    if (inv && typeof inv.selected === 'number') {
      return clamp(inv.selected | 0, 0, HOTBAR_SLOTS - 1);
    }
    return 0;
  }

  _refreshSelectedFromInventory() {
    this._highlightSlot(this._selectedIndex());
  }

  _highlightSlot(index) {
    index = clamp((index | 0), 0, HOTBAR_SLOTS - 1);
    if (index === this._lastSelected) return;
    for (let i = 0; i < this.slots.length; i++) {
      const sel = i === index;
      if (this.slots[i].selected !== sel) {
        this.slots[i].el.classList.toggle('selected', sel);
        this.slots[i].selected = sel;
      }
    }
    this._lastSelected = index;
  }

  // Update heart pips to reflect current HP. `force` redraws even if unchanged.
  _refreshHealth(force) {
    if (!this.pips.length) return;
    const player = this._player();
    const maxHealth = player && typeof player.maxHealth === 'number' ? player.maxHealth : 20;
    let hp = player && typeof player.health === 'number' ? player.health : maxHealth;
    hp = clamp(hp, 0, 20);

    if (!force && hp === this._lastHealth) return;
    this._lastHealth = hp;

    // 20 HP across 10 hearts → each heart = 2 HP. Round to nearest half-heart.
    const halves = Math.round(hp); // each half-heart = 1 HP
    for (let i = 0; i < 10; i++) {
      const heartHalves = halves - i * 2; // remaining halves for this heart
      let state;
      if (heartHalves >= 2) state = 'full';
      else if (heartHalves === 1) state = 'half';
      else state = 'empty';
      const pip = this.pips[i];
      if (pip._state !== state) {
        pip.innerHTML = this._heartSVG(state);
        pip._state = state;
      }
    }
  }

  _refreshClock() {
    const sky = this.game && this.game.sky ? this.game.sky : null;
    const t = sky && typeof sky.timeOfDay === 'number' ? sky.timeOfDay : 0.5;
    // Quantize so we only redraw a couple hundred times per in-game day.
    const q = Math.round(t * 240);
    if (q === this._clockState) return;
    this._clockState = q;
    this._drawClock(t);
  }

  // Draw an analog day/night clock. The face dims at night; a sun/moon marker
  // orbits the dial (top = noon, bottom = midnight).
  _drawClock(t) {
    const ctx = this.el.clockCtx;
    if (!ctx) return;
    const S = CLOCK_SIZE;
    const cx = S / 2, cy = S / 2, r = S / 2 - 4;
    ctx.clearRect(0, 0, S, S);

    // Day/night background blend (noon bright, midnight dark).
    const dayAmt = clamp(Math.sin(t * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5, 0, 1);
    const sky = this._mix([22, 30, 54], [120, 180, 240], dayAmt);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${sky[0]},${sky[1]},${sky[2]})`;
    ctx.fill();

    // Dial ring.
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke();

    // Tick marks at the four cardinal times.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const x1 = cx + Math.cos(a) * (r - 2);
      const y1 = cy + Math.sin(a) * (r - 2);
      const x2 = cx + Math.cos(a) * (r - 6);
      const y2 = cy + Math.sin(a) * (r - 6);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // Sun and moon orbit. timeOfDay 0=midnight,0.25=sunrise,0.5=noon,0.75=sunset.
    // Map so the sun is at the top (12 o'clock) at noon.
    const sunAngle = (t - 0.5) * Math.PI * 2 - Math.PI / 2;
    const moonAngle = sunAngle + Math.PI;
    const orbit = r - 10;

    // Moon (behind).
    const mx = cx + Math.cos(moonAngle) * orbit;
    const my = cy + Math.sin(moonAngle) * orbit;
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220,224,236,0.95)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mx + 2, my - 1, 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${sky[0]},${sky[1]},${sky[2]})`; // crescent bite
    ctx.fill();

    // Sun (in front).
    const sx = cx + Math.cos(sunAngle) * orbit;
    const syy = cy + Math.sin(sunAngle) * orbit;
    const grd = ctx.createRadialGradient(sx, syy, 1, sx, syy, 7);
    grd.addColorStop(0, '#fff6c8');
    grd.addColorStop(1, '#ffce54');
    ctx.beginPath();
    ctx.arc(sx, syy, 6, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
  }

  _mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  _refreshInfo() {
    const el = this.el.info;
    if (!el) return;
    const player = this._player();
    const sky = this.game && this.game.sky ? this.game.sky : null;
    const worldgen = this.game && this.game.worldgen ? this.game.worldgen : null;

    if (!player || !player.position) {
      // Before a world exists, keep the panel quiet.
      if (this._lastInfo !== '') {
        el.classList.add('hidden');
        this._lastInfo = '';
      }
      return;
    }
    el.classList.remove('hidden');

    const p = player.position;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);

    let biome = '—';
    if (worldgen && typeof worldgen.biomeAt === 'function') {
      try { biome = prettyBiome(worldgen.biomeAt(x, z)); } catch (_) { biome = '—'; }
    }

    const t = sky && typeof sky.timeOfDay === 'number' ? sky.timeOfDay : 0.5;
    const timeStr = formatTimeOfDay(t);
    const gamemode = player.gamemode || 'survival';

    const html =
      `<div>XYZ <b>${x}</b> ${y} ${z}</div>` +
      `<div>Biome <b>${this._titleCase(biome)}</b></div>` +
      `<div>Time <b>${timeStr}</b></div>` +
      `<div>Mode <b>${this._titleCase(gamemode)}</b></div>`;

    if (html !== this._lastInfo) {
      el.innerHTML = html;
      this._lastInfo = html;
    }
  }

  _refreshDebug(dt) {
    const el = this.el.debug;
    if (!el) return;
    const flags = this.game && this.game.state ? this.game.state.flags : null;
    const on = !!(flags && flags.debug);
    el.classList.toggle('show', on);
    if (!on) return;

    this._debugAccum += dt;
    if (this._debugAccum < 0.2) return;
    this._debugAccum = 0;

    const engine = this.game && this.game.engine ? this.game.engine : null;
    const fps = engine && typeof engine.fps === 'number' ? engine.fps : 0;
    const player = this._player();
    const worldgen = this.game && this.game.worldgen ? this.game.worldgen : null;
    const entities = this.game && this.game.entities ? this.game.entities : null;

    let x = 0, y = 0, z = 0;
    if (player && player.position) { x = player.position.x; y = player.position.y; z = player.position.z; }
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);

    let biome = '—';
    if (worldgen && typeof worldgen.biomeAt === 'function') {
      try { biome = prettyBiome(worldgen.biomeAt(Math.floor(x), Math.floor(z))); } catch (_) {}
    }

    let mobCount = 0, itemCount = 0;
    if (entities) {
      if (Array.isArray(entities.entities)) mobCount = entities.entities.length;
      if (Array.isArray(entities.items)) itemCount = entities.items.length;
    }

    const facing = this._facingFromYaw(player);

    const txt =
      `Voxel Odyssey — debug\n` +
      `fps: ${fps.toFixed(0)}\n` +
      `xyz: ${x.toFixed(2)} / ${y.toFixed(2)} / ${z.toFixed(2)}\n` +
      `block: ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}\n` +
      `chunk: ${cx}, ${cz}\n` +
      `facing: ${facing}\n` +
      `biome: ${biome}\n` +
      `entities: ${mobCount} mobs, ${itemCount} items`;

    if (txt !== this._lastDebug) {
      el.textContent = txt;
      this._lastDebug = txt;
    }
  }

  _facingFromYaw(player) {
    if (!player || typeof player.yaw !== 'number') return '—';
    // Convert yaw to a cardinal direction. With camera.rotation 'YXZ', yaw=0
    // looks toward -Z (north). Quantize to 8 compass points.
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const yaw = player.yaw;
    // Look direction (x = -sin(yaw), z = -cos(yaw)). Angle from north, CW.
    const lx = -Math.sin(yaw), lz = -Math.cos(yaw);
    let ang = Math.atan2(lx, -lz); // 0 = north, +CW toward east
    let idx = Math.round((ang / (Math.PI * 2)) * 8);
    idx = ((idx % 8) + 8) % 8;
    return dirs[idx];
  }

  // Keep the underwater overlay in sync with the player's submersion, without
  // requiring an event each frame. Hurt overlay is event/timer driven only.
  _syncWaterOverlay() {
    const player = this._player();
    if (!player) return;
    // Prefer an explicit eyesUnderWater flag; fall back to inWater.
    let underwater = false;
    if (typeof player.eyesUnderWater === 'boolean') underwater = player.eyesUnderWater;
    else if (typeof player.inWater === 'boolean') underwater = player.inWater;
    if (underwater !== this._overlay.water) {
      this._overlay.water = underwater;
      this._applyOverlay();
    }
  }

  _flashHurt() {
    this._overlay.hurt = true;
    this._hurtTimer = HURT_FLASH_MS / 1000;
    this._applyOverlay();
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  _titleCase(s) {
    s = String(s || '');
    return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Tear down DOM + subscriptions (useful on full teardown / hot reload).
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch (_) {} }
    this._unsubs.length = 0;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    this.slots.length = 0;
    this.pips.length = 0;
  }
}

export default HUD;


/* 'snowy_plains' -> 'Snowy Plains' for display. */
function prettyBiome(name) {
  if (!name) return '—';
  return String(name).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
