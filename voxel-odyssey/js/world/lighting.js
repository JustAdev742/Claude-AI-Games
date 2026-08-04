/* =========================================================================
   lighting.js — voxel light propagation (skylight + blocklight).

   WHY THIS EXISTS
   ---------------
   Rendering a voxel world with a real directional light is wrong: a
   THREE.DirectionalLight illuminates every surface whose normal faces it,
   regardless of whether a mountain is in the way. Sealed rooms and deep caves
   come out as bright as open ground, and torches emit nothing at all. Shadow
   maps don't fix it either — they can't express "this cave is dark" or "this
   torch pools light onto the floor" at voxel granularity, and they cost a
   full extra scene pass per frame.

   Instead we do what Minecraft does: propagate light through the voxel grid
   itself and bake the result into the mesh. Two independent channels:

     skylight  — seeded at 15 from the top of every column, travels straight
                 DOWN without attenuation while blocks are transparent, and
                 spreads sideways losing 1 per step. This is what makes caves
                 dark and overhangs cast soft shade. Scaled by time of day at
                 render time, so dusk dims the world without a remesh.

     blocklight — seeded by emissive blocks (torch 13, glowstone 14, lantern
                 15) and spread with 1 lost per step in all 6 directions.
                 Independent of time of day: a torch is as bright at noon as
                 at midnight.

   STORAGE
   -------
   One byte per voxel, packed into the chunk's existing `light` array:
       bits 7..4  skylight   (0..15)
       bits 3..0  blocklight (0..15)

   INCREMENTAL UPDATES
   -------------------
   Re-flooding the world on every block change would be far too slow, so
   placing/breaking uses the standard two-phase algorithm: a removal BFS that
   clears the region a light used to reach and collects the surviving border,
   then an addition BFS that re-floods from that border. Both are bounded by
   the light radius (<= 15 blocks), not by world size.

   The engine works in WORLD coordinates and crosses chunk borders, so a torch
   at a chunk edge lights its neighbour correctly. Every voxel it touches marks
   that voxel's chunk dirty, and World re-meshes them.
   ========================================================================= */

import Blocks, { ID } from './blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, localIndex } from './constants.js';
import { chunkKey } from '../core/utils.js';

export const MAX_LIGHT = 15;

/* -------------------------------------------------------------------------
   A growable Int32 queue with a fixed stride, used for the BFS frontiers.
   Plain arrays of {x,y,z} objects would allocate millions of short-lived
   objects during a world load; this keeps propagation allocation-free after
   the initial growth.
   ------------------------------------------------------------------------- */
class IntQueue {
  constructor(stride, initialCapacity = 4096) {
    this.stride = stride;
    this.data = new Int32Array(stride * initialCapacity);
    this.head = 0;   // read cursor, in elements
    this.tail = 0;   // write cursor, in elements
  }

  get length() { return (this.tail - this.head) / this.stride; }
  get isEmpty() { return this.head >= this.tail; }

  push(...vals) {
    if (this.tail + this.stride > this.data.length) this._grow();
    for (let i = 0; i < this.stride; i++) this.data[this.tail + i] = vals[i];
    this.tail += this.stride;
  }

  // Reads the next record into the caller-supplied array to avoid allocating.
  shift(out) {
    for (let i = 0; i < this.stride; i++) out[i] = this.data[this.head + i];
    this.head += this.stride;
    return out;
  }

  clear() { this.head = 0; this.tail = 0; }

  _grow() {
    // Compact first: a long-running queue drains from the head, so we can
    // often reuse the buffer instead of doubling it.
    if (this.head > 0) {
      this.data.copyWithin(0, this.head, this.tail);
      this.tail -= this.head;
      this.head = 0;
      if (this.tail + this.stride <= this.data.length) return;
    }
    const bigger = new Int32Array(this.data.length * 2);
    bigger.set(this.data);
    this.data = bigger;
  }
}

/* The 6 axis-aligned neighbour offsets, ordered so index 1 is straight down.
   Skylight treats that direction specially (no attenuation at full strength). */
const NEIGHBOURS = [
  [0, 1, 0],   // up
  [0, -1, 0],  // down  <- index 1
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const DOWN = 1;

export class LightEngine {
  /**
   * @param {object} world  Host world, must provide getChunk(cx,cz) returning
   *                        a Chunk with .blocks and .light, or null when the
   *                        chunk isn't resident.
   */
  constructor(world) {
    this.world = world;

    // BFS frontiers. Addition queues carry (x,y,z); removal queues also carry
    // the level the voxel used to have, which bounds how far the clear spreads.
    this._skyAdd = new IntQueue(3);
    this._skyRemove = new IntQueue(4);
    this._blockAdd = new IntQueue(3);
    this._blockRemove = new IntQueue(4);

    // Chunk keys touched since the last drain, so World knows what to re-mesh.
    this.dirtyChunks = new Set();

    // Scratch record buffers, reused by shift() to stay allocation-free.
    this._r3 = [0, 0, 0];
    this._r4 = [0, 0, 0, 0];

    // Chunk lookup memo, valid only for the duration of one propagation run.
    // Light BFS hammers the same handful of chunks, and getChunk() does a map
    // lookup plus a key string build on every call.
    this._memoKey = null;
    this._memoChunk = null;
    this._memoCx = 0x7fffffff;
    this._memoCz = 0x7fffffff;

    // Last chunk marked dirty by an interior write (see _markDirty).
    this._lastDirtyCx = 0x7fffffff;
    this._lastDirtyCz = 0x7fffffff;

    this.stats = { skyNodes: 0, blockNodes: 0, relitChunks: 0 };
  }

  /* ---------------------------------------------------------------------
     Chunk / voxel access. All coordinates are world-space.
     --------------------------------------------------------------------- */

  _chunkAt(cx, cz) {
    if (cx === this._memoCx && cz === this._memoCz) return this._memoChunk;
    const c = this.world.getChunk(cx, cz);
    this._memoCx = cx; this._memoCz = cz; this._memoChunk = c;
    return c;
  }

  _invalidateMemo() { this._memoCx = 0x7fffffff; this._memoCz = 0x7fffffff; this._memoChunk = null; }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SY) return ID.AIR;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this._chunkAt(cx, cz);
    if (!c) return null;                     // not resident — caller must skip
    return c.blocks[localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)];
  }

  getSky(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy >= CHUNK_SY) return MAX_LIGHT;    // above the build limit: open sky
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this._chunkAt(cx, cz);
    if (!c) return 0;
    return (c.light[localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)] >> 4) & 0x0f;
  }

  getBlockLight(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SY) return 0;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this._chunkAt(cx, cz);
    if (!c) return 0;
    return c.light[localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ)] & 0x0f;
  }

  setSky(wx, wy, wz, level) {
    if (wy < 0 || wy >= CHUNK_SY) return false;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this._chunkAt(cx, cz);
    if (!c) return false;
    const i = localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ);
    c.light[i] = (c.light[i] & 0x0f) | ((level & 0x0f) << 4);
    this._markDirty(cx, cz, wx - cx * CHUNK_SX, wz - cz * CHUNK_SZ);
    return true;
  }

  setBlockLight(wx, wy, wz, level) {
    if (wy < 0 || wy >= CHUNK_SY) return false;
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this._chunkAt(cx, cz);
    if (!c) return false;
    const i = localIndex(wx - cx * CHUNK_SX, wy, wz - cz * CHUNK_SZ);
    c.light[i] = (c.light[i] & 0xf0) | (level & 0x0f);
    this._markDirty(cx, cz, wx - cx * CHUNK_SX, wz - cz * CHUNK_SZ);
    return true;
  }

  // Marks the owning chunk dirty — plus any neighbour whose mesh samples this
  // voxel. A face on a chunk border reads light from the voxel across the
  // seam, so changing an edge voxel must re-mesh the neighbour too or a bright
  // seam line appears along the chunk boundary.
  //
  // A flood fill writes light millions of times during world load, and nearly
  // all consecutive writes land in the same chunk. Remembering the last
  // interior chunk marked skips rebuilding the same key string over and over,
  // which dominated load time before this cache existed.
  _markDirty(cx, cz, lx, lz) {
    const onBorder = lx === 0 || lx === CHUNK_SX - 1 || lz === 0 || lz === CHUNK_SZ - 1;
    if (!onBorder && cx === this._lastDirtyCx && cz === this._lastDirtyCz) return;

    this.dirtyChunks.add(chunkKey(cx, cz));
    if (!onBorder) { this._lastDirtyCx = cx; this._lastDirtyCz = cz; return; }

    if (lx === 0) this.dirtyChunks.add(chunkKey(cx - 1, cz));
    else if (lx === CHUNK_SX - 1) this.dirtyChunks.add(chunkKey(cx + 1, cz));
    if (lz === 0) this.dirtyChunks.add(chunkKey(cx, cz - 1));
    else if (lz === CHUNK_SZ - 1) this.dirtyChunks.add(chunkKey(cx, cz + 1));
  }

  /* How much light a block absorbs when light passes through it. Air and
     cross-shaped plants are free; glass and water dim slightly; solid blocks
     stop light entirely. */
  _opacity(id) {
    if (id === ID.AIR) return 0;
    const d = Blocks.get(id);
    if (!d) return MAX_LIGHT;
    if (d.render === 'cross' || d.render === 'air') return 0;
    // A transparent block's declared opacity is its true attenuation; an
    // opaque cube always blocks fully regardless of what it declares.
    if (d.transparent || d.liquid) return Math.max(0, Math.min(MAX_LIGHT, d.opacity));
    return MAX_LIGHT;
  }

  /* --------------------------------------------------------------------
     Initial lighting for a freshly generated chunk.

     Two passes: seed skylight down each column, then flood both channels.
     Called once when a chunk is generated; incremental edits use
     onBlockChanged() instead.
     -------------------------------------------------------------------- */
  lightChunk(chunk) {
    if (!chunk || !chunk.blocks) return;
    const ox = chunk.cx * CHUNK_SX;
    const oz = chunk.cz * CHUNK_SZ;

    chunk.light.fill(0);
    this._invalidateMemo();

    // --- skylight column seeding -------------------------------------
    // Straight down from the sky at full strength until something absorbs it.
    // Pass 1 fills the array; pass 2 decides what actually needs to spread.
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        let level = MAX_LIGHT;
        for (let y = CHUNK_SY - 1; y >= 0; y--) {
          const i = localIndex(lx, y, lz);
          const op = this._opacity(chunk.blocks[i]);
          if (op >= MAX_LIGHT) {
            // Fully blocked: everything below starts dark and only gets light
            // by spreading sideways from an opening.
            level = 0;
          } else if (op > 0) {
            level = Math.max(0, level - op);
          }
          if (level <= 0) continue;  // array is already zeroed by fill(0)
          chunk.light[i] = (chunk.light[i] & 0x0f) | (level << 4);
        }
      }
    }

    // Pass 2: enqueue only voxels that have somewhere to spread TO. In open
    // terrain the overwhelming majority of lit voxels sit in a solid block of
    // sky-15 with equally-bright neighbours on all sides — enqueuing those
    // costs a pop and six neighbour tests to discover there is nothing to do.
    // Seeding ~12k nodes per chunk that way made world load take minutes;
    // this frontier-only seeding cuts it to the handful of voxels that border
    // a shadow, plus the chunk edges (whose neighbours we can't see cheaply).
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        const onBorder = lx === 0 || lx === CHUNK_SX - 1 || lz === 0 || lz === CHUNK_SZ - 1;
        for (let y = 0; y < CHUNK_SY; y++) {
          const i = localIndex(lx, y, lz);
          const level = (chunk.light[i] >> 4) & 0x0f;
          if (level <= 0) continue;

          if (onBorder) { this._skyAdd.push(ox + lx, y, oz + lz); continue; }

          // Interior: enqueue only if some neighbour is darker than this voxel
          // can make it, i.e. there is a shadow to fill in.
          let frontier = false;
          for (let k = 0; k < NEIGHBOURS.length && !frontier; k++) {
            const d = NEIGHBOURS[k];
            const ny = y + d[1];
            if (ny < 0 || ny >= CHUNK_SY) continue;
            const ni = localIndex(lx + d[0], ny, lz + d[2]);
            const nBlock = chunk.blocks[ni];
            if (this._opacity(nBlock) >= MAX_LIGHT) continue;   // solid: no spread
            const nLevel = (chunk.light[ni] >> 4) & 0x0f;
            const reach = (k === DOWN && level === MAX_LIGHT) ? MAX_LIGHT : level - 1;
            if (nLevel < reach) frontier = true;
          }
          if (frontier) this._skyAdd.push(ox + lx, y, oz + lz);
        }
      }
    }

    // --- blocklight seeding from emissive blocks ---------------------
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        for (let y = 0; y < CHUNK_SY; y++) {
          const i = localIndex(lx, y, lz);
          const emit = Blocks.light(chunk.blocks[i]);
          if (emit > 0) {
            chunk.light[i] = (chunk.light[i] & 0xf0) | emit;
            this._blockAdd.push(ox + lx, y, oz + lz);
          }
        }
      }
    }

    this.dirtyChunks.add(chunkKey(chunk.cx, chunk.cz));
    chunk.lit = true;
    this.stats.relitChunks++;
  }

  /* --------------------------------------------------------------------
     A chunk becoming resident can unblock light that was waiting at the
     seam. Re-seed from the borders of all four neighbours so light flows
     both ways across the new boundary.
     -------------------------------------------------------------------- */
  seedFromNeighbours(chunk) {
    if (!chunk) return;
    const ox = chunk.cx * CHUNK_SX;
    const oz = chunk.cz * CHUNK_SZ;
    this._invalidateMemo();

    // Walk the ring of voxels just outside this chunk. Only those actually
    // brighter than the voxel they face across the seam are worth enqueuing —
    // the rest have nothing to contribute, and pushing the whole 80-tall ring
    // of all four neighbours was a large share of world-load cost.
    //
    // (ix,iz) is the voxel just INSIDE this chunk that the outside voxel
    // (wx,wz) would light.
    const edge = (wx, wz, ix, iz) => {
      for (let y = 0; y < CHUNK_SY; y++) {
        const s = this.getSky(wx, y, wz);
        if (s > 1 && this.getSky(ix, y, iz) < s - 1) this._skyAdd.push(wx, y, wz);
        const b = this.getBlockLight(wx, y, wz);
        if (b > 1 && this.getBlockLight(ix, y, iz) < b - 1) this._blockAdd.push(wx, y, wz);
      }
    };
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      edge(ox + lx, oz - 1, ox + lx, oz);
      edge(ox + lx, oz + CHUNK_SZ, ox + lx, oz + CHUNK_SZ - 1);
    }
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      edge(ox - 1, oz + lz, ox, oz + lz);
      edge(ox + CHUNK_SX, oz + lz, ox + CHUNK_SX - 1, oz + lz);
    }
  }

  /* --------------------------------------------------------------------
     Incremental update after a single block change.
     -------------------------------------------------------------------- */
  onBlockChanged(wx, wy, wz, oldId, newId) {
    if (wy < 0 || wy >= CHUNK_SY) return;
    this._invalidateMemo();

    const oldEmit = Blocks.light(oldId);
    const newEmit = Blocks.light(newId);
    const oldOp = this._opacity(oldId);
    const newOp = this._opacity(newId);

    /* ---- blocklight ---- */
    if (oldEmit > 0) {
      // The old source is gone: clear everything it reached, then re-flood
      // from whatever other lights bordered that region.
      this._blockRemove.push(wx, wy, wz, oldEmit);
      this.setBlockLight(wx, wy, wz, 0);
    }
    if (newOp >= MAX_LIGHT && oldOp < MAX_LIGHT) {
      // A solid block now occupies this cell — evict any light stored here.
      const had = this.getBlockLight(wx, wy, wz);
      if (had > 0) {
        this._blockRemove.push(wx, wy, wz, had);
        this.setBlockLight(wx, wy, wz, 0);
      }
    }
    if (newEmit > 0) {
      this.setBlockLight(wx, wy, wz, newEmit);
      this._blockAdd.push(wx, wy, wz);
    } else if (newOp < MAX_LIGHT) {
      // Cell opened up (block broken): neighbours may now flow into it.
      for (const n of NEIGHBOURS) {
        const nx = wx + n[0], ny = wy + n[1], nz = wz + n[2];
        if (this.getBlockLight(nx, ny, nz) > 0) this._blockAdd.push(nx, ny, nz);
      }
    }

    /* ---- skylight ---- */
    if (newOp >= MAX_LIGHT) {
      // Placing a solid block casts a shadow: clear this voxel's skylight and
      // the whole column beneath it, since sky no longer reaches down here.
      const had = this.getSky(wx, wy, wz);
      if (had > 0) {
        this._skyRemove.push(wx, wy, wz, had);
        this.setSky(wx, wy, wz, 0);
      }
      for (let y = wy - 1; y >= 0; y--) {
        const s = this.getSky(wx, y, wz);
        if (s <= 0) break;
        this._skyRemove.push(wx, y, wz, s);
        this.setSky(wx, y, wz, 0);
      }
    } else if (oldOp >= MAX_LIGHT || newOp < oldOp) {
      // The cell got more transparent. If open sky is directly above, push a
      // fresh column of full daylight down; otherwise let neighbours flow in.
      const above = this.getSky(wx, wy + 1, wz);
      if (above >= MAX_LIGHT && newOp === 0) {
        let y = wy;
        while (y >= 0 && this._opacity(this.getBlock(wx, y, wz) ?? ID.AIR) === 0) {
          this.setSky(wx, y, wz, MAX_LIGHT);
          this._skyAdd.push(wx, y, wz);
          y--;
        }
      }
      for (const n of NEIGHBOURS) {
        const nx = wx + n[0], ny = wy + n[1], nz = wz + n[2];
        if (this.getSky(nx, ny, nz) > 0) this._skyAdd.push(nx, ny, nz);
      }
    }
  }

  /* --------------------------------------------------------------------
     Drain the BFS queues. Bounded by `budget` node visits so a big edit
     can't stall a frame; leftovers continue next call.

     Removal runs before addition in both channels — the removal pass seeds
     the addition queue with the surviving border, so running them the other
     way round would re-flood light that is about to be cleared.
     Returns the number of nodes processed.
     -------------------------------------------------------------------- */
  update(budget = 40000) {
    let work = 0;
    this._invalidateMemo();

    work += this._drainBlockRemoval(budget - work);
    work += this._drainBlockAddition(budget - work);
    work += this._drainSkyRemoval(budget - work);
    work += this._drainSkyAddition(budget - work);

    return work;
  }

  get pending() {
    return this._skyAdd.length + this._skyRemove.length
      + this._blockAdd.length + this._blockRemove.length;
  }

  /* ---- blocklight addition ---- */
  _drainBlockAddition(budget) {
    let n = 0;
    const r = this._r3;
    while (!this._blockAdd.isEmpty && n < budget) {
      this._blockAdd.shift(r);
      const [x, y, z] = r;
      const level = this.getBlockLight(x, y, z);
      n++;
      if (level <= 1) continue;

      for (const d of NEIGHBOURS) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        const id = this.getBlock(nx, ny, nz);
        if (id === null) continue;               // chunk not loaded — skip
        const op = this._opacity(id);
        if (op >= MAX_LIGHT) continue;           // solid: light stops
        const target = level - 1 - op;
        if (target <= 0) continue;
        if (this.getBlockLight(nx, ny, nz) < target) {
          this.setBlockLight(nx, ny, nz, target);
          this._blockAdd.push(nx, ny, nz);
        }
      }
    }
    this.stats.blockNodes += n;
    return n;
  }

  /* ---- blocklight removal ---- */
  _drainBlockRemoval(budget) {
    let n = 0;
    const r = this._r4;
    while (!this._blockRemove.isEmpty && n < budget) {
      this._blockRemove.shift(r);
      const [x, y, z, old] = r;
      n++;

      for (const d of NEIGHBOURS) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (this.getBlock(nx, ny, nz) === null) continue;
        const cur = this.getBlockLight(nx, ny, nz);
        if (cur === 0) continue;
        if (cur < old) {
          // This light came from the source we're removing — clear and recurse.
          this.setBlockLight(nx, ny, nz, 0);
          this._blockRemove.push(nx, ny, nz, cur);
        } else {
          // Brighter than what we removed, so it has an independent source.
          // It becomes a border that re-floods the cleared region.
          this._blockAdd.push(nx, ny, nz);
        }
      }
    }
    return n;
  }

  /* ---- skylight addition ---- */
  _drainSkyAddition(budget) {
    let n = 0;
    const r = this._r3;
    while (!this._skyAdd.isEmpty && n < budget) {
      this._skyAdd.shift(r);
      const [x, y, z] = r;
      const level = this.getSky(x, y, z);
      n++;
      if (level <= 0) continue;

      for (let i = 0; i < NEIGHBOURS.length; i++) {
        const d = NEIGHBOURS[i];
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        const id = this.getBlock(nx, ny, nz);
        if (id === null) continue;
        const op = this._opacity(id);
        if (op >= MAX_LIGHT) continue;

        // Sunlight falls straight down forever at full strength — that's what
        // makes an open shaft bright all the way to bedrock rather than fading
        // out after 15 blocks.
        const vertical = i === DOWN && level === MAX_LIGHT && op === 0;
        const target = vertical ? MAX_LIGHT : level - 1 - op;
        if (target <= 0) continue;
        if (this.getSky(nx, ny, nz) < target) {
          this.setSky(nx, ny, nz, target);
          this._skyAdd.push(nx, ny, nz);
        }
      }
    }
    this.stats.skyNodes += n;
    return n;
  }

  /* ---- skylight removal ---- */
  _drainSkyRemoval(budget) {
    let n = 0;
    const r = this._r4;
    while (!this._skyRemove.isEmpty && n < budget) {
      this._skyRemove.shift(r);
      const [x, y, z, old] = r;
      n++;

      for (let i = 0; i < NEIGHBOURS.length; i++) {
        const d = NEIGHBOURS[i];
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (this.getBlock(nx, ny, nz) === null) continue;
        const cur = this.getSky(nx, ny, nz);
        if (cur === 0) continue;
        // Straight down from a full-strength column stays full strength, so
        // "cur < old" would never fire there and the shadow would stop after
        // one step. Treat the downward neighbour of a 15 as removable too.
        const inherited = cur < old || (i === DOWN && old === MAX_LIGHT && cur === MAX_LIGHT);
        if (inherited) {
          this.setSky(nx, ny, nz, 0);
          this._skyRemove.push(nx, ny, nz, cur);
        } else {
          this._skyAdd.push(nx, ny, nz);
        }
      }
    }
    return n;
  }

  /* Hand the accumulated dirty-chunk set to the caller and reset it. */
  takeDirtyChunks() {
    if (this.dirtyChunks.size === 0) return null;
    const out = this.dirtyChunks;
    this.dirtyChunks = new Set();
    return out;
  }

  reset() {
    this._skyAdd.clear();
    this._skyRemove.clear();
    this._blockAdd.clear();
    this._blockRemove.clear();
    this.dirtyChunks.clear();
    this._invalidateMemo();
  }
}

export default LightEngine;
