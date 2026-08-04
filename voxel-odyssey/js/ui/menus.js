/* =========================================================================
   menus.js — every full-screen / overlay UI surface that is not the in-game
   HUD: the title screen, the pause menu, settings, the death screen, the
   "how to play" controls reference, and the inventory + crafting screen.

   All DOM is injected into the existing `#menu-layer` element and styled with
   the classes already defined in styles.css (.menu-overlay / .menu-panel /
   .btn / .setting / .toggle / .slot / .inv-grid / .craft-grid / #tooltip /
   #drag-ghost). We never create files or pull external assets — item/block
   icons are drawn into <canvas> elements with the shared `Items.drawIcon`.

   Flow buttons stay decoupled from the rest of the game by EMITTING events
   that main.js listens for:
       'game:new'      { seed, gamemode }
       'game:continue' {}
       'game:save'     {}
       'game:quit'     {}
       'game:respawn'  {}

   Settings controls write straight through to `game.state.set(key, value)`,
   which persists and fires 'settings:change' for the systems that care
   (World reads renderDistance each frame; Engine/Sky/Audio listen to the
   event). FOV is additionally pushed to `engine.setFov` for an instant
   response.

   Opening any menu releases the pointer lock (`input.exitLock`). Closing the
   inventory while a world is being played re-requests the lock so the player
   can immediately look around again. `state.flags.inventoryOpen` is kept in
   sync so main.js's pointer-lock logic does not fight the inventory.
   ========================================================================= */

import Items from '../items/items.js';
import { DEFAULT_SETTINGS } from '../core/state.js';
import { clamp } from '../core/utils.js';

const ICON_SIZE = 40;        // px the item icon canvases are rendered at
const HOTBAR_COUNT = 9;      // slots 0..8
const MAIN_COUNT = 27;       // slots 9..35

export class Menus {
  constructor(game) {
    this.game = game || null;

    // The layer we inject into, resolved in init().
    this.layer = null;

    // The single overlay currently shown (or null). Generic menus reuse one
    // overlay element; the inventory has its own dedicated overlay so its
    // heavier DOM can be reused without rebuilding every open.
    this.overlay = null;
    this.current = null;     // 'main' | 'pause' | 'settings' | 'death' | 'controls' | 'inventory' | null

    // Floating helpers shared by every screen.
    this.tooltip = null;
    this.dragGhost = null;

    // Inventory state ----------------------------------------------------
    this.invOpen = false;
    this.craftingTable = false;          // 3×3 grid when true, else 2×2
    this.craftGrid = new Array(9).fill(null);   // item keys | null (row-major)
    this.cursor = null;                  // stack held "on the cursor": {id,count}|null

    // Cached references to live DOM we refresh frequently (inventory only).
    this._invEls = null;

    // Bound listeners we attach on open and remove on close.
    this._onMouseMove = (e) => this._handlePointer(e);
    this._onInvChange = () => { if (this.invOpen) this._refreshInventory(); };
  }

  /* =====================================================================
     Lifecycle
     ===================================================================== */

  init() {
    if (typeof document === 'undefined') return this;   // headless guard
    this.layer = document.getElementById('menu-layer');
    if (!this.layer) {
      // Be defensive: create the layer if the host page lacks it.
      this.layer = document.createElement('div');
      this.layer.id = 'menu-layer';
      this.layer.className = 'ui-layer';
      (document.body || document.documentElement).appendChild(this.layer);
    }

    // Tooltip element — lives at the document level so it can escape overflow.
    this.tooltip = document.getElementById('tooltip') || this._make('div', { id: 'tooltip' });
    this.tooltip.innerHTML = '<div class="t-name"></div><div class="t-desc"></div>';
    if (!this.tooltip.parentNode) document.body.appendChild(this.tooltip);

    // Drag ghost — the icon that follows the cursor while moving a stack.
    this.dragGhost = document.getElementById('drag-ghost') || this._make('div', { id: 'drag-ghost' });
    this.dragGhost.innerHTML = '';
    const ghostCanvas = document.createElement('canvas');
    ghostCanvas.width = ghostCanvas.height = ICON_SIZE;
    const ghostCount = document.createElement('span');
    ghostCount.className = 'count';
    this.dragGhost.appendChild(ghostCanvas);
    this.dragGhost.appendChild(ghostCount);
    this._ghostCanvas = ghostCanvas;
    this._ghostCount = ghostCount;
    if (!this.dragGhost.parentNode) document.body.appendChild(this.dragGhost);

    return this;
  }

  // True while any overlay is on screen.
  isOpen() { return !!this.current; }

  // Optional per-frame hook (tooltip following, cursor ghost positioning are
  // event-driven, so this is a no-op but kept for the contract & future use).
  update(dt) { /* intentionally empty; UI is event-driven */ }

  /* =====================================================================
     Small DOM helpers
     ===================================================================== */

  _make(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k === 'id') el.id = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      } else if (attrs[k] != null) {
        el.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) if (c) el.appendChild(c);
    return el;
  }

  _button(label, opts = {}) {
    const cls = 'btn' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : '') +
      (opts.row ? ' row' : '') + (opts.small ? ' small' : '');
    return this._make('button', {
      class: cls, text: label,
      onClick: (e) => { this._clickSfx(); if (opts.onClick) opts.onClick(e); },
    });
  }

  _clickSfx() {
    const g = this.game;
    if (g && g.events) g.events.emit('sfx', { name: 'click', opts: {} });
  }

  _emit(name, payload) {
    const g = this.game;
    if (g && g.events) g.events.emit(name, payload || {});
  }

  // Build (or reuse) the shared full-screen overlay used by simple menus.
  _ensureOverlay(fullscreen) {
    // Remove any existing simple overlay first so screens don't stack.
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = this._make('div', {
      class: 'menu-overlay' + (fullscreen ? ' fullscreen' : ''),
    });
    this.layer.appendChild(this.overlay);
    return this.overlay;
  }

  // Clear the simple overlay and reset menu state (does NOT touch inventory).
  _clearOverlay() {
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
  }

  /* =====================================================================
     Public: hide everything
     ===================================================================== */

  hide() {
    // Closing the inventory has extra side-effects (pointer lock, flags), so
    // route through the inventory closer when that is what is open.
    if (this.current === 'inventory') {
      this._closeInventory();
      return;
    }
    this._clearOverlay();
    this.current = null;
    this._hideTooltip();
  }

  /* =====================================================================
     Main menu (title screen)
     ===================================================================== */

  /* Multiplayer join screen. Defaults to the origin the page was served from,
     because the game server also serves the game — so someone who opened a
     friend's link can just press Join without knowing what a WebSocket URL is. */
  showMultiplayer() {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this._dismissInventoryIfOpen();
    this.current = 'multiplayer';

    const ov = this._ensureOverlay(true);
    const panel = this._make('div', { class: 'menu-panel center-stack' });
    panel.appendChild(this._make('h2', { text: 'Join Multiplayer' }));
    panel.appendChild(this._make('p', {
      class: 'subtitle',
      text: 'Connect to a Voxel Odyssey server. Run one with: node server/index.js',
    }));

    const store = (this.game && this.game.state && this.game.state.settings) || {};
    const defaultUrl = (() => {
      if (store.serverUrl) return store.serverUrl;
      if (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) {
        return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
      }
      return 'ws://localhost:8090';
    })();

    panel.appendChild(this._make('div', { class: 'section-title', text: 'SERVER' }));
    const urlInput = this._make('input', {
      class: 'select', type: 'text', value: defaultUrl,
      style: 'width:100%; margin-bottom:8px;',
    });
    panel.appendChild(urlInput);

    panel.appendChild(this._make('div', { class: 'section-title', text: 'NAME' }));
    const nameInput = this._make('input', {
      class: 'select', type: 'text', placeholder: 'Player',
      value: store.playerName || '',
      style: 'width:100%; margin-bottom:8px;',
    });
    panel.appendChild(nameInput);

    const statusLine = this._make('p', { class: 'subtitle', text: '' });
    panel.appendChild(statusLine);

    const joinBtn = this._button('Join Server', {
      onClick: async () => {
        const url = urlInput.value.trim();
        const name = nameInput.value.trim() || 'Player';
        if (!url) { statusLine.textContent = 'Enter a server address.'; return; }
        joinBtn.disabled = true;
        statusLine.textContent = `Connecting to ${url}…`;
        try {
          if (this.game.state && this.game.state.set) {
            this.game.state.set('serverUrl', url);
            this.game.state.set('playerName', name);
          }
          await this._emitJoin(url, name);
        } catch (err) {
          statusLine.textContent = err.message || 'Could not connect.';
          joinBtn.disabled = false;
        }
      },
    });
    panel.appendChild(joinBtn);
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Back', { onClick: () => this.showMainMenu() }));

    ov.appendChild(panel);
  }

  // Kept separate so the connect promise can be awaited by the caller and any
  // failure surfaces in the dialog rather than only in the console.
  _emitJoin(url, name) {
    return new Promise((resolve, reject) => {
      this._emit('game:join', { url, name, resolve, reject });
    });
  }

  showMainMenu() {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this._dismissInventoryIfOpen();
    this.current = 'main';

    const ov = this._ensureOverlay(true);
    const panel = this._make('div', { class: 'menu-panel center-stack' });

    panel.appendChild(this._make('h1', { html: 'VOXEL <span style="color:var(--accent)">ODYSSEY</span>' }));
    panel.appendChild(this._make('p', { class: 'subtitle', text: 'A cozy little voxel sandbox. Dig, build, and explore.' }));

    // --- New World controls: seed input + gamemode select ---------------
    panel.appendChild(this._make('div', { class: 'section-title', text: 'NEW WORLD' }));

    const seedInput = this._make('input', {
      class: 'select', type: 'text', placeholder: 'Seed (leave blank for random)',
      style: 'width:100%; margin-bottom:8px;',
    });

    const gamemodeSel = this._make('select', { class: 'select', style: 'width:100%;' });
    gamemodeSel.appendChild(this._make('option', { value: 'survival', text: 'Survival — mine, craft, survive' }));
    gamemodeSel.appendChild(this._make('option', { value: 'creative', text: 'Creative — fly & build freely' }));
    // Default to the last-used gamemode from settings.
    const lastMode = this.game && this.game.state ? this.game.state.get('gamemode') : 'survival';
    gamemodeSel.value = (lastMode === 'creative') ? 'creative' : 'survival';

    const seedRow = this._make('div', { style: 'margin-bottom:10px;' }, [seedInput, gamemodeSel]);
    panel.appendChild(seedRow);

    panel.appendChild(this._button('Create World', {
      primary: true,
      onClick: () => {
        const raw = (seedInput.value || '').trim();
        const gamemode = gamemodeSel.value === 'creative' ? 'creative' : 'survival';
        // Remember the chosen gamemode for next time.
        if (this.game && this.game.state) this.game.state.set('gamemode', gamemode);
        // Pass the seed through as a string (worldgen/main hashes blanks to random).
        this._emit('game:new', { seed: raw.length ? raw : null, gamemode });
      },
    }));

    // --- Continue (only if a save exists) -------------------------------
    const hasSave = this.game && this.game.state && typeof this.game.state.hasSave === 'function'
      ? this.game.state.hasSave() : false;
    if (hasSave) {
      panel.appendChild(this._make('hr', { class: 'sep' }));
      panel.appendChild(this._button('Continue', {
        onClick: () => this._emit('game:continue', {}),
      }));
    }

    // --- Multiplayer ------------------------------------------------------
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Join Multiplayer', {
      onClick: () => this.showMultiplayer(),
    }));

    // --- Secondary actions ----------------------------------------------
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Settings', { onClick: () => this.showSettings('main') }));
    panel.appendChild(this._button('How to Play', { onClick: () => this.showControls('main') }));
    panel.appendChild(this._button('Credits', { onClick: () => this._showCredits('main') }));

    ov.appendChild(panel);
  }

  /* =====================================================================
     Pause menu
     ===================================================================== */

  showPause() {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this.current = 'pause';

    const ov = this._ensureOverlay(false);
    const panel = this._make('div', { class: 'menu-panel center-stack' });

    panel.appendChild(this._make('h1', { text: 'Paused' }));
    panel.appendChild(this._make('p', { class: 'subtitle', text: 'The world waits patiently for you.' }));

    panel.appendChild(this._button('Resume', {
      primary: true,
      onClick: () => this._resumeFromPause(),
    }));
    panel.appendChild(this._button('Settings', { onClick: () => this.showSettings('pause') }));
    panel.appendChild(this._button('How to Play', { onClick: () => this.showControls('pause') }));
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Save & Quit to Title', {
      danger: true,
      onClick: () => {
        // Persist first, then let main return to the title screen.
        this._emit('game:save', {});
        this._emit('game:quit', {});
      },
    }));

    ov.appendChild(panel);
  }

  // Resume gameplay from the pause overlay (close menu + re-grab the mouse).
  _resumeFromPause() {
    this._clearOverlay();
    this.current = null;
    this._hideTooltip();
    const g = this.game;
    if (g && g.input && typeof g.input.requestLock === 'function') g.input.requestLock();
  }

  /* =====================================================================
     Settings
     ===================================================================== */

  // `back` controls where the "Back" button returns: 'main' | 'pause'.
  showSettings(back = 'main') {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    const fullscreen = back === 'main';
    this.current = 'settings';

    const ov = this._ensureOverlay(fullscreen);
    const panel = this._make('div', { class: 'menu-panel' });
    panel.appendChild(this._make('h1', { text: 'Settings' }));
    panel.appendChild(this._make('p', { class: 'subtitle', text: 'Tune the experience. Changes apply instantly and are saved.' }));

    // ---- Display -------------------------------------------------------
    panel.appendChild(this._make('h2', { text: 'Display' }));
    panel.appendChild(this._slider('renderDistance', 'Render Distance', 2, 12, 1, (v) => `${v} chunks`));
    panel.appendChild(this._slider('fov', 'Field of View', 50, 110, 1, (v) => `${v}°`, (v) => {
      // FOV needs an immediate engine update beyond the settings event.
      const g = this.game;
      if (g && g.engine && typeof g.engine.setFov === 'function') g.engine.setFov(v);
    }));
    panel.appendChild(this._slider('daylightSpeed', 'Daylight Speed', 0, 4, 0.1, (v) => `${v.toFixed(1)}×`));
    panel.appendChild(this._toggle('fancyGraphics', 'Fancy Graphics (AO + clouds)'));
    panel.appendChild(this._toggle('viewBobbing', 'View Bobbing'));

    // ---- Controls ------------------------------------------------------
    panel.appendChild(this._make('h2', { text: 'Controls' }));
    panel.appendChild(this._slider('mouseSensitivity', 'Mouse Sensitivity', 0.1, 3, 0.05, (v) => `${v.toFixed(2)}×`));
    panel.appendChild(this._toggle('invertY', 'Invert Mouse Y'));

    // ---- Audio ---------------------------------------------------------
    panel.appendChild(this._make('h2', { text: 'Audio' }));
    panel.appendChild(this._slider('masterVolume', 'Master Volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
    panel.appendChild(this._slider('sfxVolume', 'Sound Effects', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
    panel.appendChild(this._slider('musicVolume', 'Music', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));

    // ---- Footer --------------------------------------------------------
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Customise Controls…', {
      onClick: () => this.showKeybinds(back),
    }));

    const footer = this._make('div', { class: 'row' });
    footer.appendChild(this._button('Reset to Defaults', {
      small: true, row: true,
      onClick: () => this._resetSettings(back),
    }));
    footer.appendChild(this._make('div', { class: 'spacer' }));
    footer.appendChild(this._button('Back', {
      row: true,
      onClick: () => this._settingsBack(back),
    }));
    panel.appendChild(footer);

    ov.appendChild(panel);
  }

  _settingsBack(back) {
    if (back === 'pause') this.showPause();
    else this.showMainMenu();
  }

  _resetSettings(back) {
    const g = this.game;
    if (g && g.state && typeof g.state.resetSettings === 'function') {
      g.state.resetSettings();
      // Re-apply FOV explicitly since the bulk reset uses a wildcard event.
      if (g.engine && typeof g.engine.setFov === 'function') {
        g.engine.setFov(g.state.get('fov'));
      }
    }
    // Rebuild the settings screen so every control shows the new value.
    this.showSettings(back);
  }

  // Current value for a setting key, falling back to the documented default.
  _settingValue(key) {
    const g = this.game;
    if (g && g.state && g.state.settings && g.state.settings[key] !== undefined) {
      return g.state.settings[key];
    }
    return DEFAULT_SETTINGS[key];
  }

  // Build a labelled range slider bound to a settings key.
  _slider(key, label, min, max, step, fmt, extraApply) {
    const wrap = this._make('div', { class: 'setting' });
    const val0 = Number(this._settingValue(key));
    const labelRow = this._make('label');
    labelRow.appendChild(this._make('span', { text: label }));
    const valSpan = this._make('span', { class: 'val', text: fmt ? fmt(val0) : String(val0) });
    labelRow.appendChild(valSpan);
    wrap.appendChild(labelRow);

    const input = this._make('input', {
      type: 'range', min: String(min), max: String(max), step: String(step),
    });
    input.value = String(val0);

    const apply = () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = val0;
      v = clamp(v, min, max);
      // Integer-valued settings should stay integers.
      if (step >= 1 && Number.isInteger(step)) v = Math.round(v);
      valSpan.textContent = fmt ? fmt(v) : String(v);
      const g = this.game;
      if (g && g.state && typeof g.state.set === 'function') g.state.set(key, v);
      if (extraApply) extraApply(v);
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
    wrap.appendChild(input);
    return wrap;
  }

  // Build a toggle (on/off pill) bound to a boolean settings key.
  _toggle(key, label) {
    const on0 = !!this._settingValue(key);
    const toggle = this._make('div', {
      class: 'setting toggle' + (on0 ? ' on' : ''),
      style: 'cursor:pointer;',
    });
    const box = this._make('span', { class: 'box' });
    const text = this._make('span', { text: label });
    toggle.appendChild(box);
    toggle.appendChild(text);

    toggle.addEventListener('click', () => {
      const next = !toggle.classList.contains('on');
      toggle.classList.toggle('on', next);
      const g = this.game;
      if (g && g.state && typeof g.state.set === 'function') g.state.set(key, next);
      this._clickSfx();
    });
    return toggle;
  }

  /* =====================================================================
     Death screen
     ===================================================================== */

  showDeath() {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this._dismissInventoryIfOpen();
    this.current = 'death';

    const ov = this._ensureOverlay(false);
    const panel = this._make('div', { class: 'menu-panel center-stack' });

    panel.appendChild(this._make('h1', { class: 'death-title', text: 'You Died' }));

    // Pull a few run stats if available.
    const stats = (this.game && this.game.state && this.game.state.stats) || {};
    const lines = [
      ['Blocks mined', stats.blocksMined || 0],
      ['Blocks placed', stats.blocksPlaced || 0],
      ['Mobs defeated', stats.mobsDefeated || 0],
      ['Deaths', stats.deaths || 0],
    ];
    const statBox = this._make('div', { class: 'big-stat' });
    for (const [k, v] of lines) {
      statBox.appendChild(this._make('div', { class: 'kv', html: `<span>${k}</span><span>${v}</span>` }));
    }
    panel.appendChild(statBox);

    panel.appendChild(this._button('Respawn', {
      primary: true,
      onClick: () => {
        this._clearOverlay();
        this.current = null;
        this._emit('game:respawn', {});
        const g = this.game;
        if (g && g.input && typeof g.input.requestLock === 'function') g.input.requestLock();
      },
    }));
    panel.appendChild(this._button('Quit to Title', {
      onClick: () => this._emit('game:quit', {}),
    }));

    ov.appendChild(panel);
  }

  /* =====================================================================
     Controls / How to Play
     ===================================================================== */

  /* Key rebinding screen. Clicking an action arms a one-shot capture of the
     next keypress; a key already used elsewhere is reported rather than
     silently double-bound, since a duplicate binding is very hard to diagnose
     from inside the game. */
  showKeybinds(back = 'pause') {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this.current = 'keybinds';

    const input = this.game.input;
    const state = this.game.state;
    const ov = this._ensureOverlay(back === 'main');
    const panel = this._make('div', { class: 'menu-panel' });
    panel.appendChild(this._make('h2', { text: 'Controls' }));

    const hint = this._make('p', { class: 'subtitle', text: 'Click a binding, then press a key. Esc cancels.' });
    panel.appendChild(hint);

    const ACTIONS = [
      ['forward', 'Move forward'], ['back', 'Move back'],
      ['left', 'Strafe left'], ['right', 'Strafe right'],
      ['jump', 'Jump'], ['sneak', 'Sneak'], ['sprint', 'Sprint'],
      ['inventory', 'Inventory'], ['drop', 'Drop item'],
      ['fly', 'Toggle flight'], ['debug', 'Debug overlay'],
    ];

    const list = this._make('div', { class: 'keybind-list' });
    let capturing = null;   // { action, button }

    const label = (codes) => (codes || []).map(prettyKeyName).join(' / ') || '—';

    const rebuild = () => {
      list.innerHTML = '';
      for (const [action, title] of ACTIONS) {
        const row = this._make('div', { class: 'keybind-row' });
        row.appendChild(this._make('span', { class: 'keybind-name', text: title }));
        const btn = this._make('button', {
          class: 'keybind-key',
          text: capturing && capturing.action === action ? 'Press a key…' : label(input.bindings[action]),
        });
        btn.addEventListener('click', () => {
          capturing = { action };
          rebuild();
        });
        row.appendChild(btn);
        list.appendChild(row);
      }
    };

    const onKey = (e) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      const action = capturing.action;
      capturing = null;

      if (e.code === 'Escape') { rebuild(); return; }

      const clash = input.actionUsing(e.code, action);
      if (clash) {
        hint.textContent = `${prettyKeyName(e.code)} is already used by "${clash}". Pick another key.`;
        rebuild();
        return;
      }

      const next = Object.assign({}, state.settings.keyBindings || {});
      next[action] = [e.code];
      state.set('keyBindings', next);
      input.applyBindings(next);
      hint.textContent = `Bound ${prettyKeyName(e.code)} to "${action}".`;
      rebuild();
    };
    // Capture phase, so a rebind never leaks through to gameplay input.
    window.addEventListener('keydown', onKey, true);
    this._keybindCleanup = () => window.removeEventListener('keydown', onKey, true);

    rebuild();
    panel.appendChild(list);

    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Reset to Defaults', {
      onClick: () => {
        state.set('keyBindings', {});
        input.applyBindings({});
        hint.textContent = 'Controls reset to defaults.';
        rebuild();
      },
    }));
    panel.appendChild(this._button('Back', {
      onClick: () => {
        if (this._keybindCleanup) { this._keybindCleanup(); this._keybindCleanup = null; }
        this.showSettings(back);
      },
    }));

    ov.appendChild(panel);
  }

  showControls(back = 'main') {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    const fullscreen = back === 'main';
    this.current = 'controls';

    const ov = this._ensureOverlay(fullscreen);
    const panel = this._make('div', { class: 'menu-panel' });
    panel.appendChild(this._make('h1', { text: 'How to Play' }));
    panel.appendChild(this._make('p', {
      class: 'subtitle',
      text: 'Mine blocks, gather materials, craft tools, and build whatever you imagine.',
    }));

    const rows = [
      ['Move', '<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>'],
      ['Jump', '<kbd>Space</kbd>'],
      ['Sneak', '<kbd>Shift</kbd>'],
      ['Sprint', '<kbd>Ctrl</kbd> or double-tap <kbd>W</kbd>'],
      ['Fly (creative)', 'double-tap <kbd>Space</kbd>'],
      ['Look', 'Move the mouse'],
      ['Mine / Attack', '<kbd>Left Click</kbd> (hold to mine)'],
      ['Place / Use / Eat', '<kbd>Right Click</kbd>'],
      ['Select hotbar slot', '<kbd>1</kbd>–<kbd>9</kbd> or scroll'],
      ['Drop item', '<kbd>Q</kbd>'],
      ['Inventory / Crafting', '<kbd>E</kbd>'],
      ['Pause', '<kbd>Esc</kbd>'],
      ['Toggle debug overlay', '<kbd>F3</kbd>'],
    ];
    const table = this._make('table', { class: 'controls-table' });
    for (const [action, keys] of rows) {
      const tr = this._make('tr');
      tr.appendChild(this._make('td', { text: action }));
      tr.appendChild(this._make('td', { html: keys }));
      table.appendChild(tr);
    }
    panel.appendChild(table);

    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._make('h2', { text: 'Tips' }));
    const tips = this._make('ul', { class: 'muted', style: 'font-size:13px; line-height:1.6; padding-left:18px;' });
    [
      'Punch a tree, then craft planks and a crafting table.',
      'Place a crafting table and right-click it for the 3×3 grid.',
      'Torches keep monsters away — light up your home before nightfall.',
      'Better tools (stone, iron, diamond) mine faster and last longer.',
    ].forEach((t) => tips.appendChild(this._make('li', { text: t })));
    panel.appendChild(tips);

    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Back', { onClick: () => this._settingsBack(back) }));

    ov.appendChild(panel);
  }

  /* =====================================================================
     Credits
     ===================================================================== */

  _showCredits(back = 'main') {
    if (!this.layer) return;
    this._beforeOpenMenu();
    this._clearOverlay();
    this.current = 'credits';

    const ov = this._ensureOverlay(back === 'main');
    const panel = this._make('div', { class: 'menu-panel center-stack' });
    panel.appendChild(this._make('h1', { text: 'Credits' }));
    panel.appendChild(this._make('p', { class: 'subtitle', text: 'Built with love and a lot of cubes.' }));
    panel.appendChild(this._make('div', {
      class: 'muted',
      style: 'text-align:center; line-height:1.8; font-size:14px;',
      html: [
        '<b>Voxel Odyssey</b>',
        'A from-scratch voxel sandbox.',
        'Rendering: Three.js (r160, vendored).',
        'No textures — every block & item is procedurally drawn.',
        'World generation is fully deterministic from a seed.',
      ].join('<br>'),
    }));
    panel.appendChild(this._make('hr', { class: 'sep' }));
    panel.appendChild(this._button('Back', { onClick: () => this._settingsBack(back) }));
    ov.appendChild(panel);
  }

  /* =====================================================================
     Shared open/close plumbing
     ===================================================================== */

  // Called at the top of every "open a menu" path: drop pointer lock so the
  // cursor is usable, and make sure tooltips from a previous screen are gone.
  _beforeOpenMenu() {
    const g = this.game;
    if (g && g.input && typeof g.input.exitLock === 'function') g.input.exitLock();
    this._hideTooltip();
  }

  /* =====================================================================
     Inventory + crafting screen
     ===================================================================== */

  // Toggle the inventory open/closed. When `forceCraftingTable` is true the
  // screen opens with the full 3×3 crafting grid (used when the player
  // right-clicks a crafting table block).
  toggleInventory(forceCraftingTable = false) {
    if (this.invOpen) {
      // If it's already open but the caller wants the table view and we're
      // currently in 2×2 mode, upgrade in place instead of closing.
      if (forceCraftingTable && !this.craftingTable) {
        this._returnCraftGridToInventory();
        this.craftingTable = true;
        this._buildInventoryDom();
        this._refreshInventory();
        return;
      }
      this._closeInventory();
    } else {
      this._openInventory(!!forceCraftingTable);
    }
  }

  _openInventory(forceCraftingTable) {
    if (!this.layer) return;

    // Opening the inventory counts as opening a menu: release the mouse.
    const g = this.game;
    if (g && g.input && typeof g.input.exitLock === 'function') g.input.exitLock();

    // Any simple overlay (shouldn't usually be up in play mode) gets cleared.
    this._clearOverlay();

    this.invOpen = true;
    this.current = 'inventory';
    this.craftingTable = !!forceCraftingTable;
    this.craftGrid = new Array(9).fill(null);
    this.cursor = null;

    if (g && g.state) g.state.flags.inventoryOpen = true;

    this._buildInventoryDom();
    this._refreshInventory();

    // Listen for live inventory changes (pickups while open, etc.).
    if (g && g.events) g.events.on('inventory:change', this._onInvChange);
    document.addEventListener('mousemove', this._onMouseMove);
  }

  _closeInventory(relock = true) {
    const g = this.game;

    // Return any in-progress crafting materials and a held cursor stack to the
    // inventory so nothing is lost when the screen closes.
    this._returnCraftGridToInventory();
    this._returnCursorToInventory();

    this.invOpen = false;
    this.current = null;
    this._hideTooltip();
    this._hideGhost();

    this._closeInventoryDom();

    if (g && g.state) g.state.flags.inventoryOpen = false;

    if (g && g.events) g.events.off('inventory:change', this._onInvChange);
    document.removeEventListener('mousemove', this._onMouseMove);

    // In play mode, grab the mouse again so the player can look around — unless
    // the caller is transitioning to the death/title screen (relock === false).
    const mode = g && g.state ? g.state.flags.mode : null;
    if (relock && mode === 'play' && g && g.input && typeof g.input.requestLock === 'function') {
      g.input.requestLock();
    }
  }

  // Close the inventory fully if it is open (returning held/crafting items and
  // detaching listeners) without grabbing the pointer — for death/title paths.
  _dismissInventoryIfOpen() {
    if (this.invOpen) this._closeInventory(false);
    else this._closeInventoryDom();
  }

  // Remove the inventory overlay DOM without touching flags/locks (used when
  // switching to a different screen while the inventory happened to be up).
  _closeInventoryDom() {
    if (this._invEls && this._invEls.overlay && this._invEls.overlay.parentNode) {
      this._invEls.overlay.parentNode.removeChild(this._invEls.overlay);
    }
    this._invEls = null;
  }

  // (Re)build the entire inventory overlay from scratch.
  _buildInventoryDom() {
    this._closeInventoryDom();

    const overlay = this._make('div', { class: 'menu-overlay', id: 'inventory-screen' });
    const panel = this._make('div', { class: 'menu-panel' });

    // Title + close button row.
    const titleRow = this._make('div', { class: 'row between' });
    titleRow.appendChild(this._make('h1', {
      text: this.craftingTable ? 'Crafting Table' : 'Inventory',
      style: 'font-size:24px;',
    }));
    titleRow.appendChild(this._button('Close', {
      small: true, row: true, onClick: () => this._closeInventory(),
    }));
    panel.appendChild(titleRow);

    // ---- Crafting area: grid + arrow + output, beside the recipe book ----
    panel.appendChild(this._make('div', { class: 'section-title', text: 'CRAFTING' }));
    const craftArea = this._make('div', { class: 'craft-area' });

    const gridSize = this.craftingTable ? 3 : 2;
    const gridEl = this._make('div', { class: 'craft-grid ' + (this.craftingTable ? 'g3' : 'g2') });
    const craftSlots = [];
    // Map the visible grid cells to canonical craftGrid indices (top-left).
    const cellIndices = this.craftingTable
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
      : [0, 1, 3, 4];
    for (const idx of cellIndices) {
      const slot = this._makeSlot();
      slot.dataset.kind = 'craft';
      slot.dataset.cell = String(idx);
      slot.addEventListener('click', (e) => this._onCraftSlotClick(idx, e));
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onCraftSlotClick(idx, e); });
      slot.addEventListener('mouseenter', () => this._showTooltipFor(this.craftGrid[idx]));
      slot.addEventListener('mouseleave', () => this._hideTooltip());
      craftSlots.push({ idx, el: slot });
      gridEl.appendChild(slot);
    }
    craftArea.appendChild(gridEl);

    craftArea.appendChild(this._make('div', { class: 'craft-arrow', text: '→' }));

    const outWrap = this._make('div', { class: 'craft-out' });
    const outSlot = this._makeSlot();
    outSlot.dataset.kind = 'output';
    outSlot.addEventListener('click', (e) => this._onOutputClick(e));
    outSlot.addEventListener('mouseenter', () => {
      const m = this._matchCraft();
      this._showTooltipFor(m ? m.output.id : null);
    });
    outSlot.addEventListener('mouseleave', () => this._hideTooltip());
    outWrap.appendChild(outSlot);
    craftArea.appendChild(outWrap);

    panel.appendChild(craftArea);

    // ---- Recipe book (scrollable, click to auto-craft) -----------------
    panel.appendChild(this._make('div', { class: 'section-title', text: 'RECIPE BOOK' }));
    const book = this._make('div', { class: 'recipe-book' });
    const recipeSlots = this._buildRecipeBook(book);
    panel.appendChild(book);

    // ---- Main storage (27) ---------------------------------------------
    panel.appendChild(this._make('div', { class: 'section-title', text: 'INVENTORY' }));
    const mainGrid = this._make('div', { class: 'inv-grid main' });
    const mainSlots = [];
    for (let i = 0; i < MAIN_COUNT; i++) {
      const slotIndex = HOTBAR_COUNT + i;     // 9..35
      const slot = this._makeSlot();
      slot.dataset.kind = 'inv';
      slot.dataset.slot = String(slotIndex);
      slot.addEventListener('click', (e) => this._onInvSlotClick(slotIndex, e));
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onInvSlotClick(slotIndex, e); });
      slot.addEventListener('mouseenter', () => this._showTooltipForSlot(slotIndex));
      slot.addEventListener('mouseleave', () => this._hideTooltip());
      mainSlots.push({ slot: slotIndex, el: slot });
      mainGrid.appendChild(slot);
    }
    panel.appendChild(mainGrid);

    // ---- Hotbar (9) ----------------------------------------------------
    panel.appendChild(this._make('div', { class: 'section-title', text: 'HOTBAR' }));
    const hotGrid = this._make('div', { class: 'inv-grid' });
    const hotSlots = [];
    for (let i = 0; i < HOTBAR_COUNT; i++) {
      const slot = this._makeSlot();
      slot.dataset.kind = 'inv';
      slot.dataset.slot = String(i);
      slot.addEventListener('click', (e) => this._onInvSlotClick(i, e));
      slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onInvSlotClick(i, e); });
      slot.addEventListener('mouseenter', () => this._showTooltipForSlot(i));
      slot.addEventListener('mouseleave', () => this._hideTooltip());
      hotSlots.push({ slot: i, el: slot });
      hotGrid.appendChild(slot);
    }
    panel.appendChild(hotGrid);

    overlay.appendChild(panel);

    // Clicking the dim backdrop (outside the panel) closes the inventory.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this._closeInventory();
    });
    // Suppress the browser context menu inside the inventory so right-click can
    // be used for split/place-one interactions.
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    this.layer.appendChild(overlay);

    this._invEls = {
      overlay, panel,
      craftSlots, outSlot, mainSlots, hotSlots, recipeSlots,
    };
  }

  // Build the recipe-book entries; returns [{recipe, el}] for refresh.
  _buildRecipeBook(container) {
    const out = [];
    const g = this.game;
    const list = (g && g.crafting && typeof g.crafting.list === 'function') ? g.crafting.list() : [];
    for (const entry of list) {
      const slot = this._makeSlot();
      slot.classList.add('clickable');
      slot.dataset.kind = 'recipe';
      slot.addEventListener('click', () => this._onRecipeClick(entry));
      slot.addEventListener('mouseenter', () => this._showRecipeTooltip(entry));
      slot.addEventListener('mouseleave', () => this._hideTooltip());
      container.appendChild(slot);
      out.push({ entry, el: slot });
    }
    return out;
  }

  // Create an empty .slot element that contains an icon canvas + count span.
  _makeSlot() {
    const slot = this._make('div', { class: 'slot clickable' });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_SIZE;
    const count = this._make('span', { class: 'count' });
    slot.appendChild(canvas);
    slot.appendChild(count);
    slot._canvas = canvas;
    slot._count = count;
    return slot;
  }

  // Draw a stack ({id,count}|null) into a slot element.
  _drawStack(slotEl, stack) {
    if (!slotEl || !slotEl._canvas) return;
    const ctx = slotEl._canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
    if (stack && stack.id) {
      try { Items.drawIcon(ctx, stack.id, ICON_SIZE); } catch (_) { /* ignore bad icon */ }
      slotEl._count.textContent = stack.count > 1 ? String(stack.count) : '';
    } else {
      slotEl._count.textContent = '';
    }
  }

  /* ---- inventory refresh (redraw all live slots) ----------------------- */

  _refreshInventory() {
    if (!this._invEls) return;
    const inv = this.game && this.game.inventory;
    const slots = inv && inv.slots ? inv.slots : [];

    for (const { slot, el } of this._invEls.mainSlots) this._drawStack(el, slots[slot] || null);
    for (const { slot, el } of this._invEls.hotSlots) this._drawStack(el, slots[slot] || null);
    for (const { idx, el } of this._invEls.craftSlots) {
      const key = this.craftGrid[idx];
      this._drawStack(el, key ? { id: key, count: 1 } : null);
    }

    // Output slot reflects the current craft match (preview only).
    const match = this._matchCraft();
    this._drawStack(this._invEls.outSlot, match ? { id: match.output.id, count: match.output.count } : null);

    // Recipe book: dim recipes the player can't currently afford.
    const crafting = this.game && this.game.crafting;
    for (const { entry, el } of this._invEls.recipeSlots) {
      const sample = entry.output ? entry.output.id : null;
      this._drawStack(el, sample ? { id: sample, count: entry.output.count } : null);
      const can = crafting && typeof crafting.canCraft === 'function'
        ? crafting.canCraft(entry.recipe || entry, inv) : true;
      el.style.opacity = can ? '1' : '0.4';
    }
  }

  // Match the current crafting grid against the recipe set.
  _matchCraft() {
    const crafting = this.game && this.game.crafting;
    if (!crafting || typeof crafting.match !== 'function') return null;
    // Pass a length-9 grid; crafting handles the 2×2 subset transparently.
    return crafting.match(this.craftGrid.slice());
  }

  /* ---- slot interactions (click pickup / place via the cursor) --------- */

  // Click an inventory storage/hotbar slot: classic pick-up / put-down with a
  // single "cursor" stack carried between clicks (drawn via #drag-ghost).
  _onInvSlotClick(slotIndex, e) {
    const inv = this.game && this.game.inventory;
    if (!inv || !inv.slots) return;
    const slots = inv.slots;
    const cur = this.cursor;
    const here = slots[slotIndex] || null;

    if (!cur) {
      // Pick up the whole stack (or half on right-click).
      if (!here) return;
      if (e && e.button === 2) {
        const half = Math.ceil(here.count / 2);
        this.cursor = { id: here.id, count: half };
        here.count -= half;
        if (here.count <= 0) slots[slotIndex] = null;
      } else {
        this.cursor = { id: here.id, count: here.count };
        slots[slotIndex] = null;
      }
    } else {
      if (!here) {
        // Place into an empty slot (one on right-click, all on left).
        if (e && e.button === 2) {
          slots[slotIndex] = { id: cur.id, count: 1 };
          cur.count -= 1;
          if (cur.count <= 0) this.cursor = null;
        } else {
          slots[slotIndex] = { id: cur.id, count: cur.count };
          this.cursor = null;
        }
      } else if (here.id === cur.id) {
        // Merge into the same item, respecting the max stack.
        const max = Items.stackSize(here.id);
        const space = max - here.count;
        if (e && e.button === 2) {
          if (space > 0) { here.count += 1; cur.count -= 1; if (cur.count <= 0) this.cursor = null; }
        } else {
          const moved = Math.min(space, cur.count);
          here.count += moved;
          cur.count -= moved;
          if (cur.count <= 0) this.cursor = null;
        }
      } else {
        // Different items: swap stack with cursor.
        slots[slotIndex] = { id: cur.id, count: cur.count };
        this.cursor = { id: here.id, count: here.count };
      }
    }

    this._afterSlotMutation();
  }

  // Click a crafting-grid input cell.
  _onCraftSlotClick(cellIdx, e) {
    const cur = this.cursor;
    const hereKey = this.craftGrid[cellIdx];

    if (!cur) {
      if (!hereKey) return;
      // Pick one up off the grid (grids hold single items per cell here).
      this.cursor = { id: hereKey, count: 1 };
      this.craftGrid[cellIdx] = null;
    } else {
      if (!hereKey) {
        // Drop a single item into the empty cell.
        this.craftGrid[cellIdx] = cur.id;
        cur.count -= 1;
        if (cur.count <= 0) this.cursor = null;
      } else if (hereKey === cur.id) {
        // Same item already there: pick it back (toggle) — keep it simple by
        // returning the cell item to the cursor stack.
        cur.count += 1;
        this.craftGrid[cellIdx] = null;
      } else {
        // Different item: swap cursor's single item with the cell.
        const taken = hereKey;
        this.craftGrid[cellIdx] = cur.id;
        cur.count -= 1;
        if (cur.count <= 0) this.cursor = { id: taken, count: 1 };
        else { /* leftover stays on cursor; bump the taken item back to inv */ this._returnKeyToInventory(taken, 1); }
      }
    }

    this._afterSlotMutation();
  }

  // Click the output slot: craft once, consuming one of each grid input.
  _onOutputClick(e) {
    const crafting = this.game && this.game.crafting;
    const inv = this.game && this.game.inventory;
    if (!crafting || !inv) return;
    const match = this._matchCraft();
    if (!match) return;

    // Consume one of each grid cell via crafting.craftOnce (mutates a copy we
    // then write back so cell positions stay aligned).
    const work = this.craftGrid.slice();
    const produced = crafting.craftOnce(work);
    if (!produced) return;
    this.craftGrid = work;

    // Deliver the output: into the cursor if it stacks, else add to inventory.
    if (!this.cursor) {
      this.cursor = { id: produced.id, count: produced.count };
    } else if (this.cursor.id === produced.id) {
      this.cursor.count += produced.count;
    } else {
      // Cursor holds something else — push the result straight to inventory.
      const left = inv.add(produced.id, produced.count);
      if (left > 0) this._spillToWorld(produced.id, left);
    }

    this._emit('sfx', { name: 'craft', opts: {} });
    this._afterSlotMutation();
  }

  // Recipe-book click → one-click auto-craft from inventory contents.
  _onRecipeClick(entry) {
    const crafting = this.game && this.game.crafting;
    if (!crafting || typeof crafting.autoCraft !== 'function') return;
    const ok = crafting.autoCraft(entry.recipe || entry);
    if (ok) {
      this._emit('sfx', { name: 'craft', opts: {} });
    } else {
      this._emit('toast', { text: 'Not enough materials', kind: 'warn' });
    }
    this._refreshInventory();
  }

  // After any slot/grid mutation: notify the rest of the game, refresh the
  // visible slots, and update the drag ghost.
  _afterSlotMutation() {
    this._emit('inventory:change', {});
    this._refreshInventory();
    this._updateGhost();
  }

  /* ---- returning materials when the screen closes ---------------------- */

  _returnCraftGridToInventory() {
    const inv = this.game && this.game.inventory;
    if (!inv || typeof inv.add !== 'function') { this.craftGrid = new Array(9).fill(null); return; }
    for (let i = 0; i < this.craftGrid.length; i++) {
      const key = this.craftGrid[i];
      if (key) {
        const left = inv.add(key, 1);
        if (left > 0) this._spillToWorld(key, left);
        this.craftGrid[i] = null;
      }
    }
  }

  _returnCursorToInventory() {
    if (!this.cursor) return;
    this._returnKeyToInventory(this.cursor.id, this.cursor.count);
    this.cursor = null;
    this._hideGhost();
  }

  _returnKeyToInventory(key, count) {
    const inv = this.game && this.game.inventory;
    if (!inv || typeof inv.add !== 'function' || !key || count <= 0) return;
    const left = inv.add(key, count);
    if (left > 0) this._spillToWorld(key, left);
  }

  // If the inventory is full, drop overflow into the world near the player so
  // items are never silently destroyed.
  _spillToWorld(key, count) {
    const g = this.game;
    const ents = g && g.entities;
    const p = g && g.player && g.player.position;
    if (ents && typeof ents.dropItem === 'function' && p) {
      ents.dropItem(p.x, p.y + 1, p.z, key, count);
    }
    // If we can't drop it, it is lost — acceptable edge case (inventory full
    // AND no entity system); avoids throwing in any path.
  }

  /* ---- drag ghost (the icon under the cursor) -------------------------- */

  _updateGhost() {
    if (!this.dragGhost) return;
    if (this.cursor && this.cursor.id) {
      this.dragGhost.style.display = 'block';
      const ctx = this._ghostCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
        try { Items.drawIcon(ctx, this.cursor.id, ICON_SIZE); } catch (_) {}
      }
      this._ghostCount.textContent = this.cursor.count > 1 ? String(this.cursor.count) : '';
    } else {
      this._hideGhost();
    }
  }

  _hideGhost() {
    if (this.dragGhost) this.dragGhost.style.display = 'none';
  }

  // Mouse-move handler while the inventory is open: position the ghost (and a
  // hovered tooltip) under the cursor.
  _handlePointer(e) {
    if (this.dragGhost && this.cursor) {
      this.dragGhost.style.left = e.clientX + 'px';
      this.dragGhost.style.top = e.clientY + 'px';
    }
    if (this.tooltip && this.tooltip.style.display === 'block') {
      this._positionTooltip(e.clientX, e.clientY);
    }
  }

  /* ---- tooltips -------------------------------------------------------- */

  _showTooltipForSlot(slotIndex) {
    const inv = this.game && this.game.inventory;
    const stack = inv && inv.slots ? inv.slots[slotIndex] : null;
    this._showTooltipFor(stack ? stack.id : null);
  }

  _showTooltipFor(itemKey) {
    if (!this.tooltip || !itemKey) { this._hideTooltip(); return; }
    const def = Items.get(itemKey);
    if (!def) { this._hideTooltip(); return; }
    const nameEl = this.tooltip.querySelector('.t-name');
    const descEl = this.tooltip.querySelector('.t-desc');
    if (nameEl) nameEl.textContent = def.name || itemKey;
    if (descEl) {
      let desc = def.desc || '';
      if (def.category === 'tool' && def.tool) {
        desc = desc || `Tier ${def.tool.tier} ${def.tool.type}`;
      } else if (def.category === 'food' && def.food) {
        desc = desc || `Restores ${def.food} HP`;
      }
      descEl.textContent = desc;
      descEl.style.display = desc ? 'block' : 'none';
    }
    this.tooltip.style.display = 'block';
  }

  _showRecipeTooltip(entry) {
    if (!this.tooltip || !entry) { this._hideTooltip(); return; }
    const nameEl = this.tooltip.querySelector('.t-name');
    const descEl = this.tooltip.querySelector('.t-desc');
    if (nameEl) nameEl.textContent = entry.name || (entry.output ? Items.name(entry.output.id) : 'Recipe');
    // Build a short "needs: a, b, c" line from the recipe's ingredient groups.
    let needs = '';
    if (entry.ingredients && entry.ingredients.length) {
      needs = 'Needs: ' + entry.ingredients.map((g) => {
        const sampleKey = g.sample || g.token;
        const nm = sampleKey ? Items.name(sampleKey) : '?';
        return g.count > 1 ? `${nm} ×${g.count}` : nm;
      }).join(', ');
    }
    if (descEl) {
      descEl.textContent = needs;
      descEl.style.display = needs ? 'block' : 'none';
    }
    this.tooltip.style.display = 'block';
  }

  _positionTooltip(x, y) {
    if (!this.tooltip) return;
    // Keep the tooltip on-screen by flipping near the right/bottom edges.
    const pad = 14;
    const w = this.tooltip.offsetWidth || 160;
    const h = this.tooltip.offsetHeight || 40;
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 1080);
    let left = x + pad;
    let top = y + pad;
    if (left + w > vw) left = x - w - pad;
    if (top + h > vh) top = y - h - pad;
    this.tooltip.style.left = Math.max(0, left) + 'px';
    this.tooltip.style.top = Math.max(0, top) + 'px';
  }

  _hideTooltip() {
    if (this.tooltip) this.tooltip.style.display = 'none';
  }
}

export default Menus;

/* KeyboardEvent.code is a physical-key identifier ("KeyW", "ShiftLeft"), not
   something to show a player. Map the common shapes to readable labels. */
export function prettyKeyName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const NAMES = {
    Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return NAMES[code] || code;
}
