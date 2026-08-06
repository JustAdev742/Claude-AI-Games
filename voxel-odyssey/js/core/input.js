/* =========================================================================
   input.js — keyboard, mouse, pointer-lock and (optional) touch input.

   Per-frame contract:
     input.isDown(code)        held this frame
     input.justPressed(code)   went down since last frame
     input.justReleased(code)  went up since last frame
     input.action(name)        held, via the configurable binding map
     input.actionPressed(name) pressed this frame, via binding map
     input.mouseDX / mouseDY   accumulated look delta (consumed each frame)
     input.wheel               accumulated wheel delta (consumed each frame)
     input.lateUpdate()        MUST be called at the end of every frame to clear
                               the "just pressed/released" sets and deltas.

   Codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft', ...).
   ========================================================================= */

// How many consecutive pointer-lock refusals before we stop asking. Chrome's
// post-Escape cooldown produces one or two; a genuinely unsupported embedding
// produces them forever.
const MAX_LOCK_FAILURES = 4;

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sneak: ['ShiftLeft', 'ShiftRight'],
  sprint: ['ControlLeft', 'ControlRight'],
  inventory: ['KeyE'],
  drop: ['KeyQ'],
  pause: ['Escape'],
  fly: ['KeyF'],
  debug: ['F3'],
  chat: ['KeyT'],
  perspective: ['F5'],
  screenshot: ['F2'],
  fullscreen: ['F11'],
};

export class Input {
  constructor(canvas, events, state) {
    this.canvas = canvas;
    this.events = events;
    this.state = state;
    this.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));

    this._down = new Set();
    this._pressed = new Set();
    this._released = new Set();

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.buttons = new Set();       // mouse buttons currently held (0,1,2)
    this._buttonPressed = new Set();
    this._buttonReleased = new Set();

    this.locked = false;
    this.enabled = true;            // when false (menus), gameplay input is ignored

    // Some embeddings (sandboxed iframes without allow="pointer-lock") refuse
    // the Pointer Lock API. `virtualLock` is our fallback: we hide the cursor
    // and steer with raw mousemove deltas instead, so looking around still works.
    this.virtualLock = false;
    // Consecutive pointer-lock refusals. Reset on any successful lock, so a
    // temporary refusal never permanently disables real mouse look.
    this._lockFailures = 0;
    this._lockRetry = null;

    // Edge-turn state for the fallback: without pointer lock the cursor stops
    // at the window border, so looking is capped by screen width. Steering
    // continues while the pointer rests near an edge.
    this._edgeTurn = 0;
    this._pointerX = 0;
    this._pointerY = 0;

    this.touch = { mx: 0, my: 0, jump: false, place: false, break: false, active: false };

    // Gamepad state, refreshed each frame from the Gamepad API. Sticks are
    // reported as axis positions, not deltas, so look is applied as a RATE
    // (radians/sec) rather than accumulated into mouseDX — holding a stick
    // half-deflected should turn steadily, not accelerate.
    this.gamepad = {
      connected: false,
      moveX: 0, moveZ: 0,
      lookX: 0, lookZ: 0,
      buttons: new Set(),
      _prevButtons: new Set(),
      index: -1,
    };

    // Smoothed look deltas (see settings.lookSmoothing).
    this._smoothDX = 0;
    this._smoothDY = 0;

    this._bind();
  }

  /* ---- event wiring ---- */
  _bind() {
    this._onKeyDown = (e) => {
      // Let the browser handle text fields if any are focused.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
      // Prevent the page from scrolling on space / arrows during play.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'F3' || e.code === 'F5' || e.code === 'F2') e.preventDefault();
      // Take F11 ourselves so fullscreen goes through toggleFullscreen(),
      // which re-acquires pointer lock afterwards. Browsers still honour
      // their own F11 in some configurations, which is why fullscreenchange
      // is handled independently rather than relying on this.
      if (e.code === 'F11') e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    };
    this._onBlur = () => { this._down.clear(); this.buttons.clear(); };

    this._onMouseDown = (e) => {
      // While locked (real pointer lock OR the fallback), every button press
      // belongs to the game no matter what element it lands on. The old
      // canvas-only binding silently ate clicks in the fallback: the cursor is
      // hidden but still moves, so once it drifted over the hotbar or HUD,
      // right-clicks stopped reaching the game with no visible reason why.
      if (!this.locked && e.target !== this.canvas) return;
      if (this.locked && e.button === 2) e.preventDefault();
      this.buttons.add(e.button);
      this._buttonPressed.add(e.button);
    };
    this._onMouseUp = (e) => {
      this.buttons.delete(e.button);
      this._buttonReleased.add(e.button);
    };
    this._onMouseMove = (e) => {
      this._pointerX = e.clientX;
      this._pointerY = e.clientY;
      if (!this.locked) return;

      // With REAL pointer lock the cursor is captured, so every movement event
      // is legitimately ours no matter what it reports as its target.
      //
      // In the fallback there is a real cursor loose on the page, and this
      // listener is on `window` — so moving the mouse over a menu, the HUD, or
      // off the canvas entirely still rotated the camera. Restricting the
      // fallback to movement actually over the canvas is what stops the view
      // spinning from mouse activity outside the game.
      if (this.virtualLock && e.target !== this.canvas) return;

      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onWheel = (e) => {
      this.wheel += Math.sign(e.deltaY);
      if (this.locked) e.preventDefault();
    };
    this._onContext = (e) => e.preventDefault();
    this._onPointerLockChange = () => {
      const real = document.pointerLockElement === this.canvas;
      if (real) {
        // Real lock is working — leave the fallback and forget past failures.
        this._lockFailures = 0;
        if (this.virtualLock) {
          this.virtualLock = false;
          this.canvas.classList.remove('virtual-lock');
        }
      } else if (this.virtualLock) {
        return;   // the real API isn't the one steering us
      }
      this._setLocked(real);
    };
    this._onPointerLockError = () => this._onLockFailed();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContext);
    // While locked, the browser context menu must never open regardless of
    // which element the invisible fallback cursor happens to be over.
    this._onWindowContext = (e) => { if (this.locked) e.preventDefault(); };
    window.addEventListener('contextmenu', this._onWindowContext);
    this._onFullscreenChange = () => {
      const fs = !!document.fullscreenElement;
      if (this.events) this.events.emit('fullscreen', { active: fs });

      // Browsers drop pointer lock as part of the fullscreen transition. If we
      // don't re-take it the game silently falls back to cursor-bound look,
      // where the mouse escapes the window and keeps steering the camera —
      // and, because aiming drives block placement, blocks land wherever the
      // stray cursor dragged the view.
      //
      // The lock request must wait for the transition to settle; issuing it
      // in the same task is refused by Chrome.
      if (this._fsRelock) clearTimeout(this._fsRelock);
      this._fsRelock = setTimeout(() => {
        this._fsRelock = null;
        const flags = this.state && this.state.flags;
        if (!flags || flags.mode !== 'play' || flags.paused || flags.inventoryOpen) return;
        this._lockFailures = 0;   // a fullscreen change is a fresh start
        this.requestLock();
      }, 120);
    };

    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
  }

  /* ---- fullscreen ------------------------------------------------------ */
  get isFullscreen() {
    return typeof document !== 'undefined' && !!document.fullscreenElement;
  }

  /**
   * Toggle fullscreen on the game's container.
   *
   * Requested on the canvas's PARENT rather than the canvas itself: a
   * fullscreen <canvas> takes the HUD and menus out of the visible tree,
   * because they are siblings, not children. Promoting the container keeps
   * the whole UI on screen.
   */
  async toggleFullscreen() {
    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const target = (this.canvas && this.canvas.parentElement) || document.documentElement;
        await target.requestFullscreen();
        // Pointer lock is re-taken by the fullscreenchange handler above.
      }
    } catch (err) {
      // Fullscreen needs a user gesture and can be refused by policy; a
      // failure must not take the input system down with it.
      console.warn('fullscreen request refused', err && err.message);
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('contextmenu', this._onWindowContext);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
    if (this._fsRelock) { clearTimeout(this._fsRelock); this._fsRelock = null; }
    if (this._lockRetry) { clearTimeout(this._lockRetry); this._lockRetry = null; }
  }

  /* ---- pointer lock ---- */
  _setLocked(locked) {
    if (this.locked === locked) return;
    this.locked = locked;
    if (this.state) this.state.setFlag('pointerLocked', locked);
    if (this.events) this.events.emit('pointerlock', { locked, virtual: this.virtualLock });
  }

  // Fall back to cursor-hidden mousemove steering when real pointer lock is
  // denied, so the player can still look around. This is a fallback, not a
  // verdict: requestLock keeps retrying the real API.
  _useVirtualLock() {
    this.virtualLock = true;
    this.canvas.classList.add('virtual-lock');
    this._setLocked(true);
  }

  requestLock() {
    if (!this.canvas.requestPointerLock) { this._useVirtualLock(); return; }

    // Browsers rate-limit pointer lock: re-requesting within about a second of
    // an Escape-driven exit fails with pointerlockerror even though the API is
    // perfectly available. Treating that transient refusal as "unsupported"
    // permanently downgraded the whole session to cursor-bound look, which is
    // what made looking around feel restricted after the first pause.
    // Only give up after several consecutive failures, and recover the moment
    // a real lock succeeds.
    if (this._lockFailures >= MAX_LOCK_FAILURES) { this._useVirtualLock(); return; }

    let p;
    try {
      p = this.canvas.requestPointerLock();
    } catch (e) {
      this._onLockFailed();
      return;
    }
    if (p && typeof p.catch === 'function') p.catch(() => this._onLockFailed());
  }

  _onLockFailed() {
    this._lockFailures++;
    // Fall back for now so the player can still look around, but keep trying
    // the real API on subsequent clicks.
    this._useVirtualLock();
    // A refusal caused by the browser's cooldown clears on its own; schedule a
    // retry rather than waiting for another click.
    if (this._lockRetry) clearTimeout(this._lockRetry);
    this._lockRetry = setTimeout(() => {
      this._lockRetry = null;
      if (this.virtualLock && this.state && this.state.flags && this.state.flags.mode === 'play'
        && !this.state.flags.paused && !this.state.flags.inventoryOpen) {
        this.requestLock();
      }
    }, 1200);
  }

  exitLock() {
    if (this.virtualLock) {
      this.virtualLock = false;
      this.canvas.classList.remove('virtual-lock');
      this._setLocked(false);
      return;
    }
    if (document.exitPointerLock) document.exitPointerLock();
  }

  /* ---- queries ---- */
  isDown(code) { return this._down.has(code); }
  justPressed(code) { return this._pressed.has(code); }
  justReleased(code) { return this._released.has(code); }

  _anyDown(codes) { for (const c of codes) if (this._down.has(c)) return true; return false; }
  _anyPressed(codes) { for (const c of codes) if (this._pressed.has(c)) return true; return false; }

  action(name) {
    const codes = this.bindings[name];
    return codes ? this._anyDown(codes) : false;
  }
  actionPressed(name) {
    const codes = this.bindings[name];
    return codes ? this._anyPressed(codes) : false;
  }
  setBinding(name, codes) { this.bindings[name] = codes; }

  /* Overlay the player's saved rebinds onto the defaults. Only overridden
     actions are stored, so a build that adds a new action still gets its
     default binding instead of an undefined one. */
  applyBindings(custom) {
    this.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
    if (!custom) return;
    for (const [action, codes] of Object.entries(custom)) {
      if (Array.isArray(codes) && codes.length) this.bindings[action] = codes.slice();
    }
  }

  defaultBindings() { return JSON.parse(JSON.stringify(DEFAULT_BINDINGS)); }

  /* Which action, if any, already uses this key — so the rebind UI can warn
     about a conflict instead of silently creating one. */
  actionUsing(code, exceptAction) {
    for (const [action, codes] of Object.entries(this.bindings)) {
      if (action === exceptAction) continue;
      if (codes.includes(code)) return action;
    }
    return null;
  }

  mouseDown(button) { return this.buttons.has(button); }
  mousePressed(button) { return this._buttonPressed.has(button); }
  mouseReleased(button) { return this._buttonReleased.has(button); }

  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  /* ---- movement axis helper (-1..1) ---- */
  moveAxis() {
    let x = 0, z = 0;
    if (this.action('right')) x += 1;
    if (this.action('left')) x -= 1;
    if (this.action('back')) z += 1;
    if (this.action('forward')) z -= 1;
    // include touch joystick
    x += this.touch.mx; z += this.touch.my;
    // ...and the gamepad's left stick. Added rather than replacing, so a
    // player can use stick and keys together without either winning.
    x += this.gamepad.moveX; z += this.gamepad.moveZ;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  /* ---- gamepad ---------------------------------------------------------
     Polled, not event-driven: the Gamepad API only exposes state snapshots,
     and browsers deliberately don't fire events for stick motion. */
  pollGamepad(settings) {
    const gp = this.gamepad;
    gp.moveX = 0; gp.moveZ = 0; gp.lookX = 0; gp.lookZ = 0;

    if (!settings || settings.gamepadEnabled === false) { gp.connected = false; return; }
    if (typeof navigator === 'undefined' || !navigator.getGamepads) { gp.connected = false; return; }

    const pads = navigator.getGamepads();
    let pad = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    if (!pad) {
      gp.connected = false;
      gp._prevButtons = gp.buttons;
      gp.buttons = new Set();
      return;
    }

    gp.connected = true;
    gp.index = pad.index;

    // Radial deadzone, not per-axis: clamping each axis independently makes
    // diagonal input snap to the axes near the centre.
    const dz = settings.gamepadDeadzone != null ? settings.gamepadDeadzone : 0.18;
    const applyDeadzone = (x, y) => {
      const mag = Math.hypot(x, y);
      if (mag < dz) return [0, 0];
      // Rescale so movement starts at zero just outside the deadzone rather
      // than jumping straight to `dz` worth of speed.
      const scaled = (mag - dz) / (1 - dz);
      return [(x / mag) * scaled, (y / mag) * scaled];
    };

    const [lx, ly] = applyDeadzone(pad.axes[0] || 0, pad.axes[1] || 0);
    gp.moveX = lx; gp.moveZ = ly;

    const [rx, ry] = applyDeadzone(pad.axes[2] || 0, pad.axes[3] || 0);
    // Squared response curve: fine aim near centre, fast turns at full tilt.
    gp.lookX = rx * Math.abs(rx);
    gp.lookZ = ry * Math.abs(ry);

    gp._prevButtons = gp.buttons;
    gp.buttons = new Set();
    for (let i = 0; i < pad.buttons.length; i++) {
      if (pad.buttons[i] && pad.buttons[i].pressed) gp.buttons.add(i);
    }
  }

  // Standard-layout button indices, named so callers read clearly.
  padDown(button) { return this.gamepad.buttons.has(button); }
  padPressed(button) { return this.gamepad.buttons.has(button) && !this.gamepad._prevButtons.has(button); }

  /* Extra turn rate contributed by the pointer resting near a window edge.
     Only used in the fallback: with real pointer lock the cursor is captured
     and can never reach an edge, but without it the cursor stops at the
     border and you simply cannot turn any further. Pushing against the edge
     keeps turning, which restores unlimited rotation.
     Returns radians/sec (x = yaw, y = pitch). */
  edgeTurn() {
    if (!this.virtualLock || !this.locked) return { x: 0, y: 0 };
    if (typeof window === 'undefined') return { x: 0, y: 0 };

    const w = window.innerWidth, h = window.innerHeight;
    const margin = Math.max(40, Math.min(140, w * 0.08));
    const ramp = (dist) => {
      // 0 at the margin's inner edge, 1 hard against the border.
      if (dist >= margin) return 0;
      const t = 1 - dist / margin;
      return t * t;   // eased, so drifting near the edge doesn't yank the view
    };

    let x = 0, y = 0;
    x -= ramp(this._pointerX);
    x += ramp(w - this._pointerX);
    y -= ramp(this._pointerY);
    y += ramp(h - this._pointerY);

    const SPEED = 2.4;
    return { x: x * SPEED, y: y * SPEED };
  }

  /* Smoothed look delta for this frame. Smoothing is an exponential blend
     toward the raw delta; at 0 it returns the raw value unchanged so the
     default path is exactly 1:1 with the mouse. */
  lookDelta(smoothing) {
    const raw = { dx: this.mouseDX || 0, dy: this.mouseDY || 0 };
    const s = Math.max(0, Math.min(0.95, smoothing || 0));
    if (s <= 0) { this._smoothDX = raw.dx; this._smoothDY = raw.dy; return raw; }
    this._smoothDX = this._smoothDX * s + raw.dx * (1 - s);
    this._smoothDY = this._smoothDY * s + raw.dy * (1 - s);
    return { dx: this._smoothDX, dy: this._smoothDY };
  }

  /* ---- per-frame cleanup ---- */
  lateUpdate() {
    this._pressed.clear();
    this._released.clear();
    this._buttonPressed.clear();
    this._buttonReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}

export default Input;
