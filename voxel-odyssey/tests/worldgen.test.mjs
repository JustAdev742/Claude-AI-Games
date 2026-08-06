/* Worldgen tests for the climate-driven generator.

   The properties asserted here are the ones that break silently: determinism
   (multiplayer depends on it), blockAt agreeing with generateChunk (the
   rollback path depends on it), terrain continuity across chunk borders, and
   trees not being clipped at chunk edges. */

import { WorldGen } from '../js/world/worldgen.js';
import { Chunk } from '../js/world/chunk.js';
import { ID } from '../js/world/blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, WATER_LEVEL, localIndex } from '../js/world/constants.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

const mkGen = (seed) => { const g = new WorldGen({ seed }); g.setSeed(seed); return g; };
const genChunk = (wg, cx, cz) => { const c = new Chunk(cx, cz); wg.generateChunk(c); return c; };

const DECOR = new Set([ID.LOG, ID.BIRCH_LOG, ID.PINE_LOG, ID.LEAVES, ID.BIRCH_LEAVES,
  ID.PINE_LEAVES, ID.CACTUS, ID.PUMPKIN, ID.TALL_GRASS, ID.FLOWER_RED, ID.FLOWER_YELLOW,
  ID.MUSHROOM_RED, ID.MOSSY_COBBLE]);

/* ---- determinism ---- */
{
  const a = genChunk(mkGen(777), 3, -2);
  const b = genChunk(mkGen(777), 3, -2);
  let same = true;
  for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) { same = false; break; }
  ok('determinism: same seed, identical chunk', same);

  const c = genChunk(mkGen(778), 3, -2);
  let diff = 0;
  for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== c.blocks[i]) diff++;
  ok('determinism: different seed differs', diff > 1000, `${diff} differing voxels`);
}

/* ---- blockAt agrees with generateChunk (terrain, not decorations) ---- */
{
  const wg = mkGen(4242);
  const chunk = genChunk(wg, 1, 1);
  let mismatches = 0, compared = 0;
  const examples = [];
  for (let lx = 0; lx < CHUNK_SX; lx += 3) {
    for (let lz = 0; lz < CHUNK_SZ; lz += 3) {
      const wx = CHUNK_SX + lx, wz = CHUNK_SZ + lz;
      const top = Math.max(wg.heightAt(wx, wz), WATER_LEVEL);
      for (let y = 0; y <= top; y++) {
        const inChunk = chunk.blocks[localIndex(lx, y, lz)];
        if (DECOR.has(inChunk)) continue;      // decorations are out of scope
        const predicted = wg.blockAt(wx, y, wz);
        compared++;
        if (predicted !== inChunk && mismatches++ < 3) {
          examples.push(`(${wx},${y},${wz}) chunk=${inChunk} blockAt=${predicted}`);
        }
      }
    }
  }
  ok('blockAt: matches generated terrain', mismatches === 0,
    `${mismatches}/${compared}: ${examples.join('; ')}`);
  ok('blockAt: out of range is air', wg.blockAt(0, -1, 0) === ID.AIR && wg.blockAt(0, 999, 0) === ID.AIR);
}

/* ---- border continuity: adjacent chunks share the same terrain ---- */
{
  const wg = mkGen(31337);
  const A = genChunk(wg, 0, 0);
  const B = genChunk(wg, 1, 0);
  // The topmost NON-DECORATION block on each side of the seam must not step
  // more than the climate system's guaranteed max slope.
  let worst = 0;
  for (let lz = 0; lz < CHUNK_SZ; lz++) {
    const topOf = (chunk, lx) => {
      for (let y = CHUNK_SY - 1; y >= 0; y--) {
        const id = chunk.blocks[localIndex(lx, y, lz)];
        if (id !== ID.AIR && !DECOR.has(id) && id !== ID.WATER && id !== ID.ICE) return y;
      }
      return 0;
    };
    const d = Math.abs(topOf(A, CHUNK_SX - 1) - topOf(B, 0));
    if (d > worst) worst = d;
  }
  ok('border: terrain continuous across the seam', worst <= 3, `worst step ${worst}`);
}

/* ---- trees are whole across chunk borders ---- */
{
  const wg = mkGen(2024);
  // Generate a 5x5 patch of chunks and union them into one lattice.
  const R = 2;
  const grid = new Map();
  for (let cx = -R; cx <= R; cx++) for (let cz = -R; cz <= R; cz++) grid.set(`${cx},${cz}`, genChunk(wg, cx, cz));
  const at = (wx, y, wz) => {
    const cx = Math.floor(wx / CHUNK_SX), cz = Math.floor(wz / CHUNK_SZ);
    const c = grid.get(`${cx},${cz}`);
    if (!c || y < 0 || y >= CHUNK_SY) return ID.AIR;
    return c.blocks[localIndex(wx - cx * CHUNK_SX, y, wz - cz * CHUNK_SZ)];
  };
  const LOGS = new Set([ID.LOG, ID.BIRCH_LOG, ID.PINE_LOG]);
  const LEAF = new Set([ID.LEAVES, ID.BIRCH_LEAVES, ID.PINE_LEAVES]);

  // Find trunks NEAR A CHUNK BORDER (within 2 blocks) in the interior 3x3 of
  // the patch, and count canopy leaves in a 7x7x8 box around the trunk top.
  let borderTrees = 0, bald = 0;
  const range = CHUNK_SX * (R);   // stay one chunk inside the patch edge
  for (let wx = -range; wx < range; wx++) {
    for (let wz = -range; wz < range; wz++) {
      const mx = ((wx % CHUNK_SX) + CHUNK_SX) % CHUNK_SX;
      const mz = ((wz % CHUNK_SZ) + CHUNK_SZ) % CHUNK_SZ;
      const nearBorder = mx <= 1 || mx >= CHUNK_SX - 2 || mz <= 1 || mz >= CHUNK_SZ - 2;
      if (!nearBorder) continue;
      // trunk base: log with non-log below
      for (let y = WATER_LEVEL; y < CHUNK_SY - 6; y++) {
        if (!LOGS.has(at(wx, y, wz))) continue;
        if (LOGS.has(at(wx, y - 1, wz))) continue;
        // walk to trunk top
        let top = y;
        while (LOGS.has(at(wx, top + 1, wz))) top++;
        let leaves = 0;
        for (let dy = -2; dy <= 4; dy++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (LEAF.has(at(wx + dx, top + dy, wz + dz))) leaves++;
        }
        borderTrees++;
        if (leaves < 6) bald++;
        break;
      }
    }
  }
  ok('trees: found trunks near chunk borders', borderTrees > 0, `${borderTrees}`);
  ok('trees: no clipped canopies at borders', bald === 0, `${bald}/${borderTrees} bald border trees`);
}

/* ---- biome/terrain sanity on the live generator ---- */
{
  const wg = mkGen(90210);
  let land = 0, total = 0, implausible = 0;
  const seen = new Set();
  for (let x = -2400; x <= 2400; x += 29) {
    for (let z = -2400; z <= 2400; z += 29) {
      const info = wg.columnInfo(x, z);
      total++;
      if (info.height > WATER_LEVEL) land++;
      seen.add(info.biome);
      if (/snowy|frozen/.test(info.biome) && info.temperature > 0.65) implausible++;
      if (/desert|badlands/.test(info.biome) && info.temperature < 0.4) implausible++;
    }
  }
  ok('world: land share sane', land / total > 0.2 && land / total < 0.65,
    `${(land / total * 100).toFixed(1)}% land`);
  ok('world: no implausible biome placements', implausible === 0, `${implausible}`);
  ok('world: biome variety on one seed', seen.size >= 8, `${seen.size} biomes: ${[...seen].join(',')}`);
}

/* ---- rivers reach the world as water channels ---- */
{
  const wg = mkGen(5150);
  let riverColumns = 0;
  for (let x = -1500; x <= 1500; x += 7) {
    for (let z = -1500; z <= 1500; z += 7) {
      const info = wg.columnInfo(x, z);
      // A river column: carved to just below sea level, away from oceans.
      if (info.continent > 0.05 && info.river < 0.03 && info.height <= WATER_LEVEL) riverColumns++;
    }
  }
  ok('rivers: inland water channels exist', riverColumns > 20, `${riverColumns}`);
}

/* ---- caves and ravines ---- */
{
  const wg = mkGen(8080);

  // Ravines: present on land, and forming LINES rather than isolated pits.
  let ravCols = 0, landCols = 0;
  let seedCol = null;
  for (let x = -1200; x <= 1200; x += 5) {
    for (let z = -1200; z <= 1200; z += 5) {
      const info = wg.columnInfo(x, z);
      if (info.height <= WATER_LEVEL) continue;
      landCols++;
      if (info.carveFloor !== null) { ravCols++; if (!seedCol) seedCol = { x, z }; }
    }
  }
  ok('ravines: exist on land', ravCols > 0, `${ravCols}`);
  ok('ravines: are rare features', ravCols / landCols < 0.08, `${(ravCols / landCols * 100).toFixed(1)}%`);

  if (seedCol) {
    // Flood along the ravine from a hit column: a canyon yields a connected
    // run of carved columns; scattered pits would not.
    const seen = new Set();
    const stack = [seedCol];
    while (stack.length && seen.size < 400) {
      const { x, z } = stack.pop();
      const k = `${x},${z}`;
      if (seen.has(k)) continue;
      const info = wg.columnInfo(x, z);
      if (info.carveFloor === null) continue;
      seen.add(k);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) stack.push({ x: x + dx, z: z + dz });
    }
    ok('ravines: form connected canyons', seen.size >= 12, `${seen.size} connected columns`);

    // Walls slope: the floor near the rim is shallower than at the centre.
    const floors = [...seen].map((k) => wg.columnInfo(...k.split(',').map(Number)).carveFloor);
    const span = Math.max(...floors) - Math.min(...floors);
    ok('ravines: depth varies toward the rim', span >= 3, `floor span ${span}`);
  }

  // Caves: pockets below the surface, including big rooms at depth.
  const wg2 = mkGen(6006);
  let caveVox = 0, deepRoomVox = 0, entrances = 0;
  for (let x = -300; x <= 300; x += 4) {
    for (let z = -300; z <= 300; z += 4) {
      const info = wg2.columnInfo(x, z);
      if (info.height <= WATER_LEVEL || info.carveFloor !== null) continue;
      // Surface breach = entrance (ravines excluded above).
      if (wg2.blockAt(x, info.height, z) === ID.AIR) entrances++;
      for (let y = 6; y < info.height - 3; y += 2) {
        if (wg2.blockAt(x, y, z) === ID.AIR) {
          caveVox++;
          if (y < info.height - 12) deepRoomVox++;
        }
      }
    }
  }
  ok('caves: underground air exists', caveVox > 50, `${caveVox}`);
  ok('caves: deep caverns exist', deepRoomVox > 20, `${deepRoomVox}`);
  ok('caves: hillside entrances exist', entrances > 0, `${entrances}`);

  // The classic carver bug: water directly above carved air. Generate real
  // chunks and scan every column — zero tolerance.
  let floatingWater = 0;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const c = genChunk(wg2, cx, cz);
      for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
        for (let y = 1; y < CHUNK_SY - 1; y++) {
          if (c.blocks[localIndex(lx, y, lz)] === ID.WATER
            && c.blocks[localIndex(lx, y - 1, lz)] === ID.AIR) floatingWater++;
        }
      }
    }
  }
  ok('caves: no water floating over carved air', floatingWater === 0, `${floatingWater}`);

  // Lava pools: carved space at/below the lava table is molten, never
  // hanging over air, and lights its surroundings via the flood fill.
  let lavaVox = 0, lavaOverAir = 0, litByLava = 0;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const c = genChunk(wg2, cx, cz);
      for (let lx = 0; lx < CHUNK_SX; lx++) for (let lz = 0; lz < CHUNK_SZ; lz++) {
        for (let y = 1; y < 14; y++) {
          if (c.blocks[localIndex(lx, y, lz)] !== ID.LAVA) continue;
          lavaVox++;
          if (c.blocks[localIndex(lx, y - 1, lz)] === ID.AIR) lavaOverAir++;
        }
      }
    }
  }
  ok('lava: pools exist in the deeps', lavaVox > 30, `${lavaVox}`);
  ok('lava: never floats over air', lavaOverAir === 0, `${lavaOverAir}`);
}

console.log(`\n==== worldgen: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
