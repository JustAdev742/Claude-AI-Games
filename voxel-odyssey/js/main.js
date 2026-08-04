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
import { Particles } from './fx/particles.js';
import { AudioSystem } from './fx/audio.js';
import { Resources } from './render/resources.js';
import { Sky } from './fx/sky.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';

const LOADING_TIPS = [
  'Tip: Hold left mouse to mine, right mouse to place.',
  'Tip: Press E to open your inventory and craft.',
  'Tip: Build a Crafting Table for the 3×3 grid.',
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

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingFill = document.getElementById('loading-fill');
  const loadingText = document.getElementById('loading-text');
  const loadingTip = document.getElementById('loading-tip');
  if (loadingTip) loadingTip.textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];

  // ---- core ----
  const events = new EventBus();
  const state = new GameState(events);
  const engine = new Engine(canvas, state.settings);
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
    blocks: Blocks,
    items: Items,
    // systems (filled in below)
    worldgen: null, world: null, player: null, entities: null,
    inventory: null, crafting: null, particles: null, audio: null,
    sky: null, hud: null, menus: null, resources: null,
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
  game.particles = new Particles(game);
  game.audio = new AudioSystem(game);
  game.sky = new Sky(game);
  game.entities = new EntityManager(game);
  game.player = new Player(game);
  game.hud = new HUD(game);
  game.menus = new Menus(game);
  game.resources = new Resources(game);

  // ---- init in dependency order ----
  // `resources` comes after `world` because building the atlas hands it
  // straight to World.setAtlas, which needs World's materials to exist.
  const initOrder = [
    'worldgen', 'world', 'resources', 'inventory', 'crafting', 'particles',
    'audio', 'sky', 'entities', 'player', 'hud', 'menus',
  ];
  for (const name of initOrder) {
    const sys = game[name];
    if (sys && typeof sys.init === 'function') {
      try { await sys.init(); }
      catch (err) { console.error(`init() failed for ${name}:`, err); }
    }
  }

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
      input.requestLock();
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
    game.entities.removeAll();
    game.particles.reset && game.particles.reset();

    // Spawn / restore the player.
    if (save) {
      game.world.applyEdits(save.edits || []);
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
    input.requestLock();
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
    input.requestLock();
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
        // Advance day/night while playing, or gently during the menu backdrop.
        game.sky.update(playing ? dt * state.get('daylightSpeed') : (state.mode === 'menu' ? dt * 0.3 : 0));
        if (playing) {
          game.player.update(dt);
          game.entities.update(dt);
        }
        game.world.update(dt, anchor);
        game.particles.update(dt);
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
      }

      game.audio.update(dt);
      // Animated block textures (water, fire) — advances layer indices only.
      if (game.resources) game.resources.update(dt);
      game.hud.update(dt);
      game.menus.update(dt);
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
