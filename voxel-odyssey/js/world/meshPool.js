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

/* How to start a mesher worker. The single-file build has no worker file to
   point at, so it embeds the (separately bundled) worker source in the page as
   inert text and we run it from a Blob URL; from source, the module file is
   used directly. Blob workers also work when the page is opened from disk
   (file://), where loading a worker by file URL is blocked. */
function workerFactory() {
  const el = typeof document !== 'undefined' ? document.getElementById('mesher-worker-src') : null;
  if (el && el.textContent && typeof Blob !== 'undefined' && URL.createObjectURL) {
    const url = URL.createObjectURL(new Blob([el.textContent], { type: 'text/javascript' }));
    return () => new Worker(url);
  }
  return () => new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
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

    // Finished meshes waiting to be turned into GPU geometry. Results arrive
    // whenever a worker finishes, which can be several in one frame; uploading
    // them all at once is a hitch, so World drains this under a time budget.
    this._uploads = [];

    this.stats = { queued: 0, meshed: 0, dropped: 0, fallback: 0 };
  }

  init() {
    if (typeof Worker === 'undefined' || typeof URL === 'undefined') return this;
    try {
      const count = defaultWorkerCount();
      const make = workerFactory();
      for (let i = 0; i < count; i++) {
        const w = make();
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
    this._uploads.length = 0;
  }

  shutdown() {
    for (const w of this.workers) { try { w.terminate(); } catch (_) { /* already gone */ } }
    this.workers = [];
    this.idle = [];
    this.enabled = false;
    // Jobs the dead workers were holding (and any still waiting) would leave
    // their chunks permanently unmeshed — they were marked clean at dispatch.
    // Hand them back to the world so it rebuilds them on the main thread.
    const lost = [];
    for (const j of this.inFlight.values()) lost.push(j.key);
    for (const k of this.queue.keys()) lost.push(k);
    this.inFlight.clear();
    this.queue.clear();
    for (const key of lost) {
      const c = this.world.chunks.get(key);
      if (c) { c.dirty = true; this.world.remeshQueue.add(key); }
    }
    this.generation++;
  }

  get pending() { return this.queue.size + this.inFlight.size + this._uploads.length; }

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
      climate: chunk.climate,     // copied, not transferred: the chunk keeps it
      ao: true,
      smoothLighting: settings.smoothLighting !== false,
    }, [blocks.buffer, light.buffer]);
  }

  /* Build the chunk plus a one-voxel skin of its neighbours — everything the
     mesher can reach when culling border faces and blending light across the
     seam. All eight neighbours are loaded by the time a chunk is meshed (see
     World._meshReady), so the skin is copied column-by-column straight out of
     their arrays; a missing one reads as empty air instead of being generated. */
  _packNeighbourhood(chunk) {
    const blocks = new Uint8Array(PADDED_LEN);
    const light = new Uint8Array(PADDED_LEN);
    const world = this.world;

    // Copy column (sx, sz) of `src` (a chunk) into padded column (px, pz).
    // localIndex keeps a column contiguous in both layouts, so it is one set().
    const copyColumn = (src, sx, sz, px, pz) => {
      if (!src) return;
      const from = (sx * CHUNK_SZ + sz) * CHUNK_SY;
      const to = padIndex(px, 0, pz);
      blocks.set(src.blocks.subarray(from, from + CHUNK_SY), to);
      light.set(src.light.subarray(from, from + CHUNK_SY), to);
    };

    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const src = ox || oz ? world.getChunk(chunk.cx + ox, chunk.cz + oz) : chunk;
        if (!src) continue;
        // Which source columns land inside the padded box for this neighbour:
        // the whole 16x16 for the chunk itself, one edge row/column for sides,
        // one corner column for diagonals.
        const sx0 = ox === 0 ? 0 : ox < 0 ? CHUNK_SX - 1 : 0;
        const sx1 = ox === 0 ? CHUNK_SX - 1 : sx0;
        const sz0 = oz === 0 ? 0 : oz < 0 ? CHUNK_SZ - 1 : 0;
        const sz1 = oz === 0 ? CHUNK_SZ - 1 : sz0;
        for (let sx = sx0; sx <= sx1; sx++) {
          for (let sz = sz0; sz <= sz1; sz++) {
            // Padded coordinate of this column: neighbours sit one cell outside.
            const px = ox === 0 ? sx + PAD : ox < 0 ? 0 : PSX - 1;
            const pz = oz === 0 ? sz + PAD : oz < 0 ? 0 : PSZ - 1;
            copyColumn(src, sx, sz, px, pz);
          }
        }
      }
    }
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
    this._uploads.push({ key: job.key, generation: job.generation, msg });
    this._pump();
  }

  /* Turn finished meshes into geometry, nearest-first-in, until the time
     budget is spent. Always uploads at least one so the queue cannot stall. */
  drainUploads(budgetMs) {
    const list = this._uploads;
    if (!list.length) return;
    const perf = this.world.game && this.world.game.perf;
    const t0 = performance.now();
    let n = 0;
    while (n < list.length) {
      const u = list[n++];
      if (u.generation === this.generation) {
        const chunk = this.world.chunks.get(u.key);
        if (chunk) this.world._uploadChunkGeometry(chunk, u.msg);
        else this.stats.dropped++;
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    list.splice(0, n);
    if (perf) perf.add('w.upload', performance.now() - t0);
  }
}

export default MeshPool;
