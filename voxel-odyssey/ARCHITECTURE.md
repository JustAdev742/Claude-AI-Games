# Voxel Odyssey — module contracts

A first-person voxel sandbox built with Three.js (ES modules, no build step).
This document is the **authoritative interface contract**. Implement each module
exactly to these signatures so the pieces integrate. When in doubt, read the
already-written foundation files — they are the source of truth:

- `js/core/utils.js` — math, RNG (`RNG`, `mulberry32`, `hashString`), `Vec`, color helpers, `clamp`, `lerp`, `smoothstep`, `voxelKey`, `chunkKey`.
- `js/core/events.js` — `EventBus` (`on/once/off/emit`). Documented event names at top.
- `js/core/state.js` — `GameState` (`settings`, `get/set`, `flags`, save/load, `stats`, `addStat`).
- `js/core/input.js` — `Input` (`action`, `actionPressed`, `isDown`, `mouseDX/mouseDY`, `wheel`, `consumeWheel`, `mouseDown/mousePressed`, `requestLock/exitLock`, `moveAxis`, `touch`).
- `js/core/engine.js` — `Engine` (`scene`, `camera`, `renderer`, `fog`, `viewmodelScene`, `setFogColor`, `setFogRange`, `setFov`).
- `js/world/blocks.js` — `Blocks` registry + `ID` ids + `FACES` (6 faces, each `{dir:[x,y,z], corners:[[x,y,z]×4]}`) + `FACE_SHADE`.
- `js/world/constants.js` — `CHUNK_SX=16`, `CHUNK_SY=80`, `CHUNK_SZ=16`, `CHUNK_VOL`, `WATER_LEVEL=28`, `localIndex(x,y,z)`, `worldToChunk`, `worldToLocal`.
- `js/items/items.js` — `Items` registry + `Items.drawIcon(ctx2d, itemKey, size)` shared icon renderer.

## The `game` context

`main.js` builds one `game` object and passes it to every system constructor:

```
game = {
  THREE, engine, scene, camera, renderer,
  events, state, input,
  blocks: Blocks, items: Items,
  worldgen, world, player, entities, inventory, crafting,
  particles, audio, sky, hud, menus,
  dt, elapsed, seed, worldActive, rng,
  toast(text, kind),   // kind: 'good'|'warn'|'info'
  get mode(),          // 'menu' | 'play'  (=== state.flags.mode)
  flow,                // { startWorld, enterPlay, openPause, resumePlay, quitToMenu, saveGame }
}
```

Every system is `new System(game)` then (optionally) `await system.init()`, in this
order: worldgen, world, inventory, crafting, particles, audio, sky, entities, player,
hud, menus. Constructors should be cheap (store `this.game = game`); do real setup in
`init()`. Read everything you need off `game` at call time (do not cache siblings that
may not be constructed yet during your own constructor).

Coordinate conventions: **+Y is up**. Player/eye uses world units = 1 block. Block at
integer `(x,y,z)` occupies the cube `[x,x+1] × [y,y+1] × [z,z+1]`.

---

## js/world/noise.js  →  `export class Noise`

Deterministic gradient noise seeded from an integer.

```
new Noise(seed)                       // integer seed
noise.perlin2(x, y) -> [-1, 1]
noise.perlin3(x, y, z) -> [-1, 1]
noise.fbm2(x, y, octaves=4, freq=1, lac=2.0, gain=0.5) -> ~[-1, 1]
noise.fbm3(x, y, z, octaves=4, freq=1, lac=2.0, gain=0.5) -> ~[-1, 1]
noise.ridge2(x, y, octaves=4, freq=1) -> [0, 1]   // ridged multifractal for mountains
```

Implement classic Perlin with a seed-shuffled permutation table (use `mulberry32`
from utils to shuffle). No external deps. Must be pure & deterministic (same seed →
same output). Keep it allocation-free in the hot path.

---

## js/world/worldgen.js  →  `export class WorldGen`

```
new WorldGen(game)
worldgen.setSeed(seed)                 // (re)seed all internal Noise instances
worldgen.init()
worldgen.generateChunk(chunk)          // fill a Chunk's blocks via chunk.setLocal(lx,y,lz,id)
worldgen.biomeAt(wx, wz) -> string     // 'plains'|'forest'|'desert'|'mountains'|'snow'|'beach'|'ocean'
worldgen.heightAt(wx, wz) -> int       // terrain surface height (top solid y)
worldgen.columnInfo(wx, wz) -> { height, biome, temperature, moisture }
```

`generateChunk(chunk)`: `chunk` has `.cx`, `.cz`, and `setLocal(lx, y, lz, id)`. World
coords are `wx = cx*16 + lx`, `wz = cz*16 + lz`. Use `Blocks.ID.*` and constants
(`CHUNK_SY`, `WATER_LEVEL`). Generate:
- multi-octave height with biome-blended amplitude (plains flat, mountains via `ridge2`);
- layered ground: bedrock at y=0, stone below, dirt band, grass/sand/snow surface by biome;
- water filled up to `WATER_LEVEL`; beaches of sand near water;
- caves carved with `perlin3` (threshold) below the surface, never breaking bedrock;
- ore veins (coal/iron higher, gold/redstone mid, diamond/emerald deep) seeded deterministically;
- decorations on the surface: trees (oak/birch/pine by biome), cacti (desert), tall grass,
  flowers, mushrooms, the occasional pumpkin. Trees/structures may write blocks slightly
  outside the chunk only via the block ids placed within this chunk's columns — keep tree
  trunks/leaves within `[lx,lz]` columns of this chunk for simplicity (overhang is fine if
  it stays inside this chunk's x/z range; otherwise clamp).

Determinism: derive every random decision from `hashCombine(seed, wx, wz, salt)` /
a per-chunk `RNG` so regeneration matches. Never call `Math.random()`.

---

## js/world/chunk.js  →  `export class Chunk`, `export function meshChunk(...)`

```
new Chunk(cx, cz)
chunk.cx, chunk.cz
chunk.blocks   // Uint8Array(CHUNK_VOL)
chunk.light    // Uint8Array(CHUNK_VOL)  (optional skylight cache; may stay 0)
chunk.dirty    // boolean (needs remesh)
chunk.generated// boolean
chunk.getLocal(lx, y, lz) -> id          // returns 0 (air) if out of vertical range
chunk.setLocal(lx, y, lz, id)            // sets, marks dirty (no neighbour logic here)
chunk.fillColumn(lx, lz, fromY, toY, id) // inclusive helper
```

`Chunk` is a **pure data + geometry** module (no Three.js import) so it is
Node-testable. Meshing is a free function:

```
meshChunk(chunk, getBlock, opts) -> { opaque, water, cross }
```

- `getBlock(wx, wy, wz) -> id` samples any world voxel (provided by `World`, handles
  neighbours across chunk borders). For in-bounds local voxels you may read
  `chunk.blocks` directly for speed.
- `opts = { ao: true, worldOffset: {x: cx*16, z: cz*16} }`.
- Each of `opaque`, `water`, `cross` is `{ positions:number[], normals:number[],
  colors:number[], indices:number[] }` (plain arrays; may be empty). Positions are in
  **chunk-local** space (0..16, 0..CHUNK_SY) — `World` positions the mesh at the chunk origin.

Meshing rules (faces per `Blocks.FACES`, `Blocks.shouldRenderFace(id, neighborId)`):
- **opaque** bucket: every solid/leaf cube block except water and cross-type. For each of
  the 6 faces, emit a quad when `Blocks.shouldRenderFace(id, neighbor)` is true. Vertex
  color = `Blocks.faceColor(id, face)` × ambient-occlusion factor (if `opts.ao`) ×
  per-voxel tint variation (`tintVariation` from utils, subtle). Provide correct per-face
  normals from `FACES[f].dir`.
- **water** bucket: `Blocks.renderType(id)==='liquid'`. Top face lowered to y+0.88 when the
  block above is not water (so water has a surface). Cull water↔water shared faces.
- **cross** bucket: `Blocks.renderType(id)==='cross'`. Two diagonal quads forming an "X"
  spanning the cell (inset ~0.0), colored `Blocks.faceColor(id,2)`, normals pointing up.
  Used for flowers/tall grass/mushrooms/torch.
- Ambient occlusion: standard 3-neighbour-per-corner darkening; clamp factor to ~[0.45, 1].
  Use `Blocks.isSolid` / opacity for occluder test. Keep it cheap.

Indices use the four quad corners as two triangles (0,1,2, 0,2,3). Keep winding so faces
are visible from outside with `THREE.FrontSide` (cross uses DoubleSide material in World).

---

## js/world/world.js  →  `export class World`

Owns chunks, builds/streams meshes, edits, raycasting.

```
new World(game)
world.init()
world.reset(seed)                          // clear all chunks/meshes/edits, set seed
world.getBlock(wx, wy, wz) -> id           // air above range; bedrock semantics handled by gen; ungenerated → generate on demand (sync) OR return air if not loaded — see note
world.setBlock(wx, wy, wz, id, opts={}) -> bool
       // updates chunk, records an edit diff, queues remesh of this chunk (+ border
       // neighbour), emits 'block:update' and (if opts.cause) 'block:break'/'block:place'
world.getChunk(cx, cz) -> Chunk|null
world.ensureChunk(cx, cz) -> Chunk         // create + generate + apply edits if missing
world.isSolid(wx, wy, wz) -> bool
world.isLiquid(wx, wy, wz) -> bool
world.heightAt(wx, wz) -> int              // topmost solid/leaf y (for spawning)
world.getGroundSpawn(wx, wz) -> {x, y, z}  // a safe standing position above ground
world.raycast(origin, dir, maxDist=6) -> { block:{x,y,z}, normal:{x,y,z}, place:{x,y,z}, blockId } | null
world.update(dt, anchor)                    // anchor: {x,y,z}. Load chunks within render
       // distance of the anchor, unload beyond it+1, and process a bounded meshing queue
       // per frame (e.g. up to ~3 builds/frame). Emit 'loading:progress' {value,text}
       // while priming and 'world:ready' once the spawn ring is meshed the first time.
world.serialize() -> { seed, edits: [[x,y,z,id], ...] }
world.applyEdits(edits)                     // re-apply saved diffs (before meshing)
```

Implementation notes:
- Chunk storage: `Map<chunkKey, Chunk>`; meshes in a `Map<chunkKey, {opaque,water,cross}>`
  of `THREE.Mesh`. Three shared materials created in `init()`:
  - opaque: `MeshLambertMaterial({ vertexColors:true })`
  - water: `MeshLambertMaterial({ vertexColors:true, transparent:true, opacity:0.72, depthWrite:false })`
  - cross: `MeshLambertMaterial({ vertexColors:true, side:THREE.DoubleSide, alphaTest:0.1, transparent:false })`
  Lighting comes from `Sky` (hemisphere + sun directional), so meshes must have correct
  normals; AO is multiplied into vertex colors.
- `getBlock` for a chunk that is not yet loaded should call `ensureChunk` so meshing of a
  border face always has neighbour data. (Generation is cheap and deterministic.)
- `setBlock` writes to the chunk, stores the diff in an edits `Map<voxelKey,id>`, marks the
  chunk dirty (+ the neighbour chunk if on an x/z border), and queues a remesh. Light
  recompute is optional (Sky provides global lighting; you may skip per-block light).
- Build geometry: convert mesh data arrays to `THREE.BufferGeometry` (Float32 position/
  normal/color, Uint32 index), `computeBoundingSphere`. Reuse/replace meshes on remesh and
  dispose old geometries to avoid leaks.
- Meshing queue: prioritize chunks nearest the anchor. Cap work per frame to stay smooth.
- `raycast`: voxel DDA from `origin` along normalized `dir`; stop at first block where
  `Blocks.isSolid` OR cross/liquid? — treat **targetable** = `Blocks.isSolid(id)` ||
  render==='cross'. Return the hit block, the face `normal` stepped through, and `place`
  (the empty cell adjacent across that normal). Return null if nothing within `maxDist`.

---

## js/entities/player.js  →  `export class Player`

```
new Player(game)
player.init()
player.position            // THREE.Vector3 feet position
player.velocity            // THREE.Vector3
player.yaw, player.pitch   // radians
player.onGround, player.inWater, player.flying, player.sneaking, player.sprinting
player.health, player.maxHealth   // HP, max 20 (10 hearts)
player.gamemode            // 'survival' | 'creative'
player.spawnAt(x, y, z)
player.respawn()           // reset health, move to world spawn, refill
player.setGamemode(m)
player.update(dt)          // the big one — see below
player.getEyePosition() -> THREE.Vector3
player.getLookDir() -> THREE.Vector3
player.hurt(amount, source)   // applies damage, i-frames, emits 'player:hurt'/'player:die'
player.heal(amount)
player.serialize() -> {...}
player.load(obj)
```

`update(dt)` (only called by main when `mode==='play' && !paused`):
1. **Look**: if `input.locked` (or touch), apply `input.mouseDX/mouseDY * sensitivity` to
   yaw/pitch; clamp pitch to ±~89°; honor `settings.invertY`.
2. **Movement**: build wish-dir from `input.moveAxis()` rotated by yaw. Walk speed ~4.3,
   sprint ~5.6 (hold sprint or double-tap forward), sneak ~1.6 (and prevents walking off
   edges). In water, slower + buoyancy. Creative `flying` toggled by double-tap jump or the
   `fly` action: vertical via jump/sneak, no gravity. Apply gravity (~ -28/s²) otherwise.
3. **Collision**: swept AABB (width ~0.6, height ~1.8, eye ~1.62) resolved axis-by-axis
   against solid voxels via `world.isSolid`. Set `onGround`. Step-up small ledges optional.
4. **Interaction** (raycast `world.raycast(eye, lookDir, reach)` reach ~5):
   - Left mouse held → mine the targeted block: accumulate progress vs `Blocks.hardness`
     scaled by held-tool power (`Items.get(key).tool`). On break: `world.setBlock(...,AIR,
     {cause:'break', by:'player'})`, spawn break particles (`game.particles` will react to
     the event, but you may also call directly), play 'break' sfx, and drop the block's item
     via `game.entities.dropItem(cx+0.5, y+0.5, cz+0.5, dropKey, 1)` (use `Items.dropFor`).
     In creative, break is instant and yields no drop.
   - Left mouse pressed with a mob under the crosshair (`game.entities.raycastClosest`) →
     attack it for `Items.attack(heldKey)` damage instead of mining.
   - Right mouse pressed → if held item is placeable (`Items.isPlaceable`) place its block at
     `hit.place` (only if not intersecting the player AABB and target cell is air/replaceable),
     consume 1 from inventory, emit place + sfx. If held item is food and health < max →
     eat (heal `Items.get().food`, consume 1, 'eat' sfx). If targeting a crafting table →
     open the 3×3 crafting via `game.menus.toggleInventory(true)`.
   - Mouse wheel / number keys 1-9 → `game.inventory.scrollSelected` / `setSelected`.
   - `drop` action (Q) → drop one of the selected item as a world item entity.
5. **Camera**: set `game.camera.position` to eye, apply yaw/pitch (set
   `camera.rotation.set(pitch, yaw, 0, 'YXZ')`). Optional view-bob when `settings.viewBobbing`.
6. **Environment**: fall damage on hard landings; drowning when eyes underwater too long;
   set HUD water/hurt overlays via events; lava/cactus contact damage optional.
7. Emit a throttled `'player:move'` for systems that care.

Hold a small first-person **viewmodel** (the held block/tool) in `engine.viewmodelScene`
that updates with the selected item and bobs/ swings on use (optional but nice).

---

## js/entities/mob.js  →  `export class Mob`, `export const MOB_TYPES`

```
MOB_TYPES = {
  pig:     { hostile:false, hp:10, speed:1.6, drops:[{item:'raw_meat',min:1,max:2}], color..., size... },
  cow:     { hostile:false, hp:10, ... drops leather + raw_meat },
  sheep:   { hostile:false, hp:8,  ... drops raw_meat (+ wool? optional) },
  chicken: { hostile:false, hp:4,  ... drops feather + raw_meat },
  zombie:  { hostile:true,  hp:20, speed:2.2, attack:3, drops:[{item:'raw_meat'}] },
  skeleton:{ hostile:true,  hp:16, speed:2.4, attack:2, ranged:true, drops:['bone'] },
  spider:  { hostile:true,  hp:16, speed:2.8, attack:2, drops:['string'] },
}
new Mob(game, type, x, y, z)
mob.type, mob.hostile, mob.health, mob.dead
mob.mesh            // THREE.Group of boxes (built in constructor) added to scene by EntityManager
mob.position        // THREE.Vector3 (mirror of mesh.position, feet)
mob.update(dt)      // AI + physics
mob.hurt(amount, source)   // knockback + flash; on death set dead, drop loot via game.entities.dropItem, emit 'entity:death'
mob.remove()        // remove mesh from scene
mob.serialize()
```

AI: gravity + simple AABB vs `world.isSolid` (reuse a small collide helper; size from type).
Passive mobs wander randomly, pause, avoid water/cliffs loosely. Hostile mobs: when the
player is within ~16 and (it's night via `game.sky.getLightLevel() < 0.35` or they're already
aggro), path toward the player (greedy step + jump over 1-block ledges) and melee on contact
(respect an attack cooldown, call `game.player.hurt(attack, this)`). Skeletons may shoot a
simple projectile (optional; a melee fallback is fine). Build the mesh from a few colored
`THREE.BoxGeometry` parts (body/head/legs) using `MeshLambertMaterial` so Sky lighting
applies; give a gentle leg-swing animation while moving. Flash red briefly on hurt.

---

## js/entities/entityManager.js  →  `export class EntityManager`

```
new EntityManager(game)
em.init()
em.entities          // Mob[]
em.items             // dropped item entities []
em.spawn(type, x, y, z) -> Mob
em.dropItem(x, y, z, itemKey, count=1) -> entity   // small spinning icon the player collects
em.update(dt)        // update mobs + item pickups; ambient spawning; despawn far; cap counts
em.raycastClosest(origin, dir, maxDist) -> { entity, dist } | null   // for melee targeting
em.damageEntity(entity, amount, source)
em.removeAll()
```

Spawning: keep a soft cap (~ a few dozen near the player). Passive mobs spawn in daytime on
grass within render range; hostile mobs spawn at night on solid ground away from the player
and the cap rises at night. Despawn mobs beyond ~ render distance + a margin. Item entities
bob/spin; when the player is within ~1.3 blocks, add to `game.inventory` (respect leftover)
and `'item:pickup'`; despawn items after ~5 minutes. Build item-entity visuals with a small
canvas-textured sprite or a tiny box colored by `Blocks.iconColor`.

---

## js/items/inventory.js  →  `export class Inventory`

```
new Inventory(game)
inv.init()
inv.size = 36                 // slots 0..8 hotbar, 9..35 main storage
inv.slots                    // Array(36) of {id, count} | null
inv.selected                 // 0..8 hotbar index
inv.selectedItem() -> stack | null
inv.hotbar() -> stack[]      // slots 0..8
inv.setSelected(i)           // emits 'hotbar:select' {index,item}
inv.scrollSelected(delta)    // wraps 0..8, emits 'hotbar:select'
inv.add(itemKey, count) -> remaining   // stacks into partials then empties; emits 'inventory:change'
inv.removeAt(slot, count) -> removed
inv.removeSelected(count=1) -> removed
inv.count(itemKey) -> total
inv.has(itemKey, n) -> bool
inv.consume(itemKey, n) -> bool        // remove n if available; emits change
inv.swap(a, b)               // slot swap/merge for drag&drop; emits change
inv.placeFromCursor / take... // (optional helpers for menu drag; menus may also just manipulate slots + emit)
inv.reset()                  // clear all
inv.giveStarter()            // a friendly starter kit (some planks, torches, a wooden pickaxe, bread)
inv.serialize() -> {slots, selected}
inv.load(obj)
```

Respect `Items.stackSize(key)`. `add` returns the count that did not fit. Always emit
`'inventory:change'` after mutations so the HUD/menus refresh.

---

## js/items/crafting.js  →  `export class Crafting`

```
new Crafting(game)
crafting.init()
crafting.match(grid) -> { output:{id,count}, recipe } | null
        // grid: length-9 array (3×3, row-major) of itemKey|null. Supports a 2×2 subset
        // (top-left) for the inventory crafting; shaped recipes are position-normalized
        // (trim empty border rows/cols), shapeless recipes match by multiset.
crafting.craftOnce(grid) -> {id,count} | null   // returns output and MUTATES grid removing 1 of each used cell
crafting.list() -> recipe[]                      // for the recipe-book UI
crafting.canCraft(recipe, inventory) -> bool     // enough materials anywhere in inventory
crafting.autoCraft(recipe) -> bool               // pull from inventory, add output (recipe-book one-click)
```

Define a solid recipe set using item keys from `Items`: log→4 planks (shapeless, any log
type), 2 planks (vertical)→4 sticks, 4 planks (2×2)→crafting_table, sticks+planks/cobble/
iron/diamond tool patterns (pickaxe/axe/shovel/sword for each tier), 8 cobble (ring)→furnace,
coal+stick→4 torch, 3 wheat (row)→bread, 4 clay_ball (2×2)→clay block? (use bricks via smelt
instead — your call), 4 brick (2×2)→bricks block, sand→? (skip), 6 planks→? , glowstone, etc.
Keep recipes intuitive and craftable from early materials. Document each recipe with an `id`
and a display `name` for the recipe book.

---

## js/fx/particles.js  →  `export class Particles`

```
new Particles(game)
particles.init()      // create a pooled THREE.Points (or small instanced quads), add to scene
particles.update(dt)  // integrate velocities + gravity, fade, recycle
particles.reset()
particles.blockBreak(x, y, z, blockId)        // colored burst
particles.emit(x, y, z, color, count, opts)   // generic burst
particles.splash(x, y, z)                      // water splash
particles.spark(x, y, z, color)
```

Should subscribe to events in `init()` so effects happen automatically:
`'block:break'`→`blockBreak`, `'block:place'`→small puff, `'player:hurt'`→red sparks at the
camera, `'entity:death'`→puff at the mob. Use a single pooled `THREE.Points` with
`vertexColors` + size attenuation for performance; cap at ~2000 live particles.

---

## js/fx/audio.js  →  `export class AudioSystem`

```
new AudioSystem(game)
audio.init()          // do NOT create AudioContext here (needs a user gesture)
audio.resume()        // lazily create/resume the AudioContext (call on first click/lock)
audio.play(name, opts={})  // synthesized SFX
audio.update(dt)
audio.startMusic()    // gentle generative ambient pad/melody
audio.stopMusic()
audio.setVolumes()    // read from settings
```

All sound is **synthesized** with the WebAudio API (oscillators + filtered noise) — no audio
files. Implement at least: `break`, `place`, `step` (vary by surface via opts.surface),
`hurt`, `mobHurt`, `splash`, `craft`, `eat`, `click`, `levelup`, `explode`. Respect
`settings.masterVolume/sfxVolume/musicVolume`. Subscribe to `'sfx'` events
(`{name, opts}`), `'block:break'`, `'block:place'`, `'player:hurt'`, `'craft'`,
`'item:pickup'` to play sounds automatically. Be defensive: every call must no-op safely if
the context isn't ready. Keep CPU/voices bounded.

---

## js/fx/sky.js  →  `export class Sky`

```
new Sky(game)
sky.init()            // create sky dome, sun+moon, stars, clouds, hemisphere + sun lights
sky.update(dt)        // advance timeOfDay; recolor sky/fog/light; move sun/moon; fade stars
sky.timeOfDay         // 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset)
sky.setTime(t)
sky.getPhase() -> 'dawn'|'day'|'dusk'|'night'
sky.getLightLevel() -> 0..1     // global brightness, used by mob spawning + HUD
sky.serialize() -> {timeOfDay}
sky.load(obj)
```

A full day lasts ~10 minutes (`dt` passed in is already scaled by `daylightSpeed`). Drive:
- a large inverted sphere (`BackSide`) with a vertical gradient (top sky color → horizon)
  recolored per time of day (warm at dawn/dusk, blue at noon, deep navy at night);
- `engine.setFogColor` / `scene.background` follow the horizon color; `setFogRange` may widen
  by day and tighten at night;
- a `HemisphereLight` (sky/ground) + a `DirectionalLight` "sun" orbiting overhead; intensity
  and warmth vary with time; a dim moon light at night;
- a `THREE.Points` starfield that fades in at night;
- a few drifting cloud planes (only when `settings.fancyGraphics`).
Emit `'time:phase'` when the phase changes and `'time:day'` at each new dawn.

---

## js/ui/hud.js  →  `export class HUD`

DOM HUD injected into `#hud-layer`. Build elements in `init()`.

```
new HUD(game)
hud.init()
hud.setVisible(on)
hud.update(dt)          // refresh health pips, clock, fps/coords/biome/time, debug overlay
hud.refreshHotbar()     // redraw the 9 hotbar slot icons + counts + selected highlight
hud.toast(text, kind)
hud.showHotbarLabel(name)
hud.setOverlay(kind, on) // 'hurt' | 'water'
```

Build: crosshair, hotbar (9 `.slot` divs, each with a `<canvas>` drawn via
`Items.drawIcon`), health pips (heart SVGs, 10 hearts = 20 HP, halves), a small analog
`#clock` canvas, an `#info-panel` (coords/biome/time/gamemode), `#toast-wrap`, a hotbar
item-name label, `#screen-overlay`, and a `#debug` block toggled by `state.flags.debug`.
Subscribe: `'inventory:change'`→`refreshHotbar`, `'hotbar:select'`→update highlight+label,
`'player:hurt'`→flash hurt overlay, `'toast'`→`toast`. Read `game.player.health`,
`game.player.position`, `game.sky.timeOfDay`, `game.worldgen.biomeAt`, `engine.fps`.

---

## js/ui/menus.js  →  `export class Menus`

DOM menus injected into `#menu-layer`. Build lazily / in `init()`.

```
new Menus(game)
menus.init()
menus.showMainMenu()     // New World (seed + gamemode), Continue (if save), Settings, How to Play, Credits
menus.showPause()        // Resume, Settings, Save & Quit to Title
menus.showSettings(back) // sliders/toggles bound to state (renderDistance, fov, sensitivity, volumes, fancyGraphics, viewBobbing, invertY, daylightSpeed); `back` = where to return
menus.showDeath()        // "You died" + stats + Respawn / Title
menus.showControls()     // controls table / how to play
menus.toggleInventory(forceCraftingTable=false)  // open/close the inventory+crafting screen
menus.hide()             // close any open menu overlay
menus.isOpen() -> bool
menus.update(dt)         // optional (tooltip following cursor, etc.)
```

Flow buttons **emit events** (main.js handles them): `'game:new'` `{seed, gamemode}`,
`'game:continue'`, `'game:save'`, `'game:quit'`, `'game:respawn'`. Settings controls call
`state.set(key, value)` directly (and apply live effects via the `'settings:change'` event,
which world/engine/sky/audio already listen to where relevant — for FOV call
`engine.setFov`, for renderDistance the World reads `settings.renderDistance` each frame).

The **inventory screen**: render the 27 main + 9 hotbar slots, a crafting grid (2×2 by
default, 3×3 when opened on a crafting table or via `forceCraftingTable`), an output slot,
and a scrollable recipe book (`crafting.list()` icons; click to `crafting.autoCraft`).
Implement click-to-pick-up / click-to-place drag using a `#drag-ghost`, manipulating
`game.inventory.slots` (then emit `'inventory:change'`). Use `Items.drawIcon` for every
slot. Show item tooltips via `#tooltip`. Opening any menu should `input.exitLock()`; closing
the inventory in play mode should `input.requestLock()` (main handles pause via pointerlock).

Set `state.flags.inventoryOpen` appropriately when the inventory opens/closes so main.js's
pointer-lock logic behaves.

---

## Testing hooks

Pure logic modules (`noise`, `worldgen`, `chunk` meshing, `inventory`, `crafting`) must work
when imported in Node (no `window`/Three.js at import time). Avoid top-level Three.js usage in
those files (import Three only where geometry is built — that lives in `world.js`,
`particles.js`, `sky.js`, `player.js`, `mob.js`, UI). `meshChunk` returns plain arrays so it
can be unit-tested headless.
