/* =========================================================================
   meshPool.js — a pool of world workers with a nearest-first job queue.

   The workers do two kinds of job (see workerCore.js): meshing chunks and
   generating terrain. Both go through one queue, ordered by distance to the
   player, so whichever job is nearest runs next regardless of kind — a chunk
   that is needed soon is never stuck behind far-away terrain.

   Owns the worker lifecycle and the padded-neighbourhood packing that
   mesher.worker.js expects. Falls back to synchronous work when workers aren't
   available (older browsers, and Node under the unit tests unless a fake
   worker is injected), so World has exactly one code path to call either way.

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

const WORKER_DEPTH = 2;

export class MeshPool {
  constructor(world) {
    this.world = world;
    this.workers = [];
    this.idle = [];
    this.enabled = false;

    // chunkKey -> job. One outstanding job per chunk; re-queuing a chunk that
    // is already queued just updates it.
    this.queue = new Map();
    // Terrain generation jobs waiting for a worker: chunkKey -> { cx, cz, priority }.
    this.genQueue = new Map();
    this.inFlight = new Map();   // jobId -> { kind, key, cx, cz, generation }
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

    // Generated terrain waiting to be adopted by the world (which applies edits
    // and lighting, a few chunks per frame under a time budget).
    this._generated = [];
    this._acx = 0; this._acz = 0;

    this.stats = { queued: 0, meshed: 0, dropped: 0, fallback: 0, generated: 0, genMs: 0 };
  }

  /* Start the workers. `opts.factory` (a function returning a Worker-like
     object) and `opts.count` exist for tests, which run the worker code
     in-process; in the browser both come from the environment. */
  init(opts = {}) {
    let make = opts.factory;
    if (!make) {
      if (typeof Worker === 'undefined' || typeof URL === 'undefined') return this;
      try { make = workerFactory(); } catch (err) {
        console.warn('mesh workers unavailable, working on the main thread', err);
        return this;
      }
    }
    try {
      const count = opts.count || defaultWorkerCount();
      for (let i = 0; i < count; i++) {
        const w = make();
        w.onmessage = (e) => this._onWorkerMessage(w, e.data);
        w.onerror = (err) => {
          console.warn('world worker failed, falling back to the main thread', err.message);
          this.shutdown();
        };
        this.workers.push(w);
      }
      // Each worker may hold DEPTH jobs at once. A worker's next job then waits
      // in its own message queue instead of for the main thread to notice the
      // last result and send another — on a machine rendering at 10 fps that
      // wait is a whole frame per job. `idle` lists a worker once per free
      // slot, interleaved so the first jobs spread across all of them.
      for (let d = 0; d < WORKER_DEPTH; d++) for (const w of this.workers) this.idle.push(w);
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
    this.genQueue.clear();
    this.inFlight.clear();
    this._uploads.length = 0;
    this._generated.length = 0;
  }

  shutdown() {
    for (const w of this.workers) { try { w.terminate(); } catch (_) { /* already gone */ } }
    this.workers = [];
    this.idle = [];
    this.enabled = false;
    // Jobs the dead workers were holding (and any still waiting) would leave
    // their chunks permanently unmeshed — they were marked clean at dispatch.
    // Hand them back to the world so it rebuilds them on the main thread.
    // Terrain that was still being generated is the world's to redo as well.
    const lost = [];
    let genLost = false;
    for (const j of this.inFlight.values()) {
      if (j.kind === 'gen') genLost = true; else lost.push(j.key);
    }
    for (const k of this.queue.keys()) lost.push(k);
    if (this.genQueue.size > 0) genLost = true;
    this.inFlight.clear();
    this.queue.clear();
    this.genQueue.clear();
    this.generation++;
    for (const key of lost) {
      const c = this.world.chunks.get(key);
      if (c) { c.dirty = true; this.world.remeshQueue.add(key); }
    }
    // Results already received are still good; the world adopts them as usual.
    if (genLost && this.world._onGenLost) this.world._onGenLost();
  }

  get pending() {
    return this.queue.size + this.genQueue.size + this.inFlight.size + this._uploads.length + this._generated.length;
  }

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

  /* Queue terrain generation for a chunk. Returns false when workers are
     unavailable, so the caller generates it on the main thread instead. */
  requestGen(cx, cz, priority) {
    if (!this.enabled) return false;
    this.genQueue.set(chunkKey(cx, cz), { cx, cz, priority });
    this._pump();
    return true;
  }

  /* Take the nearest generation job that has not started, for the caller to do
     itself. Used while the loading screen is up: the main thread has nothing
     else to do then, and on a machine with few cores it nearly doubles the rate
     at which the first ring of terrain appears. */
  stealGen() {
    let bestKey = null, best = Infinity;
    for (const [key, job] of this.genQueue) {
      if (job.priority < best) { best = job.priority; bestKey = key; }
    }
    if (bestKey === null) return null;
    const job = this.genQueue.get(bestKey);
    this.genQueue.delete(bestKey);
    return job;
  }

  /* Forget generation jobs that have not started. Returns their keys so the
     caller can drop its bookkeeping; the player moved and the plan changed, and
     it will ask again for whatever is still wanted. */
  cancelQueuedGen() {
    if (this.genQueue.size === 0) return [];
    const keys = [...this.genQueue.keys()];
    this.genQueue.clear();
    return keys;
  }

  /* Called each frame with the player's chunk position so the queue can be
     re-prioritised as they move. */
  update(acx, acz) {
    this._acx = acx; this._acz = acz;
    if (!this.enabled || (this.queue.size === 0 && this.genQueue.size === 0)) return;
    for (const job of this.queue.values()) {
      const dx = job.cx - acx, dz = job.cz - acz;
      job.priority = dx * dx + dz * dz;
    }
    for (const job of this.genQueue.values()) {
      const dx = job.cx - acx, dz = job.cz - acz;
      job.priority = dx * dx + dz * dz;
    }
    this._pump();
  }

  _pump() {
    while (this.idle.length > 0 && (this.queue.size > 0 || this.genQueue.size > 0)) {
      // Nearest-first across both kinds of job. Scanning for the minimum beats
      // keeping a map sorted: the queues are small (tens to a few hundred
      // entries) and every entry's priority changes whenever the player moves.
      // On a tie terrain goes first, since meshing waits on it.
      let bestKey = null, best = Infinity, genNext = false;
      for (const [key, job] of this.queue) {
        if (job.priority < best) { best = job.priority; bestKey = key; }
      }
      for (const [key, job] of this.genQueue) {
        if (job.priority <= best) { best = job.priority; bestKey = key; genNext = true; }
      }
      if (bestKey === null) return;

      if (genNext) {
        const job = this.genQueue.get(bestKey);
        this.genQueue.delete(bestKey);
        // Already generated in the meantime (the world needed it at once).
        if (this.world.chunks.has(bestKey)) {
          this.stats.dropped++;
          if (this.world._onGenDropped) this.world._onGenDropped(bestKey);
          continue;
        }
        this._dispatchGen(this.idle.pop(), job, bestKey);
        continue;
      }

      const job = this.queue.get(bestKey);
      this.queue.delete(bestKey);

      // The chunk may have been unloaded between queueing and now.
      const live = this.world.chunks.get(bestKey);
      if (!live) { this.stats.dropped++; continue; }

      const worker = this.idle.pop();
      this._dispatch(worker, live, bestKey);
    }
  }

  _dispatchGen(worker, job, key) {
    const jobId = this._jobId++;
    this.inFlight.set(jobId, { kind: 'gen', key, cx: job.cx, cz: job.cz, generation: this.generation, worker });
    worker.postMessage({ type: 'gen', jobId, cx: job.cx, cz: job.cz, seed: this.world.seed });
  }

  _dispatch(worker, chunk, key) {
    const jobId = this._jobId++;
    const { blocks, light } = this._packNeighbourhood(chunk);
    const settings = (this.world.game && this.world.game.state && this.world.game.state.settings) || {};

    this.inFlight.set(jobId, { kind: 'mesh', key, cx: chunk.cx, cz: chunk.cz, generation: this.generation, worker });

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
      console.warn(`world worker error (${msg.kind || 'job'}) for chunk ${msg.cx},${msg.cz}: ${msg.message}`);
      // A chunk whose terrain failed to generate would never exist; let the
      // world make it itself, on the main thread, the next time it plans.
      if (job && job.kind === 'gen' && this.world._onGenDropped) this.world._onGenDropped(job.key, true);
      this._pump();
      return;
    }
    if (!job) { this._pump(); return; }

    if (job.kind === 'gen') {
      if (job.generation !== this.generation) { this.stats.dropped++; this._pump(); return; }
      this.stats.generated++;
      this.stats.genMs += msg.ms || 0;
      this._generated.push({ key: job.key, cx: job.cx, cz: job.cz, msg });
      this._pump();
      return;
    }

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

  /* Hand finished terrain to the world, nearest-first, until the time budget is
     spent. Always adopts at least one so the pipeline cannot stall. */
  drainGenerated(budgetMs) {
    const list = this._generated;
    if (!list.length) return;
    if (list.length > 1) {
      const acx = this._acx, acz = this._acz;
      const d = (g) => (g.cx - acx) * (g.cx - acx) + (g.cz - acz) * (g.cz - acz);
      list.sort((a, b) => d(a) - d(b));
    }
    const t0 = performance.now();
    let n = 0;
    while (n < list.length) {
      const g = list[n++];
      this.world._adoptGenerated(g.msg);
      if (performance.now() - t0 > budgetMs) break;
    }
    list.splice(0, n);
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
