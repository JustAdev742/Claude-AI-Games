/* Iterate on the light engine in isolation before wiring it into the game. */
import { LightEngine, MAX_LIGHT } from '../js/world/lighting.js';
import { Chunk } from '../js/world/chunk.js';
import { ID } from '../js/world/blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, localIndex } from '../js/world/constants.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) pass++; else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); } };

// A tiny world: a fixed grid of chunks in a Map, matching the interface
// LightEngine expects (getChunk(cx,cz) -> Chunk|null).
function makeWorld(radius = 1) {
  const chunks = new Map();
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) chunks.set(`${cx},${cz}`, new Chunk(cx, cz));
  }
  return {
    chunks,
    getChunk(cx, cz) { return chunks.get(`${cx},${cz}`) || null; },
    set(wx, wy, wz, id) {
      const cx = Math.floor(wx / CHUNK_SX), cz = Math.floor(wz / CHUNK_SZ);
      const c = this.getChunk(cx, cz);
      if (c) c.blocks[localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)] = id;
    },
  };
}

function lightAll(world, eng) {
  for (const c of world.chunks.values()) eng.lightChunk(c);
  for (const c of world.chunks.values()) eng.seedFromNeighbours(c);
  let guard = 0;
  while (eng.pending > 0 && guard++ < 200) eng.update(500000);
  return guard;
}

/* ---- 1. flat ground: open sky above, dark below ---- */
{
  const w = makeWorld(1);
  const GROUND = 30;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= GROUND; y++) {
        w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, y === GROUND ? ID.GRASS : ID.STONE);
      }
    }
  }
  const e = new LightEngine(w);
  lightAll(w, e);
  ok('air above ground = full sky', e.getSky(0, GROUND + 1, 0) === MAX_LIGHT, e.getSky(0, GROUND + 1, 0));
  ok('surface block itself dark (opaque)', e.getSky(0, GROUND, 0) === 0, e.getSky(0, GROUND, 0));
  ok('deep underground dark', e.getSky(0, 10, 0) === 0, e.getSky(0, 10, 0));
  ok('no blocklight anywhere', e.getBlockLight(0, GROUND + 1, 0) === 0);
}

/* ---- 2. a roofed cave is dark; an open shaft is bright to the bottom ---- */
{
  const w = makeWorld(1);
  const GROUND = 40;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= GROUND; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
    }
  }
  // Carve a 1x1 vertical shaft at (4,4) from y=10 up through the surface.
  for (let y = 10; y <= GROUND; y++) w.set(4, y, 4, ID.AIR);
  // Carve a sealed room at y=20 (roof intact at y=21).
  for (let x = 8; x <= 11; x++) for (let z = 8; z <= 11; z++) w.set(x, 20, z, ID.AIR);

  const e = new LightEngine(w);
  lightAll(w, e);
  ok('open shaft lit to the bottom', e.getSky(4, 10, 4) === MAX_LIGHT, e.getSky(4, 10, 4));
  ok('sealed room is pitch dark', e.getSky(9, 20, 9) === 0, e.getSky(9, 20, 9));
  ok('sealed room corner dark too', e.getSky(11, 20, 11) === 0, e.getSky(11, 20, 11));
}

/* ---- 3. torch light falls off by 1 per block and is day-independent ---- */
{
  const w = makeWorld(1);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= 40; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
    }
  }
  // A long sealed corridor at y=20 running +x from x=0..20.
  for (let x = 0; x <= 20; x++) w.set(x, 20, 5, ID.AIR);
  const e = new LightEngine(w);
  lightAll(w, e);
  ok('corridor dark before torch', e.getBlockLight(3, 20, 5) === 0);

  // Place a glowstone (emits 14) at x=2.
  w.set(2, 20, 5, ID.GLOWSTONE);
  e.onBlockChanged(2, 20, 5, ID.AIR, ID.GLOWSTONE);
  while (e.pending > 0) e.update(500000);

  ok('glowstone cell = 14', e.getBlockLight(2, 20, 5) === 14, e.getBlockLight(2, 20, 5));
  ok('1 block away = 13', e.getBlockLight(3, 20, 5) === 13, e.getBlockLight(3, 20, 5));
  ok('5 blocks away = 9', e.getBlockLight(7, 20, 5) === 9, e.getBlockLight(7, 20, 5));
  ok('beyond radius = 0', e.getBlockLight(17, 20, 5) === 0, e.getBlockLight(17, 20, 5));

  // Remove it: the whole corridor must go dark again.
  w.set(2, 20, 5, ID.AIR);
  e.onBlockChanged(2, 20, 5, ID.GLOWSTONE, ID.AIR);
  while (e.pending > 0) e.update(500000);
  ok('after removal source dark', e.getBlockLight(2, 20, 5) === 0, e.getBlockLight(2, 20, 5));
  ok('after removal 3 away dark', e.getBlockLight(5, 20, 5) === 0, e.getBlockLight(5, 20, 5));
  ok('after removal far dark', e.getBlockLight(9, 20, 5) === 0, e.getBlockLight(9, 20, 5));
}

/* ---- 4. placing a block casts a shadow down the column ---- */
{
  const w = makeWorld(1);
  const GROUND = 20;
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= GROUND; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
    }
  }
  // Carve an open pit so sky reaches y=15 at (5,5).
  for (let y = 15; y <= GROUND; y++) w.set(5, y, 5, ID.AIR);
  const e = new LightEngine(w);
  lightAll(w, e);
  ok('pit lit before roofing', e.getSky(5, 15, 5) === MAX_LIGHT, e.getSky(5, 15, 5));

  // Roof it over at the surface.
  w.set(5, GROUND, 5, ID.STONE);
  e.onBlockChanged(5, GROUND, 5, ID.AIR, ID.STONE);
  while (e.pending > 0) e.update(500000);
  ok('pit dark after roofing', e.getSky(5, 15, 5) === 0, e.getSky(5, 15, 5));
  ok('roof cell dark after roofing', e.getSky(5, GROUND, 5) === 0, e.getSky(5, GROUND, 5));

  // Break it open again: daylight must return all the way down.
  w.set(5, GROUND, 5, ID.AIR);
  e.onBlockChanged(5, GROUND, 5, ID.STONE, ID.AIR);
  while (e.pending > 0) e.update(500000);
  ok('pit relit after breaking roof', e.getSky(5, 15, 5) === MAX_LIGHT, e.getSky(5, 15, 5));
}

/* ---- 5. light crosses chunk boundaries ---- */
{
  const w = makeWorld(1);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= 40; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
    }
  }
  // Corridor straddling the x=16 chunk seam (chunk 0 -> chunk 1).
  for (let x = 10; x <= 22; x++) w.set(x, 20, 5, ID.AIR);
  const e = new LightEngine(w);
  lightAll(w, e);

  // Torch at x=14 (chunk 0); x=18 is in chunk 1.
  w.set(14, 20, 5, ID.GLOWSTONE);
  e.onBlockChanged(14, 20, 5, ID.AIR, ID.GLOWSTONE);
  while (e.pending > 0) e.update(500000);
  ok('light crosses into next chunk', e.getBlockLight(18, 20, 5) === 10, e.getBlockLight(18, 20, 5));
  ok('neighbour chunk marked dirty', [...e.dirtyChunks].some((k) => k === '1,0'), [...e.dirtyChunks].join(' '));
}

/* ---- 6. negative coordinates behave (floor, not truncate) ---- */
{
  const w = makeWorld(1);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= 30; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
    }
  }
  for (let x = -10; x <= -2; x++) w.set(x, 20, -5, ID.AIR);
  const e = new LightEngine(w);
  lightAll(w, e);
  w.set(-8, 20, -5, ID.GLOWSTONE);
  e.onBlockChanged(-8, 20, -5, ID.AIR, ID.GLOWSTONE);
  while (e.pending > 0) e.update(500000);
  ok('negative coords: source lit', e.getBlockLight(-8, 20, -5) === 14, e.getBlockLight(-8, 20, -5));
  ok('negative coords: falloff', e.getBlockLight(-6, 20, -5) === 12, e.getBlockLight(-6, 20, -5));
}

/* ---- 7. water attenuates skylight with depth ---- */
{
  const w = makeWorld(1);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let y = 0; y <= 10; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.STONE);
      for (let y = 11; y <= 25; y++) w.set(cx * CHUNK_SX + lx, y, cz * CHUNK_SZ + lz, ID.WATER);
    }
  }
  const e = new LightEngine(w);
  lightAll(w, e);
  // Water is opacity 3, so a column loses 3 per block and is fully dark 5
  // blocks down. Sample inside that range to see the gradient.
  const y25 = e.getSky(0, 25, 0);  // first water block
  const y24 = e.getSky(0, 24, 0);
  const y23 = e.getSky(0, 23, 0);
  const y21 = e.getSky(0, 21, 0);  // 5 blocks down -> extinguished
  ok('water surface = 15-3', y25 === 12, y25);
  ok('water dims 3 per block', y24 === 9 && y23 === 6, `${y24},${y23}`);
  ok('water fully dark 5 blocks down', y21 === 0, y21);
  ok('below the pool stays dark', e.getSky(0, 12, 0) === 0);
}

console.log(`\n==== light engine: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
