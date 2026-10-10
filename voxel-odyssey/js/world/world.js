/* =========================================================================
   world.js — chunk storage, streaming, meshing, edits, and raycasting.

   The World owns every loaded Chunk (procedural data) and its matching set of
   THREE.Mesh objects (rendered geometry). It is the single authority that
   other systems (player, entities, particles) talk to when they need to read
   or change a voxel.

   Responsibilities:
     - Stream chunks in/out around an anchor (the player) by render distance.
     - Generate chunk voxel data on demand via game.worldgen (deterministic).
     - Re-apply player edits (block diffs) so saves are tiny (seed + diffs).
     - Mesh chunks off the critical path with a bounded, nearest-first queue.
     - Build/replace/dispose THREE.BufferGeometry without leaking GPU memory.
     - Provide getBlock/setBlock, isSolid/isLiquid, heightAt, spawn helpers,
       and a voxel-DDA raycast for the player's reach.

   Coordinate conventions match the rest of the game: +Y is up, a block at
   integer (x,y,z) occupies the unit cube [x,x+1]×[y,y+1]×[z,z+1]. Chunk
   meshes are parented at the chunk origin (cx*16, 0, cz*16); the mesher emits
   chunk-local positions so we only translate, never bake world offsets in.
   ========================================================================= */

import * as THREE from 'three';
import { Chunk, meshChunk } from './chunk.js';
import {
  CHUNK_SX, CHUNK_SY, CHUNK_SZ, WATER_LEVEL,
  localIndex, worldToChunk,
} from './constants.js';
import Blocks, { ID } from './blocks.js';
import { chunkKey, chunkKeyX, chunkKeyZ, voxelKey, clamp } from '../core/utils.js';
import { LightEngine } from './lighting.js';
import { createSharedUniforms, createVoxelMaterials, updateVoxelUniforms, setShaderTier } from '../render/material.js';
import { MeshPool } from './meshPool.js';

// Chunks that must be meshed before the loading screen lifts. The rest of the
// view distance streams in while you play, nearest first, hidden by fog; making
// a slow machine wait for the whole ring is what made loading take so long.
const PRIME_RADIUS = 3;
// Main-thread time per frame spent generating chunks: small while playing so a
// frame is never lost to terrain, large behind the loading screen.
const STREAM_BUDGET_MS = 4;
const PRIME_BUDGET_MS = 30;
// Chunks are kept this far beyond the generated ring before being unloaded, so
// walking back and forth over a boundary does not thrash.
const UNLOAD_MARGIN = 2;
// Cap on mesh uploads (BufferGeometry creation) per frame, in ms.
const UPLOAD_BUDGET_MS = 3;

// Local-space sphere enclosing a whole chunk column (16 x 80 x 16), for frustum culling.
const CHUNK_SPHERE = new THREE.Sphere(
  new THREE.Vector3(CHUNK_SX / 2, CHUNK_SY / 2, CHUNK_SZ / 2),
  Math.hypot(CHUNK_SX / 2, CHUNK_SY / 2, CHUNK_SZ / 2) + 0.5,
);

// A Set that notices when a NEW key is added, so the sorted view of the remesh
// queue is rebuilt only when it can have changed (not every frame).
class KeyQueue extends Set {
  constructor() { super(); this.stamp = 0; }
  add(k) { if (!super.has(k)) this.stamp++; return super.add(k); }
  clear() { this.stamp++; super.clear(); }
}

export class World {
  constructor(game) {
    this.game = game;

    // cx/cz already convenient via worldToChunk; cache the THREE namespace we
    // were given so we don't import twice in spirit (we still import * here for
    // geometry construction, but honor game.THREE when present).
    this.THREE = (game && game.THREE) || THREE;

    this.seed = 0;

    // Chunk data + their rendered meshes, keyed by chunkKey(cx,cz).
    this.chunks = new Map();   // chunkKey -> Chunk
    this.meshes = new Map();   // chunkKey -> { opaque, water, cross } of THREE.Mesh|null

    // Player edits as a flat diff map so we can persist + re-apply over fresh
    // procedural generation. Key is voxelKey(x,y,z), value is the block id.
    this.edits = new Map();    // voxelKey -> id

    // Remesh work queue: chunkKeys waiting to (re)build geometry. We keep a Set
    // for dedupe and sort by distance to the anchor each frame.
    this.remeshQueue = new KeyQueue();

    // Edits indexed by chunk, so loading a chunk applies only ITS edits instead
    // of scanning (and string-parsing) every edit ever made: chunkKey ->
    // Map(localIndex -> block id). `edits` above stays the flat save format.
    this._editsByChunk = new Map();

    // Streaming plan: the chunks to generate, nearest first, as (dx,dz) offsets
    // from the chunk the player was in when the plan was made.
    this._ringCX = NaN; this._ringCZ = NaN; this._ringRD = 0;
    this._plan = null; this._planIdx = 0;
    this._offsetCache = new Map();           // radius -> Int16Array of (dx,dz) pairs
    // Sorted snapshot of the remesh queue (see _processRemeshQueue).
    this._order = []; this._orderIdx = 0; this._orderStamp = -1; this._orderCX = NaN; this._orderCZ = NaN;

    // Shared materials + the uniform block that drives them, created in init().
    this.matOpaque = null;
    this.matWater = null;
    this.matCross = null;
    this.matViewmodel = null;
    this.uniforms = null;

    // Voxel light propagation. Owns skylight + blocklight for every resident
    // chunk and tells us which chunks need re-meshing after it settles.
    this.lighting = new LightEngine(this);

    // Optional texture atlas; null until a resource pack (or the built-in
    // procedural set) is loaded. The mesher and shader both handle null.
    this.atlas = null;

    // Worker pool for chunk meshing. Meshing is the largest single block of
    // main-thread work during streaming; moving it off-thread is what stops
    // flying into new terrain from stuttering. Falls back to synchronous
    // meshing when Workers aren't available.
    this.meshPool = new MeshPool(this);

    // Streaming bookkeeping.
    this._anchorCX = 0;
    this._anchorCZ = 0;
    this._primed = false;      // becomes true once the spawn ring has meshed
    this._readyEmitted = false;
    this._lastProgress = -1;

    // A reusable scratch group? We parent meshes directly to scene for clarity.
  }

  /* ---- lifecycle -------------------------------------------------------- */

  init() {
    // Custom voxel shader instead of MeshLambertMaterial. A directional light
    // can't be occluded by voxels (it lit the insides of caves), so terrain is
    // lit from the baked per-vertex light the LightEngine produces. See
    // render/material.js for why day/night stays a uniform, not a remesh.
    this.uniforms = createSharedUniforms();
    const mats = createVoxelMaterials(this.uniforms);
    this.matOpaque = mats.opaque;
    this.matWater = mats.water;
    this.matCross = mats.foliage;
    // Shared with the held-item viewmodel so it renders through the same
    // pipeline as the terrain.
    this.matViewmodel = mats.viewmodel;
    this.meshPool.init();
    const tier = this.game && this.game.state && this.game.state.settings ? this.game.state.settings.shaderTier : undefined;
    if (typeof tier === 'number') this.setShaderTier(tier);
    return this;
  }

  // Fragment-shader quality tier (0 cheap .. 2 full) for every terrain material.
  setShaderTier(tier) {
    return setShaderTier({ a: this.matOpaque, b: this.matWater, c: this.matCross, d: this.matViewmodel }, tier);
  }

  /* Bind a texture atlas (procedural default or a loaded resource pack) and
     re-mesh everything so faces pick up their UVs. */
  setAtlas(atlas) {
    this.atlas = atlas || null;
    if (this.uniforms) {
      this.uniforms.uAtlas.value = atlas ? atlas.texture : null;
      this.uniforms.uHasAtlas.value = atlas ? 1 : 0;
    }
    // Workers hold their own copy of the face->layer table.
    this.meshPool.setAtlas(this.atlas);
    // Every chunk's UVs are now stale.
    for (const [key, chunk] of this.chunks) {
      chunk.dirty = true;
      this.remeshQueue.add(key);
    }
  }

  reset(seed) {
    // Tear down every loaded chunk + mesh and clear edits, then set the seed.
    for (const key of [...this.meshes.keys()]) this._disposeMeshSet(key);
    this.meshes.clear();
    this.chunks.clear();
    this.edits.clear();
    this._editsByChunk.clear();
    this.remeshQueue.clear();
    this._ringCX = NaN; this._ringCZ = NaN;
    this._plan = null; this._planIdx = 0;
    this._order = []; this._orderIdx = 0; this._orderStamp = -1;
    // Drop any in-flight light propagation — it references chunks that no
    // longer exist, and stale queue entries would dirty the new world's chunks.
    this.lighting.reset();
    // Bump the pool's generation so results for the old world are discarded
    // rather than uploaded onto chunks that no longer exist.
    this.meshPool.reset();

    this.seed = seed | 0;
    this._primed = false;
    this._readyEmitted = false;
    this._lastProgress = -1;
    this._anchorCX = 0;
    this._anchorCZ = 0;

    // Keep worldgen in sync if available.
    const wg = this.game && this.game.worldgen;
    if (wg && typeof wg.setSeed === 'function') {
      try { wg.setSeed(this.seed); } catch (_) { /* defensive */ }
    }
  }

  /* ---- chunk access ----------------------------------------------------- */

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz)) || null;
  }

  // Create + generate + apply in-range edits for a chunk if it isn't loaded.
  // Generation is deterministic and cheap, so calling this from getBlock to
  // furnish neighbour data for border meshing is safe.
  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (chunk) return chunk;

    const perf = this.game && this.game.perf;
    const g0 = perf ? perf.now() : 0;
    chunk = new Chunk(cx, cz);
    this.chunks.set(key, chunk);

    // Fill voxel data via worldgen (guarded — worldgen may not be ready yet).
    const wg = this.game && this.game.worldgen;
    if (wg && typeof wg.generateChunk === 'function') {
      try { wg.generateChunk(chunk); } catch (err) {
        console.error('worldgen.generateChunk failed', err);
      }
    }
    chunk.generated = true;

    // Overlay any saved/player edits that fall inside this chunk's columns.
    this._applyEditsInChunk(chunk);
    const g1 = perf ? perf.now() : 0;

    // Flood-fill skylight + blocklight for the new voxels, then re-seed from
    // the four neighbours so light flows across the seam in both directions.
    // Without the second step a chunk loaded next to an existing lit one gets
    // a hard dark line down the shared border.
    this.lighting.lightChunk(chunk);
    this.lighting.seedFromNeighbours(chunk);
    if (perf) { perf.add('gen', g1 - g0); perf.add('gen.light', perf.now() - g1); }

    chunk.dirty = true;
    this._onChunkLoaded(chunk);
    return chunk;
  }

  // Re-apply the stored edits that fall inside this chunk. Edits are kept in
  // world coordinates (and indexed per chunk) so they survive regeneration
  // regardless of load order.
  _applyEditsInChunk(chunk) {
    const mine = this._editsByChunk.get(chunkKey(chunk.cx, chunk.cz));
    if (!mine) return;
    for (const [idx, id] of mine) {
      const y = idx % CHUNK_SY;
      const col = (idx - y) / CHUNK_SY;
      const lz = col % CHUNK_SZ;
      const lx = (col - lz) / CHUNK_SZ;
      chunk.setLocal(lx, y, lz, id);
    }
  }

  _indexEdit(cx, cz, lx, y, lz, id) {
    const k = chunkKey(cx, cz);
    let m = this._editsByChunk.get(k);
    if (!m) { m = new Map(); this._editsByChunk.set(k, m); }
    m.set(localIndex(lx, y, lz), id);
  }

  /* ---- voxel read/write ------------------------------------------------- */

  getBlock(wx, wy, wz) {
    wx |= 0; wy |= 0; wz |= 0;
    // Everything above/below the world column is air. Generation handles
    // bedrock at the bottom, so out-of-range reads are simply empty.
    if (wy < 0 || wy >= CHUNK_SY) return ID.AIR;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    // ensureChunk on demand so meshing a border face always sees a neighbour.
    const chunk = this.ensureChunk(cx, cz);
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    return chunk.getLocal(lx, wy, lz);
  }

  /* Packed light byte (sky << 4 | block) at a world voxel. Unlike getBlock
     this does NOT generate missing chunks: meshing calls it for every border
     face, and generating a neighbour mid-mesh would recurse. An absent
     neighbour reads as dark, and the chunk is re-meshed once it loads. */
  getLightByte(wx, wy, wz) {
    if (wy >= CHUNK_SY) return 0xf0;   // open sky above the build limit
    if (wy < 0) return 0;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return 0;
    return chunk.getLightByte(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ);
  }

  // Convenience readers used by entities/UI (e.g. mob spawn checks).
  getSkyLight(wx, wy, wz) { return (this.getLightByte(wx, wy, wz) >> 4) & 0x0f; }
  getBlockLightAt(wx, wy, wz) { return this.getLightByte(wx, wy, wz) & 0x0f; }

  setBlock(wx, wy, wz, id, opts = {}) {
    wx |= 0; wy |= 0; wz |= 0; id |= 0;
    if (wy < 0 || wy >= CHUNK_SY) return false;

    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const chunk = this.ensureChunk(cx, cz);
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;

    const prev = chunk.getLocal(lx, wy, lz);
    if (prev === id) return false; // no-op; nothing changed

    // In multiplayer the server is authoritative over the world. We still
    // apply the change immediately (waiting a round trip makes mining feel
    // broken) but register it as a prediction the server can reject. Edits
    // that arrived FROM the network are marked cause:'network' and must not
    // be echoed back, or two clients ping-pong the same block forever.
    const net = this.game && this.game.net;
    if (net && net.connected && opts.cause !== 'network') {
      const cause = id === ID.AIR ? 1 /* CAUSE.BREAK */ : 0 /* CAUSE.PLACE */;
      net.sendBlockEdit(wx, wy, wz, id, prev, cause);
    }

    // Write the voxel and record the diff so it survives save/regeneration.
    chunk.setLocal(lx, wy, lz, id);
    this.edits.set(voxelKey(wx, wy, wz), id);
    this._indexEdit(cx, cz, lx, wy, lz, id);

    // Propagate the lighting consequences. Breaking a roof lets daylight down
    // the column; placing one casts a shadow; adding/removing a torch floods
    // or clears its radius. The engine queues the work and reports every chunk
    // it touched, which we fold into the remesh queue in update().
    this.lighting.onBlockChanged(wx, wy, wz, prev, id);

    // Mark this chunk dirty + queue a remesh.
    chunk.dirty = true;
    this._queueRemesh(cx, cz);

    // If the edit sits on a chunk border, the neighbour's border faces may
    // change too — dirty + remesh it as well.
    const onWestX = lx === 0, onEastX = lx === CHUNK_SX - 1;
    const onNorthZ = lz === 0, onSouthZ = lz === CHUNK_SZ - 1;
    if (onWestX) this._dirtyNeighbour(cx - 1, cz);
    if (onEastX) this._dirtyNeighbour(cx + 1, cz);
    if (onNorthZ) this._dirtyNeighbour(cx, cz - 1);
    if (onSouthZ) this._dirtyNeighbour(cx, cz + 1);
    // A corner edit also changes the diagonal neighbour's ambient occlusion.
    if ((onWestX || onEastX) && (onNorthZ || onSouthZ)) {
      this._dirtyNeighbour(cx + (onWestX ? -1 : 1), cz + (onNorthZ ? -1 : 1));
    }

    // Notify the rest of the game.
    const events = this.game && this.game.events;
    if (events) {
      events.emit('block:update', { x: wx, y: wy, z: wz });
      if (opts.cause) {
        const by = opts.by || null;
        if (opts.cause === 'break') {
          // The id placed is air; report the block that was removed.
          events.emit('block:break', { x: wx, y: wy, z: wz, blockId: prev, by });
        } else if (opts.cause === 'place') {
          events.emit('block:place', { x: wx, y: wy, z: wz, blockId: id, by });
        }
      }
    }
    return true;
  }

  _dirtyNeighbour(cx, cz) {
    const c = this.getChunk(cx, cz);
    if (c) { c.dirty = true; this._queueRemesh(cx, cz); }
  }

  /* ---- block queries ---------------------------------------------------- */

  isSolid(wx, wy, wz) {
    return Blocks.isSolid(this.getBlock(wx, wy, wz));
  }
  isLiquid(wx, wy, wz) {
    return Blocks.isLiquid(this.getBlock(wx, wy, wz));
  }

  // Topmost solid/leaf y in a column (for spawning + ground checks). Scans down
  // from the world ceiling and returns -1 if the whole column is air/liquid.
  heightAt(wx, wz) {
    // Prefer the deterministic worldgen height when no edits affect the column,
    // but a direct scan is robust to edits and matches what is rendered.
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      const id = this.getBlock(wx, y, wz);
      if (id === ID.AIR) continue;
      if (Blocks.isLiquid(id)) continue;
      const rt = Blocks.renderType(id);
      if (rt === 'cross') continue;       // flowers/grass aren't standable ground
      if (Blocks.isSolid(id) || id === ID.LEAVES || id === ID.BIRCH_LEAVES || id === ID.PINE_LEAVES) {
        return y;
      }
    }
    return -1;
  }

  // A safe standing position above the ground at (wx,wz): feet one block above
  // the highest solid surface, with water surfaces handled gracefully.
  getGroundSpawn(wx, wz) {
    wx = Math.floor(wx);
    wz = Math.floor(wz);

    // Spawn somewhere worth starting: not just the nearest dry column (which
    // is often a one-block sandbar or the lip of a cliff) but the nearest spot
    // with a decent stretch of walkable land around it. Everything here reads
    // the DETERMINISTIC worldgen height, so it costs no chunk generation.
    const wg = this.game && this.game.worldgen;
    if (wg && typeof wg.findSpawnSpot === 'function') {
      const spot = wg.findSpawnSpot(wx, wz);
      if (spot) { wx = spot.x; wz = spot.z; }
      // No usable land within the search radius: an ocean seed. Fall through
      // and spawn wherever the request pointed (it will swim).
    }

    let h = this.heightAt(wx, wz);
    if (h < 0) h = WATER_LEVEL;          // open water/void → spawn at sea level
    // Stand on top of the surface block; ensure the two cells above are clear.
    let y = h + 1;
    // Nudge up out of any solids (e.g. if the surface block itself is tall).
    for (let guard = 0; guard < 8; guard++) {
      const feet = this.getBlock(wx, y, wz);
      const head = this.getBlock(wx, y + 1, wz);
      if (!Blocks.isSolid(feet) && !Blocks.isSolid(head)) break;
      y++;
    }
    return { x: wx + 0.5, y, z: wz + 0.5 };
  }

  /* ---- raycasting (voxel DDA) ------------------------------------------- */

  // March a ray through the voxel grid (Amanatides & Woo). Returns the first
  // targetable block (solid OR cross-type), the face normal stepped through,
  // the empty cell adjacent across that normal (for placement), and the id.
  raycast(origin, dir, maxDist = 6, opts = {}) {
    if (!origin || !dir) return null;
    const skip = opts.skip || null;

    // Normalize the direction; bail on a zero-length ray.
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return null;
    dx /= len; dy /= len; dz /= len;

    // Current voxel containing the ray origin.
    let ix = Math.floor(origin.x);
    let iy = Math.floor(origin.y);
    let iz = Math.floor(origin.z);

    // Step direction per axis.
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    // Distance (in t) to cross one full voxel along each axis.
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

    // Distance (in t) to the first voxel boundary on each axis.
    const fracX = origin.x - ix;
    const fracY = origin.y - iy;
    const fracZ = origin.z - iz;
    let tMaxX = dx > 0 ? (1 - fracX) * tDeltaX : dx < 0 ? fracX * tDeltaX : Infinity;
    let tMaxY = dy > 0 ? (1 - fracY) * tDeltaY : dy < 0 ? fracY * tDeltaY : Infinity;
    let tMaxZ = dz > 0 ? (1 - fracZ) * tDeltaZ : dz < 0 ? fracZ * tDeltaZ : Infinity;

    // Track which axis we last stepped along so we know the face normal.
    let nx = 0, ny = 0, nz = 0;
    let t = 0;

    // Cap iterations defensively in addition to the distance test.
    const maxSteps = Math.ceil(maxDist * 3) + 8;
    for (let i = 0; i < maxSteps; i++) {
      const id = this.getBlock(ix, iy, iz);
      let targetable = (Blocks.isSolid(id) || Blocks.renderType(id) === 'cross') && id !== ID.AIR;
      // Caller veto — the player uses this to look THROUGH the grass tuft its
      // own body is standing in, which otherwise absorbs every downward ray
      // and makes "place a block on the ground at my feet" impossible.
      if (targetable && skip && skip(ix, iy, iz, id)) targetable = false;
      if (targetable) {
        // Plants and liquids are REPLACEABLE: you build into them, not against
        // them. Returning block+normal for a tuft of grass aimed the placement
        // cell back toward the player, where it collided with the player's own
        // body and was rejected — which is why building on a grassy field
        // appeared to do nothing at all.
        const def = Blocks.get(id);
        const replaceable = def && (def.render === 'cross' || def.liquid);
        const place = replaceable
          ? { x: ix, y: iy, z: iz }
          : { x: ix + nx, y: iy + ny, z: iz + nz };
        return {
          block: { x: ix, y: iy, z: iz },
          normal: { x: nx, y: ny, z: nz },
          place,
          replaceable: !!replaceable,
          blockId: id,
        };
      }

      // Advance to the next voxel boundary along the nearest axis.
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        ix += stepX; t = tMaxX; tMaxX += tDeltaX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY <= tMaxZ) {
        iy += stepY; t = tMaxY; tMaxY += tDeltaY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) break;
    }
    return null;
  }

  /* ---- streaming + meshing --------------------------------------------- */

  update(dt, anchor) {
    // Defensive: never throw in the hot path.
    if (!anchor) return;
    const settings = (this.game && this.game.state && this.game.state.settings) || {};
    // The player's view distance, or lower while the adaptive governor is
    // shedding load (state.renderDistance accounts for both).
    const rdSetting = this.game && this.game.state ? this.game.state.renderDistance : settings.renderDistance;
    const rd = clamp((rdSetting | 0) || 6, 2, 12);

    const acx = Math.floor(anchor.x / CHUNK_SX);
    const acz = Math.floor(anchor.z / CHUNK_SZ);
    this._anchorCX = acx;
    this._anchorCZ = acz;

    // Push the current sun state into the shared terrain uniforms. One float
    // and one colour re-light every chunk in the world; no geometry touched.
    const sky = this.game && this.game.sky;
    if (sky && this.uniforms && typeof sky.getTerrainLight === 'function') {
      updateVoxelUniforms(this.uniforms, sky.getTerrainLight());
    }

    const perf = this.game && this.game.perf;
    const w0 = perf ? perf.now() : 0;

    // 1) Streaming. The plan (which chunks to load, nearest first) is rebuilt
    //    only when the player crosses a chunk border or the view distance
    //    changes — not scanned every frame — and executed under a time budget,
    //    so walking into new terrain costs a few ms per frame instead of one
    //    long hitch when a whole row of chunks generates at once.
    if (acx !== this._ringCX || acz !== this._ringCZ || rd !== this._ringRD) this._replan(acx, acz, rd);
    const budget = this._primed ? (settings.streamBudgetMs || STREAM_BUDGET_MS) : PRIME_BUDGET_MS;
    const plan = this._plan;
    if (plan && this._planIdx < plan.length) {
      const t0 = performance.now();
      while (this._planIdx < plan.length) {
        const cx = this._ringCX + plan[this._planIdx], cz = this._ringCZ + plan[this._planIdx + 1];
        this._planIdx += 2;
        if (!this.chunks.has(chunkKey(cx, cz))) {
          this.ensureChunk(cx, cz);
          if (performance.now() - t0 > budget) break;   // always makes at least one chunk of progress
        }
      }
    }
    const w1 = perf ? perf.now() : 0;

    // 2) Drain pending light propagation, then fold every chunk it touched
    //    into the remesh queue. Bounded per frame so a big cave breakthrough
    //    (which can cascade daylight across several chunks) spreads its cost
    //    over a few frames instead of dropping one.
    if (this.lighting.pending > 0) this.lighting.update(settings.lightBudget || 24000);
    const litDirty = this.lighting.takeDirtyChunks();
    if (litDirty) {
      for (const key of litDirty) {
        const c = this.chunks.get(key);
        if (c) { c.dirty = true; this.remeshQueue.add(key); }
      }
    }
    const w2 = perf ? perf.now() : 0;

    // 3) Process a bounded slice of the remesh queue, nearest-first, and
    //    upload finished worker meshes under their own time budget.
    this._processRemeshQueue(acx, acz, 3);
    this.meshPool.update(acx, acz);
    this.meshPool.drainUploads(UPLOAD_BUDGET_MS);
    if (perf) {
      perf.add('w.stream', w1 - w0);     // plan + chunk generation
      perf.add('w.light', w2 - w1);
      perf.add('w.mesh', perf.now() - w2);   // dispatch (workers) or build (main thread) + uploads
    }

    // 4) Loading progress + world:ready, only while priming the first ring.
    if (!this._primed) this._updatePriming(acx, acz, rd);
  }

  // Cached (dx,dz) offsets within `radius` chunks (a round disc), nearest first.
  // With `dilate`, also every chunk adjacent (including diagonally) to the disc:
  // the data a drawn chunk needs next to it in order to be meshed.
  _offsets(radius, dilate = false) {
    const cacheKey = radius * 2 + (dilate ? 1 : 0);
    let o = this._offsetCache.get(cacheKey);
    if (o) return o;
    const lim = (radius + 0.5) * (radius + 0.5);
    const cells = new Map();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > lim) continue;
        const reach = dilate ? 1 : 0;
        for (let oz = -reach; oz <= reach; oz++) {
          for (let ox = -reach; ox <= reach; ox++) cells.set(chunkKey(dx + ox, dz + oz), [dx + ox, dz + oz]);
        }
      }
    }
    const list = [...cells.values()].map(([x, z]) => [x * x + z * z, x, z]);
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    o = new Int16Array(list.length * 2);
    list.forEach((e, i) => { o[i * 2] = e[1]; o[i * 2 + 1] = e[2]; });
    this._offsetCache.set(cacheKey, o);
    return o;
  }

  // The player moved to a new chunk (or the view distance changed): decide
  // what to load, unload what fell out of range, and queue meshing for loaded
  // chunks that just came into view.
  _replan(acx, acz, rd) {
    this._ringCX = acx; this._ringCZ = acz; this._ringRD = rd;
    // Chunk DATA is generated one chunk beyond what is drawn: a chunk is meshed
    // only once all eight neighbours exist, so the outermost drawn chunks have
    // real terrain next to them instead of triggering on-demand generation.
    this._plan = this._offsets(rd, true);
    this._planIdx = 0;

    const lim = (rd + 1 + UNLOAD_MARGIN + 0.5) * (rd + 1 + UNLOAD_MARGIN + 0.5);
    let doomed = null;
    for (const [key, c] of this.chunks) {
      const dx = c.cx - acx, dz = c.cz - acz;
      if (dx * dx + dz * dz > lim) (doomed || (doomed = [])).push(key);
    }
    if (doomed) for (const key of doomed) this._unloadChunk(key);

    const ring = this._offsets(rd);
    for (let i = 0; i < ring.length; i += 2) {
      const c = this.chunks.get(chunkKey(acx + ring[i], acz + ring[i + 1]));
      if (c) this._queueIfReady(c);
    }
  }

  // Is this chunk inside the drawn ring and fully surrounded by loaded chunks?
  _meshReady(chunk) {
    const dx = chunk.cx - this._ringCX, dz = chunk.cz - this._ringCZ;
    const r = this._ringRD + 0.5;
    if (!(dx * dx + dz * dz <= r * r)) return false;       // also false while _ringCX is NaN
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        if ((ox || oz) && !this.chunks.has(chunkKey(chunk.cx + ox, chunk.cz + oz))) return false;
      }
    }
    return true;
  }

  _queueIfReady(chunk) {
    const key = chunkKey(chunk.cx, chunk.cz);
    if (!chunk.dirty && this.meshes.has(key)) return;
    if (this._meshReady(chunk)) this.remeshQueue.add(key);
  }

  // A chunk just appeared: it, and any neighbour that was waiting for it, may
  // now be ready to mesh.
  _onChunkLoaded(chunk) {
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const c = ox || oz ? this.chunks.get(chunkKey(chunk.cx + ox, chunk.cz + oz)) : chunk;
        if (c) this._queueIfReady(c);
      }
    }
  }

  _updatePriming(acx, acz, rd) {
    const events = this.game && this.game.events;
    const ring = this._offsets(Math.min(rd, PRIME_RADIUS));
    let needed = 0, ready = 0;
    for (let i = 0; i < ring.length; i += 2) {
      needed++;
      const key = chunkKey(acx + ring[i], acz + ring[i + 1]);
      const c = this.chunks.get(key);
      if (c && this.meshes.has(key) && !c.dirty) ready++;
    }
    const value = needed > 0 ? clamp(ready / needed, 0, 1) : 1;
    if (events && value !== this._lastProgress) {
      this._lastProgress = value;
      events.emit('loading:progress', {
        value,
        text: value >= 1 ? 'World ready' : `Generating terrain… ${Math.round(value * 100)}%`,
      });
    }
    // Primed once the spawn ring is fully meshed, so the player does not drop
    // into holes.
    if (needed > 0 && ready >= needed) {
      this._primed = true;
      if (events && !this._readyEmitted) {
        this._readyEmitted = true;
        events.emit('loading:progress', { value: 1, text: 'World ready' });
        events.emit('world:ready', {});
      }
    }
  }

  _queueRemesh(cx, cz) {
    this.remeshQueue.add(chunkKey(cx, cz));
  }

  // Hand the nearest queued chunks to the mesher: to the worker pool when there
  // is one, otherwise build them here under a time budget.
  _processRemeshQueue(acx, acz, budget) {
    const q = this.remeshQueue;
    if (q.size === 0) return;

    // The distance-sorted view is rebuilt only when a new chunk was queued or
    // the player changed chunk, not every frame.
    if (this._orderStamp !== q.stamp || this._orderCX !== acx || this._orderCZ !== acz) {
      const order = Array.from(q);
      const dist = (k) => { const dx = chunkKeyX(k) - acx, dz = chunkKeyZ(k) - acz; return dx * dx + dz * dz; };
      order.sort((a, b) => dist(a) - dist(b));
      this._order = order; this._orderIdx = 0;
      this._orderStamp = q.stamp; this._orderCX = acx; this._orderCZ = acz;
    }

    // With workers the per-frame count is larger: dispatching a job is just
    // packing a buffer. Without them every build blocks the frame, so it is
    // limited by time as well.
    const usingWorkers = this.meshPool.enabled;
    const limit = usingWorkers ? budget * 8 : budget;
    const t0 = performance.now();

    const order = this._order;
    let i = this._orderIdx, built = 0;
    while (i < order.length && built < limit) {
      const key = order[i];
      if (!q.has(key)) { i++; continue; }
      const chunk = this.chunks.get(key);
      // A chunk that fell out of range (or lost a neighbour) is not meshed;
      // it is queued again by _onChunkLoaded / _replan when it is ready.
      if (!chunk || !this._meshReady(chunk)) { q.delete(key); i++; continue; }

      if (usingWorkers) {
        // Don't pile more onto a saturated pool — leaving the chunk queued
        // keeps it eligible for re-prioritisation as the player moves.
        if (this.meshPool.inFlight.size >= this.meshPool.workers.length * 2) break;
        const dx = chunk.cx - acx, dz = chunk.cz - acz;
        this.meshPool.request(chunk, dx * dx + dz * dz);
      } else {
        // _uploadChunkGeometry emits 'chunk:meshed' for both paths.
        if (built > 0 && performance.now() - t0 > 6) break;
        this._buildChunkMesh(chunk);
      }

      q.delete(key);
      // Cleared at dispatch either way. On the worker path the geometry
      // arrives a few frames later; leaving the flag set would have the
      // streaming loop re-queue the same chunk every frame in the meantime.
      chunk.dirty = false;
      built++;
      i++;
    }
    this._orderIdx = i;
  }

  // (Re)build the three buckets of geometry for one chunk and swap the meshes,
  // disposing any previous geometry to avoid GPU leaks.
  _buildChunkMesh(chunk) {
    const T = this.THREE;
    const scene = this.game && this.game.scene;
    const key = chunkKey(chunk.cx, chunk.cz);

    // Sample neighbours through getBlock so border faces cull correctly, and
    // through getLightByte so smooth lighting blends across the chunk seam
    // instead of stopping dead at the boundary.
    const getBlock = (wx, wy, wz) => this.getBlock(wx, wy, wz);
    const getLight = (wx, wy, wz) => this.getLightByte(wx, wy, wz);
    const settings = (this.game && this.game.state && this.game.state.settings) || {};
    let data;
    try {
      data = meshChunk(chunk, getBlock, {
        ao: true,
        smoothLighting: settings.smoothLighting !== false,
        atlas: this.atlas,
        getLight,
        worldOffset: { x: chunk.cx * CHUNK_SX, z: chunk.cz * CHUNK_SZ },
      });
    } catch (err) {
      console.error('meshChunk failed', err);
      return;
    }
    if (!data) return;
    this._uploadChunkGeometry(chunk, data);
  }

  /* Turn meshed buckets into GPU geometry. Split out from _buildChunkMesh so
     the worker path — which produces the same bucket shape, already as typed
     arrays — reuses it verbatim. */
  _uploadChunkGeometry(chunk, data) {
    const scene = this.game && this.game.scene;
    const key = chunkKey(chunk.cx, chunk.cz);

    const existing = this.meshes.get(key) || { opaque: null, water: null, cross: null };
    const next = { opaque: null, water: null, cross: null };

    next.opaque = this._swapBucket(existing.opaque, data.opaque, this.matOpaque, chunk, scene, 'opaque');
    next.water = this._swapBucket(existing.water, data.water, this.matWater, chunk, scene, 'water');
    next.cross = this._swapBucket(existing.cross, data.cross, this.matCross, chunk, scene, 'cross');

    this.meshes.set(key, next);

    const events = this.game && this.game.events;
    if (events) events.emit('chunk:meshed', { cx: chunk.cx, cz: chunk.cz });
  }

  // Build/replace a single bucket mesh from plain mesher arrays. Returns the
  // new mesh (or null if the bucket is empty). Disposes the old geometry.
  _swapBucket(oldMesh, bucket, material, chunk, scene, name) {
    const T = this.THREE;
    const hasData = bucket && bucket.positions && bucket.positions.length > 0
      && bucket.indices && bucket.indices.length > 0;

    if (!hasData) {
      // Nothing to draw — tear down any previous mesh for this bucket.
      if (oldMesh) {
        if (scene) scene.remove(oldMesh);
        if (oldMesh.geometry) oldMesh.geometry.dispose();
      }
      return null;
    }

    // Worker results already arrive as typed arrays (transferred, not copied);
    // main-thread meshing produces plain arrays. Wrapping only when needed
    // avoids a redundant copy of every chunk's vertex data on the worker path.
    const f32 = (a) => (a instanceof Float32Array ? a : new Float32Array(a));
    const u32 = (a) => (a instanceof Uint32Array ? a : new Uint32Array(a));

    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.BufferAttribute(f32(bucket.positions), 3));
    geom.setAttribute('normal', new T.BufferAttribute(f32(bucket.normals), 3));
    // Custom attribute names (aColor/aLight/aAO/aTexIdx) rather than Three's
    // built-in `color`: the voxel shader declares them itself, and reusing the
    // built-in name would collide with the vertexColors machinery.
    geom.setAttribute('aColor', new T.BufferAttribute(f32(bucket.colors), 3));
    geom.setAttribute('aLight', new T.BufferAttribute(f32(bucket.light), 2));
    geom.setAttribute('aAO', new T.BufferAttribute(f32(bucket.ao), 1));
    geom.setAttribute('uv', new T.BufferAttribute(f32(bucket.uv), 2));
    geom.setAttribute('aTexIdx', new T.BufferAttribute(f32(bucket.texIdx), 1));
    geom.setIndex(new T.BufferAttribute(u32(bucket.indices), 1));
    // Every chunk spans the same local box, so share one bounding sphere instead
    // of scanning the vertices to compute a tight one on the main thread.
    geom.boundingSphere = CHUNK_SPHERE.clone();

    if (oldMesh) {
      // Reuse the existing mesh object: dispose old geometry, attach new.
      if (oldMesh.geometry) oldMesh.geometry.dispose();
      oldMesh.geometry = geom;
      // Ensure it's still parented (it should be) at the chunk origin.
      oldMesh.position.set(chunk.cx * CHUNK_SX, 0, chunk.cz * CHUNK_SZ);
      if (scene && !oldMesh.parent) scene.add(oldMesh);
      return oldMesh;
    }

    const mesh = new T.Mesh(geom, material);
    mesh.name = `chunk_${name}_${chunk.cx}_${chunk.cz}`;
    mesh.position.set(chunk.cx * CHUNK_SX, 0, chunk.cz * CHUNK_SZ);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Transparent/cross buckets shouldn't write huge frustum issues; defaults ok.
    if (name === 'water') mesh.renderOrder = 1;
    if (scene) scene.add(mesh);
    return mesh;
  }

  // Remove a chunk's data + meshes entirely and drop queued remeshes for it.
  _unloadChunk(key) {
    this._disposeMeshSet(key);
    this.meshes.delete(key);
    this.chunks.delete(key);
    this.remeshQueue.delete(key);
  }

  // Dispose every mesh/geometry in a chunk's bucket set and remove from scene.
  _disposeMeshSet(key) {
    const set = this.meshes.get(key);
    if (!set) return;
    const scene = this.game && this.game.scene;
    for (const name of ['opaque', 'water', 'cross']) {
      const mesh = set[name];
      if (!mesh) continue;
      if (scene) scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      // Materials are shared across chunks — never dispose them here.
    }
  }

  /* ---- persistence ------------------------------------------------------ */

  serialize() {
    const edits = [];
    for (const [k, id] of this.edits) {
      const c = k.indexOf(',');
      const c2 = k.indexOf(',', c + 1);
      const x = +k.slice(0, c);
      const y = +k.slice(c + 1, c2);
      const z = +k.slice(c2 + 1);
      edits.push([x, y, z, id]);
    }
    return { seed: this.seed, edits };
  }

  // Re-apply saved diffs. Call before chunks are meshed; any already-loaded
  // chunk is updated + queued for remesh, and the edit is stored so chunks
  // generated later also receive it.
  applyEdits(edits) {
    if (!Array.isArray(edits)) return;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (!e) continue;
      const x = e[0] | 0, y = e[1] | 0, z = e[2] | 0, id = e[3] | 0;
      if (y < 0 || y >= CHUNK_SY) continue;
      this.edits.set(voxelKey(x, y, z), id);
      this._indexEdit(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ), x - Math.floor(x / CHUNK_SX) * CHUNK_SX, y, z - Math.floor(z / CHUNK_SZ) * CHUNK_SZ, id);

      // If the target chunk is already loaded, write through + queue a remesh.
      const cx = Math.floor(x / CHUNK_SX);
      const cz = Math.floor(z / CHUNK_SZ);
      const chunk = this.getChunk(cx, cz);
      if (chunk) {
        chunk.setLocal(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ, id);
        chunk.dirty = true;
        this._queueRemesh(cx, cz);
      }
    }
  }

  /* ---- helpers ---------------------------------------------------------- */
}

export default World;
