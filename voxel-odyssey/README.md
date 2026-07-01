# 🌍 Voxel Odyssey

A fun, fully-featured **first-person voxel sandbox** that runs entirely in your
browser — explore an infinite procedurally-generated world, mine and build,
craft tools, survive the night, and watch the sun rise over your creations.

Built from scratch with **Three.js** (vendored locally — no build step, no
network required) and a hand-rolled voxel engine: procedural terrain & biomes,
greedy face-culled chunk meshing with ambient occlusion, swept-AABB physics,
day/night lighting, mobs with AI, crafting, particles, and fully synthesized
audio (no asset files anywhere).

![Voxel Odyssey gameplay](docs/gameplay.png)

<p align="center">
  <img src="docs/title.png" width="49%" alt="Title screen" />
  <img src="docs/sunset.png" width="49%" alt="Sunset over the plains" />
  <img src="docs/inventory.png" width="49%" alt="Inventory & crafting" />
</p>

## ▶️ Play

The game uses ES modules + an import map, so it must be served over HTTP (not
opened as a `file://`). From this folder:

```bash
# pick any one:
python3 -m http.server 8080
npx serve -l 8080 .
npx http-server -p 8080 .
```

Then open <http://localhost:8080> and click **New World**.

> Click the screen to capture the mouse. Press **Esc** to pause / release it.

## 🎮 Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look | Mouse |
| Jump | `Space` |
| Sprint | `Ctrl` (hold) or double-tap `W` |
| Sneak | `Shift` |
| Mine block | Hold **Left Mouse** |
| Place block / use / eat | **Right Mouse** |
| Attack mob | **Left Mouse** (click) |
| Select hotbar slot | `1`–`9` or mouse wheel |
| Open inventory / crafting | `E` |
| Drop item | `Q` |
| Toggle creative flight | `F` (in creative) |
| Debug overlay | `F3` |
| Pause / menu | `Esc` |

## ✨ Features

- **Infinite procedural world** — multi-octave terrain with plains, forests,
  deserts, mountains, snowy peaks, beaches and oceans; caves, ore veins, trees,
  flowers, cacti and mushrooms.
- **Mine & build** — 40+ block types, face-culled chunk meshing with ambient
  occlusion and per-voxel color variation for a clean low-poly look.
- **Crafting & inventory** — a full 36-slot inventory, 2×2 and 3×3 crafting,
  drag-and-drop, a recipe book, tools of five tiers, food, and torches.
- **Survival** — health, fall damage, drowning, hunger for food, and a
  **Creative** mode with flight for pure building.
- **Mobs** — passive animals (pig, cow, sheep, chicken) and hostiles that come
  out at night (zombie, skeleton, spider) with simple chase/melee AI.
- **Dynamic day/night** — a moving sun and moon, gradient sky, drifting clouds,
  a starfield, and fog that all shift through dawn, day, dusk and night.
- **Effects & audio** — block-break particles, water splashes, and a fully
  **synthesized** soundscape + gentle ambient music (zero audio files).
- **Saves** — your world (seed + your edits + inventory) persists in
  `localStorage`; **Continue** picks up where you left off.

## 🧱 Architecture

Everything is plain ES modules under `js/` (no bundler). See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full module contract.

```
index.html            import map + loading screen + UI layers
styles.css            HUD / menu / inventory styling
vendor/three.module.js  Three.js r160 (vendored, MIT)
js/
  main.js             bootstrap, game-flow state machine, the loop
  core/   utils, events (bus), state (settings/save), input, engine
  world/  constants, blocks (registry), noise, worldgen, chunk (mesher), world
  entities/  player, mob, entityManager
  items/  items (registry + icons), inventory, crafting
  fx/     particles, audio, sky
  ui/     hud, menus
tests/  run.js (node logic tests) + smoke.mjs (headless browser test)
```

## 🧪 Tests

```bash
node tests/run.js      # pure-logic unit tests (noise, worldgen, meshing, inventory, crafting)
node tests/smoke.mjs   # headless-Chromium smoke test (boots a world, checks it renders)
```

## 📄 License

MIT. Three.js © its authors (MIT), vendored in `vendor/`.
