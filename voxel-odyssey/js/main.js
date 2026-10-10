/* =========================================================================
   main.js — bootstrap + integration glue for Voxel Odyssey.

   Responsibilities:
     - build the shared `game` context object
     - construct every system, then init() them in dependency order
     - own the game-flow state machine (menu / play / paused) and react to
       the flow events emitted by the menus
     - run the single requestAnimationFrame loop

   The set of systems and how they are called here is the integration contract
   that every module file implements. See ARCHITECTURE.md for full per-module
   API specs.
   ========================================================================= */

import * as THREE from 'three';

import { Perf } from './core/perf.js';
import { Quality, settingsForPreset, gatherHardware, PRESET_KEYS } from './core/quality.js';
import { EventBus } from './core/events.js';
import { GameState } from './core/state.js';
import { Input } from './core/input.js';
import { Engine } from './core/engine.js';
import { hashString, RNG, clamp, formatTimeOfDay } from './core/utils.js';

import Blocks from './world/blocks.js';
import Items from './items/items.js';
import { WATER_LEVEL } from './world/constants.js';

import { WorldGen } from './world/worldgen.js';
import { World } from './world/world.js';
import { Player } from './entities/player.js';
import { EntityManager } from './entities/entityManager.js';
import { Inventory } from './items/inventory.js';
import { Crafting } from './items/crafting.js';
import { Furnaces } from './items/furnace.js';
import { Chests } from './items/chest.js';
import { Growth } from './world/growth.js';
import { Particles } from './fx/particles.js';
import { AudioSystem } from './fx/audio.js';
import { Resources } from './render/resources.js';
import { NetClient } from './net/client.js';
import { RemotePlayers } from './net/remotePlayers.js';
import { Sky } from './fx/sky.js';
import { Weather } from './fx/weather.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { TouchControls } from './ui/touch.js';

const LOADING_TIPS = [
  'Tip: Hold left mouse to mine, right mouse to place.',
  'Tip: Press E to open your inventory and craft.',
  'Tip: Build a Crafting Table for the 3×3 grid.',
  'Tip: Smelt ore in a Furnace — right-click it, add fuel and ore.',
  'Tip: Craft a Chest from eight planks to store your things.',
  'Tip: Tools wear out; the bar under the icon shows what is left.',
  'Tip: Break leaves to find saplings, then plant them on grass to grow a tree.',
  'Tip: Torches keep the monsters away at night.',
  'Tip: Press F to toggle creative flight.',
  'Tip: Diamonds hide deep underground.',
  'Tip: Sleep is for the weak — build a fortress instead.',
  'Tip: Press F3 for debug info.',
];

boot().catch((err) => {
  console.error('Fatal during boot:', err);
  const box = document.getElementById('fatal-error');
  const msg = document.getElementById('fatal-message');
  if (box && msg) { box.hidden = false; msg.textContent = (err && err.stack) || String(err); }
});

// Settings can be forced from the address bar, which makes "open this link with
// quality=low" a one-step fix to pass to someone on a slow machine:
//   ?quality=low|medium|high|auto   ?scale=0.6   ?distance=4   ?fps=30
function applyUrlOverrides(state) {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  const preset = q.get('quality');
  if (preset && ['auto', 'low', 'medium', 'high'].includes(preset)) {
    state.settings.quality = preset;
    state.settings._autoApplied = '';        // re-run detection / re-apply the bundle
    if (preset !== 'auto') {
      const p = settingsForPreset(preset, gatherHardware());
      for (const k of PRESET_KEYS) state.settings[k] = p[k];
      state.settings._autoApplied = preset;
    }
  }
  if (num('scale') !== null) state.settings.renderScale = Math.max(0.25, Math.min(1, num('scale')));
  if (num('distance') !== null) state.settings.renderDistance = Math.max(2, Math.min(12, Math.round(num('distance'))));
  if (num('fps') !== null) state.settings.maxFps = Math.max(0, Math.round(num('fps')));
}

// The terrain shader needs WebGL 2 (texture arrays). Most machines from the
// last decade have it; if this one does not, say so plainly instead of leaving
// a black screen.
function webgl2Supported() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (_) { return false; }
}

async function boot() {
  if (!webgl2Supported()) {
    const box = document.getElementById('fatal-error');
    const msg = document.getElementById('fatal-message');
    const ld = document.getElementById('loading-screen');
    if (ld) ld.classList.add('hidden');
    if (box && msg) {
      box.hidden = false;
      msg.textContent = 'This browser or graphics driver does not offer WebGL 2, which Voxel Odyssey needs.\n\n' +
        '• Use a current Chrome, Edge or Firefox (portable versions work without admin rights).\n' +
        '• Make sure hardware acceleration is switched on in the browser settings.\n' +
        '• Update the graphics driver if you can; very old integrated graphics (before about 2012) cannot do WebGL 2.';
    }
    return;
  }
  const canvas = document.getElementById('game-canvas');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingFill = document.getElementById('loading-fill');
  const loadingText = document.getElementById('loading-text');
  const loadingTip = document.getElementById('loading-tip');
  if (loadingTip) loadingTip.textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];

  // ---- core ----
  const events = new EventBus();
  const state = new GameState(events);
  applyUrlOverrides(state);
  const perf = new Perf();
  // First-run hardware detection happens BEFORE the renderer exists, because
  // MSAA is a creation-time option.
  const prepared = Quality.prepare(state);
  const engine = new Engine(canvas, state.settings);
  engine.perf = perf;
  const input = new Input(canvas, events, state);

  // ---- the shared context ----
  const game = {
    THREE,
    engine,
    scene: engine.scene,
    camera: engine.camera,
    renderer: engine.renderer,
    events,
    state,
    input,
    perf,
    blocks: Blocks,
    items: Items,
    // systems (filled in below)
    worldgen: null, world: null, player: null, entities: null,
    inventory: null, crafting: null, furnaces: null, chests: null, growth: null, particles: null, audio: null,
    sky: null, weather: null, hud: null, menus: null, touch: null, quality: null, resources: null,
    net: null, remotePlayers: null,
    // runtime
    dt: 0, elapsed: 0, seed: 0, worldActive: false,
    toast(text, kind) { events.emit('toast', { text, kind }); },
    get mode() { return state.flags.mode; },
  };

  // ---- construct systems ----
  game.worldgen = new WorldGen(game);
  game.world = new World(game);
  game.inventory = new Inventory(game);
  game.crafting = new Crafting(game);
  game.furnaces = new Furnaces(game);
  game.chests = new Chests(game);
  game.growth = new Growth(game);
  game.particles = new Particles(game);
  game.audio = new AudioSystem(game);
  game.sky = new Sky(game);
  game.weather = new Weather(game);
  game.entities = new EntityManager(game);
  game.player = new Player(game);
  game.hud = new HUD(game);
  game.menus = new Menus(game);
  game.touch = new TouchControls(game);
  game.quality = new Quality(game);
  game.resources = new Resources(game);
  // Networking is inert until connect() is called — single-player runs the
  // identical code path with no socket attached.
  game.net = new NetClient(game);
  game.remotePlayers = new RemotePlayers(game, game.net);

  // ---- init in dependency order ----
  // `resources` comes after `world` because building the atlas hands it
  // straight to World.setAtlas, which needs World's materials to exist.
  const initOrder = [
    'worldgen', 'world', 'resources', 'inventory', 'crafting', 'furnaces', 'chests', 'growth', 'particles',
    'audio', 'sky', 'weather', 'entities', 'player', 'hud', 'menus', 'touch',
  ];
  for (const name of initOrder) {
    const sys = game[name];
    if (sys && typeof sys.init === 'function') {
      try { await sys.init(); }
      catch (err) { console.error(`init() failed for ${name}:`, err); }
    }
  }

  game.quality.init(prepared);

  // Apply any saved key rebinds over the defaults.
  input.applyBindings(state.settings.keyBindings);
  events.on('settings:change', ({ key }) => {
    if (key === 'keyBindings' || key === '*') input.applyBindings(state.settings.keyBindings);
  });

  // expose for debugging / tests
  window.GAME = game;

  // ---- resource packs: drop a .zip anywhere on the window ----------------
  // Deliberately a drop target rather than a file picker: packs arrive from
  // Modrinth/CurseForge as downloaded .zip files, and dragging one in is the
  // shortest path from "downloaded" to "playing with it".
  setupResourcePackDrop(game);

  // ---- menu backdrop: a slowly orbiting world behind the title screen ----
  const menuCam = { angle: 0, center: new THREE.Vector3(8, WATER_LEVEL + 6, 8), radius: 28, height: 18 };

  // Generate an initial backdrop world so the title screen isn't empty.
  startWorld(hashString('voxel-odyssey-' + Math.floor(Math.random() * 1e6)), null, /*menuBackdrop*/ true);

  // ---- flow events from menus ----
  events.on('game:new', (opts) => {
    const seed = opts && opts.seed != null
      ? (typeof opts.seed === 'string' ? hashString(opts.seed) : opts.seed)
      : (Math.random() * 0xffffffff) >>> 0;
    if (opts && opts.gamemode) state.set('gamemode', opts.gamemode);
    state.deleteSave();
    startWorld(seed, null, false);
    enterPlay();
  });

  events.on('game:continue', () => {
    const save = state.loadGame();
    if (!save) { game.toast('No saved world found', 'warn'); return; }
    startWorld(save.seed, save, false);
    enterPlay();
  });

  // ---- multiplayer ------------------------------------------------------
  // The server owns the seed, so we must connect BEFORE generating anything:
  // starting a world first and then joining would build terrain from the
  // wrong seed and every block would disagree with the other players.
  events.on('game:join', async ({ url, name, resolve, reject }) => {
    try {
      await game.net.connect(url, name);
      const seed = typeof game.net.serverSeed === 'string'
        ? hashString(game.net.serverSeed)
        : (game.net.serverSeed | 0);
      state.set('gamemode', 'survival');
      startWorld(seed, null, false);
      enterPlay();
      game.toast(`Connected to ${url}`, 'good');
      if (resolve) resolve();
    } catch (err) {
      console.error('join failed', err);
      if (reject) reject(err);
      else game.toast(err.message || 'Could not connect', 'bad');
    }
  });

  events.on('net:disconnected', ({ reason }) => {
    game.toast(`Disconnected: ${reason || 'connection lost'}`, 'bad');
  });
  events.on('net:kicked', ({ reason }) => {
    game.toast(`Kicked: ${reason || 'no reason given'}`, 'bad');
  });
  events.on('net:join', ({ name }) => game.toast(`${name} joined`, 'good'));
  events.on('net:leave', ({ id }) => {
    const p = game.net.players.get(id);
    game.toast(`${(p && p.name) || 'A player'} left`, 'warn');
  });

  events.on('game:save', () => { saveGame(); game.toast('Game saved', 'good'); });

  events.on('game:quit', () => { saveGame(); quitToMenu(); });

  events.on('game:respawn', () => {
    game.player.respawn();
    state.flags.paused = false;
    game.menus.hide();
    enterPlay();
  });

  events.on('player:die', () => {
    state.flags.paused = true;
    input.exitLock();
    game.menus.showDeath();
  });

  // ---- pause / lock integration ----
  // Pause is driven entirely by the Escape keypress in the loop below (a single
  // deterministic effect). We deliberately do NOT open pause from the
  // 'pointerlock' lost event: pressing Escape also exits pointer lock, and
  // opening pause there too would let the same keypress open-then-resume in one
  // frame (a menu flash). Clicking the canvas re-locks; tab-hide auto-pauses.

  canvas.addEventListener('click', () => {
    if (state.mode === 'play' && !state.flags.paused && !state.flags.inventoryOpen && !input.locked) {
      // Clicking the canvas is itself the request for capture, so it clears a
      // deliberate release rather than being blocked by it.
      input.resumeCapture();
      game.audio.resume();
    }
  });

  // ---- save on tab close / auto-pause when hidden ----
  window.addEventListener('beforeunload', () => { if (game.worldActive && state.mode === 'play') saveGame(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.worldActive && state.mode === 'play') {
      saveGame();
      if (!state.flags.paused && !state.flags.inventoryOpen) openPause();
    }
  });

  // ---- helpers ----
  function startWorld(seed, save, menuBackdrop) {
    game.seed = seed >>> 0;
    game.rng = new RNG(game.seed);
    game.worldgen.setSeed ? game.worldgen.setSeed(game.seed) : (game.worldgen.seed = game.seed);
    game.world.reset(game.seed);
    game.furnaces.reset();
    game.chests.reset();
    game.growth.reset();
    game.entities.removeAll();
    game.particles.reset && game.particles.reset();

    // Spawn / restore the player.
    if (save) {
      game.world.applyEdits(save.edits || []);
      game.furnaces.load(save.furnaces);
      game.chests.load(save.chests);
      game.growth.scanEdits();
      game.inventory.load(save.inventory);
      game.player.load(save.player);
      game.sky.load(save.sky);
      game.state.loadStats(save.stats);
      if (save.gamemode) state.set('gamemode', save.gamemode);
    } else {
      game.inventory.reset ? game.inventory.reset() : null;
      game.inventory.giveStarter && game.inventory.giveStarter();
      const spawn = game.world.getGroundSpawn(0, 0);
      game.player.spawnAt(spawn.x, spawn.y, spawn.z);
      game.sky.setTime(0.25); // morning
    }
    game.player.setGamemode(state.get('gamemode'));
    game.worldActive = true;

    // Center menu orbit on the spawn area.
    menuCam.center.set(game.player.position.x, game.player.position.y + 6, game.player.position.z);

    // Pre-stream chunks around spawn; hide the loading screen when ready.
    primeWorld();
  }

  function primeWorld() {
    if (loadingScreen) { loadingScreen.classList.remove('hidden'); }
    // Each priming is self-contained: a per-call `done` flag + local handlers,
    // so priming a new world before the previous world:ready fires can't leak
    // the previous 'loading:progress' subscription.
    let done = false;
    const onProg = (p) => {
      if (loadingFill) loadingFill.style.width = Math.round((p.value || 0) * 100) + '%';
      if (loadingText && p.text) loadingText.textContent = p.text;
    };
    const finish = () => {
      if (done) return;
      done = true;
      events.off('loading:progress', onProg);
      events.off('world:ready', finish);
      clearTimeout(timer);
      if (loadingScreen) loadingScreen.classList.add('hidden');
    };
    events.on('loading:progress', onProg);
    events.once('world:ready', finish);
    // Fallback: never get stuck on the loading screen.
    const timer = setTimeout(finish, 8000);
  }

  function enterPlay() {
    state.mode = 'play';
    state.flags.paused = false;
    state.flags.inventoryOpen = false;
    game.menus.hide();
    game.hud.setVisible(true);
    events.emit('mode:change', { mode: 'play' });
    input.resumeCapture();
    game.audio.resume();
    game.audio.startMusic && game.audio.startMusic();
  }

  function openPause() {
    state.flags.paused = true;
    input.exitLock();
    game.menus.showPause();
  }
  function resumePlay() {
    state.flags.paused = false;
    game.menus.hide();
    input.resumeCapture();
  }
  function quitToMenu() {
    state.mode = 'menu';
    state.flags.paused = false;
    state.flags.inventoryOpen = false;
    input.exitLock();
    game.hud.setVisible(false);
    game.menus.showMainMenu();
    events.emit('mode:change', { mode: 'menu' });
    game.audio.stopMusic && game.audio.stopMusic();
  }

  function saveGame() {
    if (!game.worldActive) return;
    const data = {
      savedAt: performance.now() | 0,
      seed: game.seed,
      edits: game.world.serialize().edits,
      furnaces: game.furnaces.serialize(),
      chests: game.chests.serialize(),
      inventory: game.inventory.serialize(),
      player: game.player.serialize(),
      sky: game.sky.serialize(),
      stats: game.state.serializeStats(),
      gamemode: state.get('gamemode'),
    };
    game.state.saveGame(data);
  }

  // expose flow controls to menus that prefer direct calls
  game.flow = { startWorld, enterPlay, openPause, resumePlay, quitToMenu, saveGame };

  // Show the main menu on top of the backdrop world.
  quitToMenuInitial();
  function quitToMenuInitial() {
    state.mode = 'menu';
    game.hud.setVisible(false);
    game.menus.showMainMenu();
  }

  // ---- the loop ----
  engine.start((dt, elapsed, tMs) => {
    game.dt = dt; game.elapsed = elapsed;
    try {
      const playing = state.mode === 'play' && !state.flags.paused;
      const anchor = (state.mode === 'play') ? game.player.position : menuCam.center;

      if (game.worldActive) {
        const P = perf, t0 = P.now();
        // Advance day/night while playing, or gently during the menu backdrop.
        game.sky.update(playing ? dt * state.get('daylightSpeed') : (state.mode === 'menu' ? dt * 0.3 : 0));
        // Weather runs on real time, not the day-cycle multiplier: a fast
        // daylight setting should not make rain fall in fast-forward.
        if (game.weather) game.weather.update(playing ? dt : 0);
        const t1 = P.now(); P.add('sky', t1 - t0);
        if (playing) {
          game.player.update(dt);
          const t2 = P.now(); P.add('player', t2 - t1);
          game.entities.update(dt);
          const t3 = P.now(); P.add('entities', t3 - t2);
          // Smelting carries on while the inventory screen is open and while
          // the player is away from the furnace.
          game.furnaces.update(dt);
          game.growth.update(dt);
          P.add('machines', P.now() - t3);
        }
        const t4 = P.now();
        game.world.update(dt, anchor);
        const t5 = P.now(); P.add('world', t5 - t4);
        game.particles.update(dt);
        P.add('particles', P.now() - t5);
      }

      // Menu backdrop camera orbit.
      if (state.mode === 'menu' && game.worldActive) {
        menuCam.angle += dt * 0.08;
        const c = menuCam.center;
        engine.camera.position.set(
          c.x + Math.cos(menuCam.angle) * menuCam.radius,
          c.y + menuCam.height,
          c.z + Math.sin(menuCam.angle) * menuCam.radius
        );
        engine.camera.lookAt(c.x, c.y - 4, c.z);
      }

      // Per-frame input handling for play mode.
      if (state.mode === 'play') {
        if (input.actionPressed('pause')) {
          if (state.flags.paused) resumePlay();
          else if (state.flags.inventoryOpen) game.menus.toggleInventory();
          else openPause();
        }
        if (!state.flags.paused && input.actionPressed('inventory')) {
          game.menus.toggleInventory();
        }
        if (!state.flags.paused && input.actionPressed('debug')) {
          state.flags.debug = !state.flags.debug;
        }
        // Release the cursor without pausing. Needed because a click now
        // re-takes pointer lock unconditionally (see input._onMouseDown), so
        // without a deliberate release there is no way to get the mouse back
        // other than opening a menu. `_cursorReleased` suppresses the
        // click-to-relock until the player asks for capture again.
        if (!state.flags.paused && input.actionPressed('releaseCursor')) {
          if (input.cursorReleased) input.resumeCapture();
          else input.releaseCursor();
          game.toast(input.cursorReleased
            ? 'Mouse released — click the game to capture it again'
            : 'Mouse captured');
        }
        // Our own fullscreen toggle, so entering it goes through the path that
        // re-takes pointer lock afterwards. The browser's own F11 bypasses us
        // entirely, which is why the fullscreenchange listener exists too.
        if (input.actionPressed('fullscreen')) input.toggleFullscreen();
      }

      // Gamepads are polled, not evented — the API only exposes snapshots.
      input.pollGamepad(state.settings);

      // Networking runs even while paused: staying connected and continuing
      // to receive other players' edits matters more than saving a few
      // packets, and a client that stops sending state looks frozen to
      // everyone else.
      if (game.net) game.net.update(dt);
      if (game.remotePlayers) game.remotePlayers.update(dt);

      const tn = perf.now();
      game.audio.update(dt);
      // Animated block textures (water, fire) — advances layer indices only.
      if (game.resources) game.resources.update(dt);
      const tu = perf.now(); perf.add('audio+fx', tu - tn);
      game.hud.update(dt);
      game.menus.update(dt);
      game.touch.update();
      perf.add('ui', perf.now() - tu);
      game.quality.update(engine.rawMs || dt * 1000, perf.frameMs);
    } catch (err) {
      if (!boot._errored) { console.error('Loop error:', err); boot._errored = true; }
    } finally {
      input.lateUpdate();
    }
  });
}

/* ---------------------------------------------------------------------------
   Resource-pack drag & drop.

   Accepts a standard Minecraft resource pack .zip dropped anywhere on the
   window. Packs from Modrinth and CurseForge are exactly this format, so a
   downloaded file works without unpacking or conversion.
   --------------------------------------------------------------------------- */
function setupResourcePackDrop(game) {
  if (typeof window === 'undefined') return;

  let overlay = null;
  const showHint = (text, kind) => {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pack-drop-hint';
      document.body.appendChild(overlay);
    }
    overlay.textContent = text;
    overlay.dataset.kind = kind || 'info';
    overlay.hidden = false;
  };
  const hideHint = () => { if (overlay) overlay.hidden = true; };

  // dragover must be cancelled or the browser navigates to the dropped file.
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    showHint('Drop a resource pack (.zip) to apply it');
  });

  window.addEventListener('dragleave', (e) => {
    // Only hide when the cursor actually leaves the window, not when it
    // crosses between child elements.
    if (e.relatedTarget === null) hideHint();
  });

  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();

    const file = e.dataTransfer.files[0];
    if (!/\.zip$/i.test(file.name)) {
      showHint(`"${file.name}" is not a .zip resource pack`, 'error');
      setTimeout(hideHint, 3000);
      return;
    }

    showHint(`Loading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const info = await game.resources.applyPack(buffer, file.name.replace(/\.zip$/i, ''));
      const msg = info.missing.length
        ? `${info.name}: ${info.found} textures (${info.missing.length} not in pack, using built-ins)`
        : `${info.name}: all ${info.found} textures loaded`;
      showHint(msg, 'ok');
      game.toast(msg, 'good');
      setTimeout(hideHint, 4000);
    } catch (err) {
      console.error('resource pack failed', err);
      showHint(`Could not load pack: ${err.message}`, 'error');
      game.toast(`Resource pack failed: ${err.message}`, 'bad');
      setTimeout(hideHint, 5000);
    }
  });
}
