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

    this.touch = { mx: 0, my: 0, jump: false, place: false, break: false, active: false };

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
    };
    this._onKeyUp = (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    };
    this._onBlur = () => { this._down.clear(); this.buttons.clear(); };

    this._onMouseDown = (e) => {
      this.buttons.add(e.button);
      this._buttonPressed.add(e.button);
    };
    this._onMouseUp = (e) => {
      this.buttons.delete(e.button);
      this._buttonReleased.add(e.button);
    };
    this._onMouseMove = (e) => {
      if (this.locked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    };
    this._onWheel = (e) => {
      this.wheel += Math.sign(e.deltaY);
      if (this.locked) e.preventDefault();
    };
    this._onContext = (e) => e.preventDefault();
    this._onPointerLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.state) this.state.setFlag('pointerLocked', this.locked);
      if (this.events) this.events.emit('pointerlock', { locked: this.locked });
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }

  /* ---- pointer lock ---- */
  requestLock() {
    if (this.canvas.requestPointerLock) {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }
  exitLock() {
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
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
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
