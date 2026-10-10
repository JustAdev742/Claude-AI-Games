/* Chunk streaming tests against the real World (meshing runs on the main
   thread here, since Node has no Workers). Run via:
   node --import ./tests/three-resolve.mjs tests/streaming.test.mjs */
import { World } from '../js/world/world.js';
import { WorldGen } from '../js/world/worldgen.js';
import { Chunk } from '../js/world/chunk.js';
import { MeshPool } from '../js/world/meshPool.js';
import { EventBus } from '../js/core/events.js';
import { Perf } from '../js/core/perf.js';
import { ID } from '../js/world/blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from '../js/world/constants.js';
import { chunkKey, chunkKeyX, chunkKeyZ } from '../js/core/utils.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

function makeWorld(settings = {}, seed = 4242) {
  const added = new Set();
  const game = {
    events: new EventBus(),
    scene: { add: (m) => added.add(m), remove: (m) => added.delete(m) },
    state: { settings: Object.assign({ renderDistance: 4 }, settings), flags: {} },
    perf: new Perf(),
    seed,
  };
  game.worldgen = new WorldGen(game);
  game.worldgen.setSeed(seed);
  game.world = new World(game);
  game.world.init();
  game.world.reset(seed);
  let gen = 0;
  const orig = game.worldgen.generateChunk.bind(game.worldgen);
  game.worldgen.generateChunk = (c) => { gen++; return orig(c); };
  return { game, world: game.world, scene: added, genCount: () => gen };
}
const anchorAt = (cx, cz) => ({ x: cx * CHUNK_SX + 8, y: 40, z: cz * CHUNK_SZ + 8 });
const settle = (world, anchor, max = 400) => {
  for (let i = 0; i < max; i++) {
    world.update(0.016, anchor);
    if (world._planIdx >= world._plan.length && world.remeshQueue.size === 0 && world.meshPool.pending === 0) return i + 1;
  }
  return max;
};

/* ---- keys ---- */
{
  let good = true;
  const seen = new Set();
  for (let x = -40; x <= 40; x += 3) for (let z = -40; z <= 40; z += 3) {
    const k = chunkKey(x, z);
    if (chunkKeyX(k) !== x || chunkKeyZ(k) !== z || seen.has(k)) good = false;
    seen.add(k);
  }
  ok('keys: chunk keys are unique numbers that decode back', good && typeof chunkKey(1, 2) === 'number');
}

/* ---- priming: the loading screen waits for a small ring only ---- */
{
  const { game, world } = makeWorld({ renderDistance: 6 });
  let ready = false;
  game.events.on('world:ready', () => { ready = true; });
  // A fake clock that jumps 31 ms per reading, so every frame's budget is spent
  // after one chunk — standing in for a slow machine, where generation is not
  // as quick as it is here.
  const realNow = performance.now.bind(performance);
  let clock = 0;
  performance.now = () => (clock += 31);
  let frames = 0;
  while (!ready && frames < 600) { world.update(0.016, anchorAt(0, 0)); frames++; }
  performance.now = realNow;
  ok('prime: world:ready fires', ready, `${frames} frames`);
  ok('prime: ...long before the whole view distance has loaded', world.chunks.size < 100, `${world.chunks.size} chunks at ready (the full rd 6 ring is 113 drawn + skin)`);
  ok('prime: the spawn ring is meshed', [...world.chunks.values()].filter((c) => world.meshes.has(chunkKey(c.cx, c.cz))).length >= 25);
  settle(world, anchorAt(0, 0));
  ok('prime: streaming then completes the ring', world.chunks.size >= 113, `${world.chunks.size}`);
}

/* ---- only the ring (plus its data skin) is ever generated ---- */
{
  const { world } = makeWorld({ renderDistance: 4 });
  settle(world, anchorAt(0, 0));
  const rd = 4;
  let outside = 0, meshedOutside = 0;
  for (const c of world.chunks.values()) {
    const d = c.cx * c.cx + c.cz * c.cz;
    if (d > (rd + 0.5 + Math.SQRT2) ** 2 + 0.01) outside++;     // the drawn disc plus one chunk of skin
    if (d > (rd + 0.5) * (rd + 0.5) && world.meshes.has(chunkKey(c.cx, c.cz))) meshedOutside++;
  }
  ok('ring: nothing generated beyond the data ring (no on-demand generation while meshing)', outside === 0, `${outside}`);
  ok('ring: the outer data ring is not meshed (it only supplies neighbour data)', meshedOutside === 0, `${meshedOutside}`);
  const need = [...world.chunks.values()].filter((c) => c.cx * c.cx + c.cz * c.cz <= 4.5 * 4.5);
  ok('ring: every chunk in the drawn ring has a mesh entry', need.every((c) => world.meshes.has(chunkKey(c.cx, c.cz))), `${need.filter((c) => !world.meshes.has(chunkKey(c.cx, c.cz))).length} missing`);
}

/* ---- the time budget ---- */
{
  const { world, genCount } = makeWorld({ renderDistance: 6, streamBudgetMs: 0 });
  // Skip the loading phase (it has a large budget on purpose).
  world._primed = true;
  const before = genCount();
  world.update(0.016, anchorAt(0, 0));
  const made = genCount() - before;
  ok('budget: a frame always makes progress', made >= 1, `${made}`);
  ok('budget: ...but a tiny budget stops after the first chunk', made <= 2, `${made} chunks in one frame`);
  settle(world, anchorAt(0, 0), 2000);
  ok('budget: and everything still loads eventually', world.chunks.size >= 113, `${world.chunks.size}`);
}

/* ---- nearest first ---- */
{
  const { world } = makeWorld({ renderDistance: 5, streamBudgetMs: 0 });
  world._primed = true;
  const order = [];
  const orig = world.ensureChunk.bind(world);
  world.ensureChunk = (cx, cz) => { if (!world.chunks.has(chunkKey(cx, cz))) order.push(cx * cx + cz * cz); return orig(cx, cz); };
  settle(world, anchorAt(0, 0), 2000);
  let monotone = true;
  for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1]) { monotone = false; break; }
  ok('order: chunks are generated nearest-first', monotone && order.length > 50);
}

/* ---- moving: new terrain streams in, old terrain is unloaded ---- */
{
  const { world, scene } = makeWorld({ renderDistance: 3 });
  settle(world, anchorAt(0, 0));
  const startMeshes = scene.size;
  settle(world, anchorAt(12, 0));
  const lim = (3 + 1 + 2 + 0.5) ** 2;
  let far = 0;
  for (const c of world.chunks.values()) if ((c.cx - 12) ** 2 + c.cz ** 2 > lim) far++;
  ok('move: chunks far behind the player are unloaded', far === 0 && !world.chunks.has(chunkKey(0, 0)), `${far} far chunks`);
  ok('move: and the new ring is loaded and meshed', world.chunks.has(chunkKey(15, 0)) && world.meshes.has(chunkKey(14, 0)));
  ok('move: unloading released the meshes from the scene (no leak)', scene.size < startMeshes * 1.6, `${scene.size} vs ${startMeshes}`);
}

/* ---- edits survive unloading and are indexed per chunk ---- */
{
  const { world } = makeWorld({ renderDistance: 2 });
  settle(world, anchorAt(0, 0));
  world.setBlock(3, 70, 5, ID.GLASS, { cause: 'place' });
  world.setBlock(-5, 70, -20, ID.OBSIDIAN, { cause: 'place' });       // negative chunk coords
  ok('edits: indexed under their chunk', world._editsByChunk.get(chunkKey(0, 0)).size === 1 && world._editsByChunk.get(chunkKey(-1, -2)).size === 1);
  settle(world, anchorAt(40, 40));
  ok('edits: the edited chunks unloaded', !world.chunks.has(chunkKey(0, 0)));
  settle(world, anchorAt(0, 0));
  ok('edits: and come back with their edits applied', world.getBlock(3, 70, 5) === ID.GLASS && world.getBlock(-5, 70, -20) === ID.OBSIDIAN);
  world.setBlock(3, 70, 5, ID.AIR, { cause: 'break' });
  ok('edits: re-editing a voxel replaces, not duplicates', world._editsByChunk.get(chunkKey(0, 0)).size === 1 && world.getBlock(3, 70, 5) === ID.AIR);
  world.applyEdits([[100, 12, 100, ID.GOLD_ORE]]);
  ok('edits: applyEdits indexes too', world._editsByChunk.get(chunkKey(6, 6)).size === 1);
}

/* ---- remesh scheduling ---- */
{
  const { world } = makeWorld({ renderDistance: 3 });
  settle(world, anchorAt(0, 0));
  const key = chunkKey(1, 0);
  const before = world.meshes.get(key);
  world.setBlock(20, 50, 5, ID.STONE, { cause: 'place' });           // inside chunk (1,0)
  ok('remesh: an edit queues its chunk', world.remeshQueue.has(key));
  settle(world, anchorAt(0, 0));
  ok('remesh: ...and the mesh is rebuilt', world.meshes.get(key) !== before || world.meshes.get(key));
  // a chunk with a missing neighbour is not meshed
  const solo = new Chunk(30, 30);
  world.chunks.set(chunkKey(30, 30), solo);
  ok('ready: a lone chunk is not mesh-ready', !world._meshReady(solo));
  world.chunks.delete(chunkKey(30, 30));
}

/* ---- the fast neighbour packing equals the old per-voxel packing ---- */
{
  const { world } = makeWorld({ renderDistance: 3 });
  settle(world, anchorAt(0, 0));
  const chunk = world.getChunk(0, 0);
  const pool = new MeshPool(world);
  const { blocks, light } = pool._packNeighbourhood(chunk);
  const PAD = 1, PSX = CHUNK_SX + 2, PSZ = CHUNK_SZ + 2;
  const idx = (px, y, pz) => (px * PSZ + pz) * CHUNK_SY + y;
  let mismatches = 0;
  for (let px = 0; px < PSX; px++) {
    for (let pz = 0; pz < PSZ; pz++) {
      const wx = chunk.cx * CHUNK_SX + px - PAD, wz = chunk.cz * CHUNK_SZ + pz - PAD;
      for (let y = 0; y < CHUNK_SY; y++) {
        if (blocks[idx(px, y, pz)] !== world.getBlock(wx, y, wz)) mismatches++;
        if (light[idx(px, y, pz)] !== world.getLightByte(wx, y, wz)) mismatches++;
      }
    }
  }
  ok('pack: padded blocks and light equal the per-voxel reference everywhere (incl. corners)', mismatches === 0, `${mismatches} differing values`);
}

/* ---- the profiler ---- */
{
  const p = new Perf();
  p.add('a', 4); p.add('b', 1); p.add('a', 2);
  p.endFrame(10, 16);
  ok('perf: sections accumulate within a frame and smooth across frames', Math.abs(p.avg.a - 0.6) < 1e-9 && Math.abs(p.avg.b - 0.1) < 1e-9);
  p.endFrame(10, 80);
  ok('perf: hitches counted from wall-clock time', p.hitches === 1);
  ok('perf: report is ordered by cost', p.report()[0].startsWith('a'));
  ok('perf: percentiles', p.percentile(0.99) === 80);
}

console.log(`\n==== streaming: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
