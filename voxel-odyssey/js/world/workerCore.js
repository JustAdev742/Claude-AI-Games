/* =========================================================================
   workerCore.js — the jobs a world worker performs, independent of how it is
   hosted.

   Two kinds of job run off the main thread:

     'mesh'  turn a chunk (plus a one-voxel skin of its neighbours) into packed
             vertex buffers. Meshing walks 20,480 voxels and, for each visible
             face, samples a 3x3 neighbourhood twice (ambient occlusion and
             smooth lighting) — the largest block of per-chunk work;
     'gen'   generate a chunk's terrain from the world seed — the second
             largest, and what made the frame hitch when flying into new land
             on a slow CPU.

   The core takes a `post(message, transferList)` function and returns
   `handle(message)`. mesher.worker.js wires those to self.postMessage /
   self.onmessage; the unit tests wire them to an in-process fake worker, so the
   exact code that runs in the browser's worker is exercised under Node.

   chunk.js and worldgen.js import no Three.js and touch no DOM, which is what
   lets them run here unchanged.

   THE NEIGHBOUR PROBLEM (meshing)
   -------------------------------
   A chunk's border faces need to know what is in the adjacent chunk — to cull
   faces against it, and to blend light across the seam. Shipping the eight
   surrounding chunks per job would be 9x the data. Instead the main thread
   builds a PADDED copy: the chunk plus a one-voxel skin of its neighbours
   (18 x 80 x 18). That is everything the mesher can reach, at ~1.27x the size
   of the chunk itself.

   All large buffers are transferred, not copied, in both directions.
   ========================================================================= */

import { Chunk, meshChunk } from './chunk.js';
import { WorldGen } from './worldgen.js';
import { packBucket, packedBuffers } from './vertexPack.js';
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

export function createWorkerCore(post) {
  let atlasShim = null;
  let gen = null;            // this worker's own terrain generator (built lazily)

  function meshJob(msg) {
    const { jobId, cx, cz, blocks, light, ao, smoothLighting, climate } = msg;
    const ox = cx * CHUNK_SX;
    const oz = cz * CHUNK_SZ;

    // Present the padded arrays to meshChunk through the same interface the
    // main thread uses: a chunk-like object plus getBlock/getLight callbacks
    // for anything outside it.
    const chunkLike = { cx, cz, blocks: null, light: null };

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
        ao, smoothLighting, climate,
        atlas: atlasShim,
        getLight,
        worldOffset: { x: ox, z: oz },
      });
    } catch (err) {
      post({ type: 'error', kind: 'mesh', jobId, cx, cz, message: err.message });
      return;
    }

    // Pack the mesher's plain arrays into the compact 16-byte vertex format and
    // hand the buffers over to the main thread without copying them.
    const opaque = packBucket(data.opaque);
    const water = packBucket(data.water);
    const cross = packBucket(data.cross);
    const transfers = [...packedBuffers(opaque), ...packedBuffers(water), ...packedBuffers(cross)];

    post({ type: 'meshed', jobId, cx, cz, opaque, water, cross }, transfers);
  }

  function genJob(msg) {
    const { jobId, cx, cz } = msg;
    const seed = msg.seed >>> 0;
    try {
      // Re-seeding rebuilds the noise tables, so it only happens when the world
      // actually changed; every job carries its seed so there is no ordering
      // to get wrong between a "new world" message and the jobs that follow it.
      if (!gen) gen = new WorldGen({ seed });
      if (gen.seed !== seed) gen.setSeed(seed);

      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const chunk = new Chunk(cx, cz);
      gen.generateChunk(chunk);
      const ms = typeof performance !== 'undefined' ? performance.now() - t0 : 0;

      const climate = chunk.climate;
      post({
        type: 'generated', jobId, cx, cz, ms,
        blocks: chunk.blocks, climate, empty: chunk.empty,
      }, climate ? [chunk.blocks.buffer, climate.buffer] : [chunk.blocks.buffer]);
    } catch (err) {
      post({ type: 'error', kind: 'gen', jobId, cx, cz, message: err.message });
    }
  }

  return {
    handle(msg) {
      switch (msg.type) {
        case 'atlas':
          // Sent once whenever the resource pack changes.
          atlasShim = makeAtlasShim(msg.faceLayer);
          break;
        case 'mesh': meshJob(msg); break;
        case 'gen': genJob(msg); break;
        default: break;
      }
    },
  };
}
