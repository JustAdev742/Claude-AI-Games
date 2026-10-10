/* =========================================================================
   vertexPack.js — the compact vertex format for chunk meshes.

   The mesher produces generous plain arrays (position, normal, colour, light,
   AO, UV and texture layer: 15 floats = 60 bytes per vertex). That is a lot to
   upload and, worse, to re-read from memory every frame on an integrated GPU
   that shares its memory bandwidth with the CPU. Most of it is redundant:

     normal      one of six axis directions            -> a face number
     uv          always 0 or 1 at a face corner         -> two bits
     light, AO   8-bit precision is plenty               -> bytes
     colour      a multiplier in 0..2                    -> a byte per channel
     position    chunk-local, at most 80 high            -> 16-bit fixed point

   packed into 16 bytes per vertex across three attributes:

     aPos   Uint16 x4   x, y, z in 1/256 block, and (texture layer + 1; 0 = none)
     aCol   Uint8  x4   r/2, g/2, b/2 (normalised), and the uv corner code u+2v
     aMisc  Uint8  x4   skylight, blocklight, ao (normalised), face/5

   The vertex shader (render/material.js, COMPACT) decodes all of it. Pure
   functions with no Three.js, so the mesher worker and the Node tests share it.
   ========================================================================= */

export const POS_SCALE = 256;            // fixed-point steps per block
export const COLOR_RANGE = 2;            // colour multipliers are stored as value / COLOR_RANGE

// Face numbers match FACES in blocks.js: +X -X +Y -Y +Z -Z.
export function faceOfNormal(nx, ny, nz) {
  if (nx > 0.5) return 0;
  if (nx < -0.5) return 1;
  if (ny > 0.5) return 2;
  if (ny < -0.5) return 3;
  return nz > 0.5 ? 4 : 5;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

/* Pack one mesher bucket ({positions, normals, colors, light, ao, uv, texIdx,
   indices} as plain arrays or typed arrays). Returns typed arrays ready to
   become BufferAttributes, or null for an empty bucket. */
export function packBucket(b) {
  const n = b.positions.length / 3;
  if (n === 0 || b.indices.length === 0) return null;

  const pos = new Uint16Array(n * 4);
  const col = new Uint8Array(n * 4);
  const misc = new Uint8Array(n * 4);
  const P = b.positions, N = b.normals, C = b.colors, L = b.light, A = b.ao, U = b.uv, T = b.texIdx;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    pos[o] = (P[i * 3] * POS_SCALE + 0.5) | 0;
    pos[o + 1] = (P[i * 3 + 1] * POS_SCALE + 0.5) | 0;
    pos[o + 2] = (P[i * 3 + 2] * POS_SCALE + 0.5) | 0;
    pos[o + 3] = T[i] + 1;                                   // -1 (untextured) -> 0

    const k = 255 / COLOR_RANGE;
    col[o] = clamp255(C[i * 3] * k);
    col[o + 1] = clamp255(C[i * 3 + 1] * k);
    col[o + 2] = clamp255(C[i * 3 + 2] * k);
    col[o + 3] = (U[i * 2] > 0.5 ? 1 : 0) + (U[i * 2 + 1] > 0.5 ? 2 : 0);

    misc[o] = clamp255(L[i * 2] * 255);
    misc[o + 1] = clamp255(L[i * 2 + 1] * 255);
    misc[o + 2] = clamp255(A[i] * 255);
    misc[o + 3] = faceOfNormal(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) * 51;   // face / 5 in 0..255
  }

  // 16-bit indices when they fit (nearly always): half the index memory.
  const idx = n <= 65535 ? Uint16Array.from(b.indices) : Uint32Array.from(b.indices);
  return { pos, col, misc, indices: idx, count: n };
}

// The buffers of a packed bucket, for postMessage transfer lists.
export function packedBuffers(p) {
  return p ? [p.pos.buffer, p.col.buffer, p.misc.buffer, p.indices.buffer] : [];
}

/* Decode vertex i back to the mesher's representation. Used by tests and by
   debugging probes; the shader does the same arithmetic on the GPU. */
export function unpackVertex(p, i) {
  const o = i * 4;
  const face = Math.round(p.misc[o + 3] / 51);
  const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return {
    x: p.pos[o] / POS_SCALE, y: p.pos[o + 1] / POS_SCALE, z: p.pos[o + 2] / POS_SCALE,
    texIdx: p.pos[o + 3] - 1,
    r: p.col[o] * COLOR_RANGE / 255, g: p.col[o + 1] * COLOR_RANGE / 255, b: p.col[o + 2] * COLOR_RANGE / 255,
    u: p.col[o + 3] & 1, v: (p.col[o + 3] >> 1) & 1,
    sky: p.misc[o] / 255, blk: p.misc[o + 1] / 255, ao: p.misc[o + 2] / 255,
    normal: NORMALS[face],
  };
}
