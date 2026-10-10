/* =========================================================================
   touch.js — on-screen controls for phones and tablets.

   Layout (landscape):
     left       a movement stick
     right      Mine (hold) / Place / Jump buttons, plus Sneak and (creative)
                Fly toggles
     top right  Inventory and Pause
     anywhere   drag on empty screen to look around
     bottom     tap a hotbar slot to select it (handled by the HUD)

   Everything is routed through Input, so a finger produces exactly the same
   events as keys and a mouse: the stick feeds the move axis, a drag feeds the
   look delta, the Mine and Place buttons press mouse buttons 0 and 2 (so
   mining, attacking and placing are the one code path), and Jump / Sneak are
   virtual keys. Nothing in gameplay knows touch exists.

   The controls only show while actually playing: pausing, opening the
   inventory, dying, or sitting on the title screen hides them so they never
   sit on top of a menu.
   ========================================================================= */

import { isTouchDevice } from '../core/utils.js';

const STICK_RADIUS = 52;     // px of finger travel for full deflection
const STICK_DEAD = 0.12;
const SPRINT_AT = 0.92;      // push the stick this far forward to sprint

export function touchControlsWanted() {
  if (typeof window === 'undefined' || !isTouchDevice()) return false;
  // A touch-screen laptop still has a mouse as its primary pointer.
  if (typeof matchMedia === 'function') {
    if (matchMedia('(pointer: fine)').matches && !matchMedia('(pointer: coarse)').matches) return false;
  }
  return true;
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.root = null;
    this.enabled = false;
    this.visible = false;
    this.el = {};
    this._stickId = null;
    this._lookId = null;
    this._lookX = 0;
    this._lookY = 0;
    this._btn = new Map();       // pointerId -> release callback
  }

  init() {
    const forced = typeof location !== 'undefined' && /[?&]touch=1\b/.test(location.search);
    const off = typeof location !== 'undefined' && /[?&]touch=0\b/.test(location.search);
    this.enabled = !off && (forced || touchControlsWanted());
    if (!this.enabled) return;
    document.body.classList.add('touch');
    this._build();
  }

  /* ---- DOM ------------------------------------------------------------- */

  _mk(tag, attrs, parent) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  _build() {
    const layer = document.getElementById('hud-layer') || document.body;
    const root = this._mk('div', { id: 'touch-controls' }, layer);
    this.root = root;
    // Never let the browser treat a drag as scroll/zoom/long-press.
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Look zone: everything not covered by a control.
    const look = this._mk('div', { id: 'touch-look' }, root);
    this.el.look = look;
    // Touch Events (not Pointer Events) for the two continuous gestures: they
    // report every finger's coordinates reliably on every mobile browser, and
    // the touch that starts on an element keeps targeting it while it drags.
    const opts = { passive: false };
    look.addEventListener('touchstart', (e) => this._lookDown(e), opts);
    look.addEventListener('touchmove', (e) => this._lookMove(e), opts);
    look.addEventListener('touchend', (e) => this._lookUp(e), opts);
    look.addEventListener('touchcancel', (e) => this._lookUp(e), opts);

    // Movement stick.
    const stick = this._mk('div', { id: 'touch-stick', class: 'touch-stick' }, root);
    const nub = this._mk('div', { class: 'nub' }, stick);
    this.el.stick = stick; this.el.nub = nub;
    stick.addEventListener('touchstart', (e) => this._stickDown(e), opts);
    stick.addEventListener('touchmove', (e) => this._stickMove(e), opts);
    stick.addEventListener('touchend', (e) => this._stickUp(e), opts);
    stick.addEventListener('touchcancel', (e) => this._stickUp(e), opts);

    const input = this.game.input;
    // Hold-style buttons: down on press, up on release / cancel.
    this._holdButton('touch-break', 'Mine', (d) => input.touchButton(0, d));
    this._holdButton('touch-place', 'Place', (d) => input.touchButton(2, d));
    this._holdButton('touch-jump', 'Jump', (d) => input.touchAction('jump', d));

    // Sneak is a toggle: holding two buttons while steering is too much.
    const sneak = this._mk('button', { id: 'touch-sneak', class: 'touch-btn small', text: 'Sneak' }, root);
    sneak.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const on = !input.touch.held.has('sneak');
      input.touchAction('sneak', on);
      sneak.classList.toggle('on', on);
    });
    this.el.sneak = sneak;

    const fly = this._mk('button', { id: 'touch-fly', class: 'touch-btn small', text: 'Fly' }, root);
    fly.addEventListener('pointerdown', (e) => { e.preventDefault(); input.touchPulse('fly'); });
    this.el.fly = fly;

    const inv = this._mk('button', { id: 'touch-inv', class: 'touch-btn top', text: 'Bag' }, root);
    inv.addEventListener('pointerdown', (e) => { e.preventDefault(); this.game.menus.toggleInventory(); });
    const pause = this._mk('button', { id: 'touch-pause', class: 'touch-btn top', text: 'II' }, root);
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.game.flow && this.game.flow.openPause) this.game.flow.openPause();
    });
    this.el.inv = inv; this.el.pause = pause;

    root.style.display = 'none';
  }

  _holdButton(id, label, onChange) {
    const b = this._mk('button', { id, class: 'touch-btn', text: label }, this.root);
    const release = (e) => {
      if (!this._btn.has(e.pointerId)) return;
      this._btn.delete(e.pointerId);
      b.classList.remove('on');
      onChange(false);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers can't be captured */ }
      this._btn.set(e.pointerId, release);
      b.classList.add('on');
      onChange(true);
    });
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('lostpointercapture', release);
    return b;
  }

  /* ---- look ------------------------------------------------------------ */

  // The changed touch with this identifier, if the event carries it.
  _find(e, id) {
    for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === id) return e.changedTouches[i];
    return null;
  }

  _lookDown(e) {
    e.preventDefault();
    if (this._lookId !== null) return;
    const t = e.changedTouches[0];
    this._lookId = t.identifier;
    this._lookX = t.clientX; this._lookY = t.clientY;
  }
  _lookMove(e) {
    e.preventDefault();
    const t = this._lookId === null ? null : this._find(e, this._lookId);
    if (!t) return;
    this.game.input.addTouchLook(t.clientX - this._lookX, t.clientY - this._lookY);
    this._lookX = t.clientX; this._lookY = t.clientY;
  }
  _lookUp(e) {
    if (this._lookId !== null && this._find(e, this._lookId)) this._lookId = null;
  }

  /* ---- stick ----------------------------------------------------------- */

  _stickDown(e) {
    e.preventDefault();
    if (this._stickId !== null) return;
    this._stickId = e.changedTouches[0].identifier;
    this._stickMove(e);
  }
  _stickMove(e) {
    e.preventDefault();
    const t = this._stickId === null ? null : this._find(e, this._stickId);
    if (!t) return;
    const r = this.el.stick.getBoundingClientRect();
    let dx = (t.clientX - (r.left + r.width / 2)) / STICK_RADIUS;
    let dy = (t.clientY - (r.top + r.height / 2)) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    // Radial dead zone: nothing until the finger leaves the centre, then a
    // smooth ramp to full speed, so the first sliver of travel is not a jump.
    const m = Math.min(1, len);
    const scale = m < STICK_DEAD ? 0 : (m - STICK_DEAD) / (1 - STICK_DEAD) / m;
    const input = this.game.input;
    input.touch.moveX = dx * scale;
    input.touch.moveY = dy * scale;
    // Fully forward = sprint.
    input.touchAction('sprint', input.touch.moveY < 0 && Math.hypot(input.touch.moveX, input.touch.moveY) >= SPRINT_AT);
    this.el.nub.style.transform = `translate(calc(-50% + ${dx * STICK_RADIUS}px), calc(-50% + ${dy * STICK_RADIUS}px))`;
  }
  _stickUp(e) {
    if (this._stickId === null || !this._find(e, this._stickId)) return;
    this._stickId = null;
    this._resetStick();
  }
  _resetStick() {
    const input = this.game.input;
    input.touch.moveX = 0; input.touch.moveY = 0;
    input.touchAction('sprint', false);
    if (this.el.nub) this.el.nub.style.transform = 'translate(-50%, -50%)';
  }

  /* ---- per-frame ------------------------------------------------------- */

  update() {
    if (!this.enabled || !this.root) return;
    const g = this.game, f = g.state.flags;
    const show = f.mode === 'play' && !f.paused && !f.inventoryOpen && g.worldActive;
    if (show !== this.visible) {
      this.visible = show;
      this.root.style.display = show ? 'block' : 'none';
      g.input.touch.active = show;
      if (!show) {
        // Hidden mid-gesture: nothing may stay held down.
        this._stickId = null; this._lookId = null; this._btn.clear();
        this._resetStick();
        g.input.releaseTouch();
        for (const b of this.root.querySelectorAll('.touch-btn')) b.classList.remove('on');
      }
    }
    if (show && this.el.fly) {
      const creative = !!(g.player && g.player.isCreative);
      this.el.fly.style.display = creative ? '' : 'none';
    }
  }
}

export default TouchControls;
