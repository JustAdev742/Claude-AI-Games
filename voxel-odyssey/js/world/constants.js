/* =========================================================================
   constants.js — world dimensions and the shared voxel index function.

   Chunks are full-height columns (no vertical subdivision), which keeps
   meshing and edits simple: changing a block only ever remeshes its own
   chunk (plus a horizontal neighbour when the block sits on a border).

   Block ids are stored in a Uint8Array (we have < 256 ids), light in a
   parallel Uint8Array. Index order is x-major, then z, then y, which keeps a
   vertical column contiguous in memory (good for height scans and meshing).
   ========================================================================= */

export const CHUNK_SX = 16;   // chunk width  (x)
export const CHUNK_SY = 80;   // world height (y)
export const CHUNK_SZ = 16;   // chunk depth  (z)
export const CHUNK_VOL = CHUNK_SX * CHUNK_SY * CHUNK_SZ;

export const WATER_LEVEL = 28;
export const BEACH_LEVEL = WATER_LEVEL + 2;
export const MAX_HEIGHT = CHUNK_SY - 1;

// Local (in-chunk) index. x,z in [0,16), y in [0,CHUNK_SY).
export function localIndex(x, y, z) {
  return (x * CHUNK_SZ + z) * CHUNK_SY + y;
}

// Convert world coords to chunk coords / local coords.
export function worldToChunk(wx, wz) {
  return { cx: Math.floor(wx / CHUNK_SX), cz: Math.floor(wz / CHUNK_SZ) };
}
export function worldToLocal(wx, wz) {
  return {
    lx: ((wx % CHUNK_SX) + CHUNK_SX) % CHUNK_SX,
    lz: ((wz % CHUNK_SZ) + CHUNK_SZ) % CHUNK_SZ,
  };
}

export function inVerticalRange(y) { return y >= 0 && y < CHUNK_SY; }
