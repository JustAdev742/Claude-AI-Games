/* =========================================================================
   meshPool.js — a pool of meshing workers with a nearest-first job queue.

   Owns the worker lifecycle and the padded-neighbourhood packing that
   mesher.worker.js expects. Falls back to synchronous meshing when workers
   aren't available (older browsers, and Node under the unit tests), so World
   has exactly one code path to call either way.

   The queue is priority-ordered by distance to the player and re-sorted as
   the player moves, because streaming enqueues chunks faster than they can be
   meshed: without it a player flying forward waits on chunks queued behind
   them. Superseded jobs are dropped rather than cancelled — a worker mid-job
   can't be interrupted, but its result can be discarded on arrival.
   ========================================================================= */

import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './constants.js';
import { chunkKey } from '../core/utils.js';

const PAD = 1;
const PSX = CHUNK_SX + PAD * 2;
const PSZ = CHUNK_SZ + PAD * 2;
const PADDED_LEN = PSX * PSZ * CHUNK_SY;

const padIndex = (px, y, pz) => (px * PSZ + pz) * CHUNK_SY + y;

/* Workers are worth having but not worth starving the machine for: meshing
   competes with the render thread for cores, and past ~4 the queue is rarely
   the bottleneck anyway. */
function defaultWorkerCount() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, cores - 1));
}

export class MeshPool {
  constructor(world) {
    this.world = world;
    this.workers = [];
    this.idle = [];
    this.enabled = false;

    // chunkKey -> job. One outstanding job per chunk; re-queuing a chunk that
    // is already queued just updates it.
    this.queue = new Map();
    this.inFlight = new Map();   // jobId -> { key, cx, cz, generation }
    this._jobId = 1;

    // Bumped whenever the world resets or the atlas changes, so results
    // computed against the old state are discarded on arrival.
    this.generation = 0;

    // Scratch padded buffers, reused across jobs. Two are kept in rotation so
    // packing the next job doesn't overwrite one still being transferred.
    this._scratch = [];

    this.stats = { queued: 0, meshed: 0, dropped: 0, fallback: 0 };
  }

  init() {
    if (typeof Worker === 'undefined' || typeof URL === 'undefined') return this;
    try {
      const count = defaultWorkerCount();
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this._onWorkerMessage(w, e.data);
        w.onerror = (err) => {
          console.warn('mesh worker failed, falling back to synchronous meshing', err.message);
          this.shutdown();
        };
        this.workers.push(w);
        this.idle.push(w);
      }
      this.enabled = this.workers.length > 0;
    } catch (err) {
      console.warn('mesh workers unavailable, meshing on the main thread', err);
      this.enabled = false;
    }
    return this;
  }

  /* Tell every worker about the current texture atlas. Only the face->layer
     Int32Array crosses over; the GPU texture itself stays on the main thread. */
  setAtlas(atlas) {
    this.generation++;
    const faceLayer = atlas && atlas._faceLayer ? atlas._faceLayer : null;
    for (const w of this.workers) {
      // Copy per worker: a transferred buffer would be detached for the rest.
      w.postMessage({ type: 'atlas', faceLayer: faceLayer ? faceLayer.slice() : null });
    }
  }

  reset() {
    this.generation++;
    this.queue.clear();
    this.inFlight.clear();
  }

  shutdown() {
    for (const w of this.workers) { try { w.terminate(); } catch (_) { /* already gone */ } }
    this.workers = [];
    this.idle = [];
    this.enabled = false;
  }

  get pending() { return this.queue.size + this.inFlight.size; }

  /* Queue a chunk. Returns false when workers are unavailable, so the caller
     can mesh it synchronously instead. */
  request(chunk, priority) {
    if (!this.enabled) return false;
    const key = chunkKey(chunk.cx, chunk.cz);
    this.queue.set(key, { chunk, cx: chunk.cx, cz: chunk.cz, priority });
    this.stats.queued++;
    this._pump();
    return true;
  }

  /* Called each frame with the player's chunk position so the queue can be
     re-prioritised as they move. */
  update(acx, acz) {
    if (!this.enabled || this.queue.size === 0) return;
    for (const job of this.queue.values()) {
      const dx = job.cx - acx, dz = job.cz - acz;
      job.priority = dx * dx + dz * dz;
    }
    this._pump();
  }

  _pump() {
    while (this.idle.length > 0 && this.queue.size > 0) {
      // Nearest-first. Scanning for the minimum beats keeping the map sorted:
      // the queue is small (tens of entries) and every entry's priority
      // changes whenever the player moves.
      let bestKey = null, best = Infinity;
      for (const [key, job] of this.queue) {
        if (job.priority < best) { best = job.priority; bestKey = key; }
      }
      if (bestKey === null) return;

      const job = this.queue.get(bestKey);
      this.queue.delete(bestKey);

      // The chunk may have been unloaded between queueing and now.
      const live = this.world.chunks.get(bestKey);
      if (!live) { this.stats.dropped++; continue; }

      const worker = this.idle.pop();
      this._dispatch(worker, live, bestKey);
    }
  }

  _dispatch(worker, chunk, key) {
    const jobId = this._jobId++;
    const { blocks, light } = this._packNeighbourhood(chunk);
    const settings = (this.world.game && this.world.game.state && this.world.game.state.settings) || {};

    this.inFlight.set(jobId, { key, cx: chunk.cx, cz: chunk.cz, generation: this.generation, worker });

    worker.postMessage({
      type: 'mesh',
      jobId,
      cx: chunk.cx,
      cz: chunk.cz,
      blocks,
      light,
      ao: true,
      smoothLighting: settings.smoothLighting !== false,
    }, [blocks.buffer, light.buffer]);
  }

  /* Build the chunk plus a one-voxel skin of its neighbours — everything the
     mesher can reach when culling border faces and blending light across the
     seam. */
  _packNeighbourhood(chunk) {
    const blocks = new Uint8Array(PADDED_LEN);
    const light = new Uint8Array(PADDED_LEN);
    const world = this.world;
    const ox = chunk.cx * CHUNK_SX;
    const oz = chunk.cz * CHUNK_SZ;

    // Interior: straight column copies, since localIndex keeps a column
    // contiguous in both layouts.
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        const src = (lx * CHUNK_SZ + lz) * CHUNK_SY;
        const dst = padIndex(lx + PAD, 0, lz + PAD);
        blocks.set(chunk.blocks.subarray(src, src + CHUNK_SY), dst);
        light.set(chunk.light.subarray(src, src + CHUNK_SY), dst);
      }
    }

    // The skin. getBlock generates missing neighbours on demand, which is what
    // guarantees a border face is culled against real terrain rather than air.
    const edge = (px, pz) => {
      const wx = ox + px - PAD;
      const wz = oz + pz - PAD;
      for (let y = 0; y < CHUNK_SY; y++) {
        blocks[padIndex(px, y, pz)] = world.getBlock(wx, y, wz);
        light[padIndex(px, y, pz)] = world.getLightByte(wx, y, wz);
      }
    };
    for (let px = 0; px < PSX; px++) { edge(px, 0); edge(px, PSZ - 1); }
    for (let pz = 1; pz < PSZ - 1; pz++) { edge(0, pz); edge(PSX - 1, pz); }

    return { blocks, light };
  }

  _onWorkerMessage(worker, msg) {
    const job = this.inFlight.get(msg.jobId);
    this.inFlight.delete(msg.jobId);
    this.idle.push(worker);

    if (msg.type === 'error') {
      console.warn(`mesh worker error for chunk ${msg.cx},${msg.cz}: ${msg.message}`);
      this._pump();
      return;
    }
    if (!job) { this._pump(); return; }

    // Discard results computed against a world or atlas that no longer exists.
    if (job.generation !== this.generation) {
      this.stats.dropped++;
      this._pump();
      return;
    }
    const chunk = this.world.chunks.get(job.key);
    if (!chunk) { this.stats.dropped++; this._pump(); return; }

    this.stats.meshed++;
    this.world._uploadChunkGeometry(chunk, msg);
    this._pump();
  }
}

export default MeshPool;
