/* =========================================================================
   mesher.worker.js — chunk meshing, off the main thread.

   Meshing a chunk walks 20,480 voxels and, for each visible face, samples a
   3x3 neighbourhood twice (ambient occlusion and smooth lighting). At a few
   milliseconds per chunk it is by far the largest single block of main-thread
   work the game does, and doing it during streaming is what produced the
   stutter when flying into new terrain.

   chunk.js was written to import no Three.js and touch no DOM precisely so it
   could run here unchanged: the worker imports the same meshChunk the main
   thread used to call, and returns plain typed arrays.

   THE NEIGHBOUR PROBLEM
   ---------------------
   A chunk's border faces need to know what is in the adjacent chunk — to cull
   faces against it, and to blend light across the seam. Shipping the eight
   surrounding chunks per job would be 9x the data. Instead the main thread
   builds a PADDED copy: the chunk plus a one-voxel skin of its neighbours
   (18 x 80 x 18). That is everything the mesher can reach, at ~1.27x the size
   of the chunk itself.

   All large buffers are transferred, not copied, in both directions.
   ========================================================================= */

import { meshChunk } from './chunk.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './constants.js';

const PAD = 1;
const PSX = CHUNK_SX + PAD * 2;
const PSZ = CHUNK_SZ + PAD * 2;

/* Index into the padded arrays. Mirrors localIndex's x-major layout so a
   vertical column stays contiguous. */
const padIndex = (px, y, pz) => (px * PSZ + pz) * CHUNK_SY + y;

/* A stand-in for TextureAtlas that only does what the mesher asks of it.
   The real atlas owns a THREE.DataArrayTexture, which cannot cross into a
   worker; the face->layer lookup table is a plain Int32Array, which can. */
function makeAtlasShim(faceLayer) {
  if (!faceLayer) return null;
  return {
    layerFor(blockId, face) { return faceLayer[blockId * 6 + face]; },
  };
}

let atlasShim = null;

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'atlas') {
    // Sent once whenever the resource pack changes.
    atlasShim = makeAtlasShim(msg.faceLayer);
    return;
  }

  if (msg.type !== 'mesh') return;

  const { jobId, cx, cz, blocks, light, ao, smoothLighting } = msg;
  const ox = cx * CHUNK_SX;
  const oz = cz * CHUNK_SZ;

  // Present the padded arrays to meshChunk through the same interface the
  // main thread uses: a chunk-like object plus getBlock/getLight callbacks
  // for anything outside it.
  const chunkLike = {
    cx, cz,
    // The inner region, re-projected out of the padded array on demand.
    blocks: null,
    light: null,
  };

  // meshChunk reads chunk.blocks with localIndex(lx,y,lz); the padded array
  // uses a different stride, so we unpack the interior once rather than
  // paying an index conversion per voxel access in the inner loop.
  const inner = new Uint8Array(CHUNK_SX * CHUNK_SY * CHUNK_SZ);
  const innerLight = new Uint8Array(CHUNK_SX * CHUNK_SY * CHUNK_SZ);
  for (let lx = 0; lx < CHUNK_SX; lx++) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const src = padIndex(lx + PAD, 0, lz + PAD);
      const dst = (lx * CHUNK_SZ + lz) * CHUNK_SY;
      inner.set(blocks.subarray(src, src + CHUNK_SY), dst);
      innerLight.set(light.subarray(src, src + CHUNK_SY), dst);
    }
  }
  chunkLike.blocks = inner;
  chunkLike.light = innerLight;

  const getBlock = (wx, wy, wz) => {
    if (wy < 0 || wy >= CHUNK_SY) return 0;
    const px = wx - ox + PAD;
    const pz = wz - oz + PAD;
    // Outside the padded skin the mesher can't legitimately reach; return air
    // so a stray read is harmless rather than an out-of-bounds index.
    if (px < 0 || px >= PSX || pz < 0 || pz >= PSZ) return 0;
    return blocks[padIndex(px, wy, pz)];
  };

  const getLight = (wx, wy, wz) => {
    if (wy >= CHUNK_SY) return 0xf0;   // open sky above the build limit
    if (wy < 0) return 0;
    const px = wx - ox + PAD;
    const pz = wz - oz + PAD;
    if (px < 0 || px >= PSX || pz < 0 || pz >= PSZ) return 0;
    return light[padIndex(px, wy, pz)];
  };

  let data;
  try {
    data = meshChunk(chunkLike, getBlock, {
      ao, smoothLighting,
      atlas: atlasShim,
      getLight,
      worldOffset: { x: ox, z: oz },
    });
  } catch (err) {
    self.postMessage({ type: 'error', jobId, cx, cz, message: err.message });
    return;
  }

  // Convert the plain arrays the mesher builds into typed arrays and hand
  // ownership to the main thread, so the geometry upload is a zero-copy move.
  const transfers = [];
  const pack = (bucket) => {
    const out = {
      positions: new Float32Array(bucket.positions),
      normals: new Float32Array(bucket.normals),
      colors: new Float32Array(bucket.colors),
      light: new Float32Array(bucket.light),
      ao: new Float32Array(bucket.ao),
      uv: new Float32Array(bucket.uv),
      texIdx: new Float32Array(bucket.texIdx),
      indices: new Uint32Array(bucket.indices),
    };
    for (const key of Object.keys(out)) transfers.push(out[key].buffer);
    return out;
  };

  self.postMessage({
    type: 'meshed',
    jobId, cx, cz,
    opaque: pack(data.opaque),
    water: pack(data.water),
    cross: pack(data.cross),
  }, transfers);
};
