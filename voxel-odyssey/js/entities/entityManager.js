/* =========================================================================
   entityManager.js — owns every living mob and every dropped item entity.

   Responsibilities:
     - keep the `entities` (Mob[]) and `items` (dropped-item[]) lists;
     - `spawn(type,x,y,z)` a mob and attach its mesh to the scene;
     - `dropItem(x,y,z,key,count)` a small spinning/bobbing pickup that the
       player vacuums up when close (feeding `game.inventory.add` and emitting
       'item:pickup'); items despawn after ~5 minutes;
     - per-frame `update(dt)`: tick mobs, tick item pickups, run ambient
       spawning (passive in daytime on grass, hostile at night on solid ground
       away from the player) under soft caps that rise at night, and despawn
       mobs that drift beyond render distance + a margin;
     - `raycastClosest(origin,dir,maxDist)` — a sphere/AABB ray test against mob
       bodies, used by the player for melee targeting;
     - `damageEntity` / `removeAll` helpers.

   This module builds geometry for dropped items, so it imports Three.js and is
   a "view" module (not a headless Node logic module). Every method is written
   defensively so a missing sibling system never throws inside update(dt).
   ========================================================================= */

import * as THREE from 'three';
import { Mob, MOB_TYPES } from './mob.js';
import Items from '../items/items.js';
import Blocks from '../world/blocks.js';
import { dist2D, RNG } from '../core/utils.js';

/* ---- tuning constants ---------------------------------------------------- */

const ITEM_DESPAWN_TIME = 300;   // seconds a dropped item lives before vanishing
const ITEM_PICKUP_RANGE = 1.3;   // blocks: player within this collects the item
const ITEM_PICKUP_DELAY = 0.5;   // seconds before a fresh drop can be collected
const ITEM_BOB_AMPLITUDE = 0.12; // vertical bob height
const ITEM_BOB_SPEED = 2.4;      // bob frequency
const ITEM_SPIN_SPEED = 1.6;     // radians/sec spin
const ITEM_GRAVITY = -18;        // dropped items fall under light gravity
const ITEM_MERGE_RANGE = 0.65;   // nearby same-type drops merge to reduce clutter

const SPAWN_INTERVAL = 2.0;      // seconds between ambient spawn attempts
const SPAWN_MIN_RADIUS = 14;     // blocks: don't spawn right on top of the player
const SPAWN_MAX_RADIUS = 40;     // blocks: spawn ring outer edge
const SPAWN_ATTEMPTS = 8;        // candidate positions tried per spawn tick
const PASSIVE_CAP = 14;          // soft cap on passive mobs near the player
const HOSTILE_CAP_DAY = 2;       // hostile cap during daytime (rare)
const HOSTILE_CAP_NIGHT = 18;    // hostile cap at night
const NIGHT_LIGHT = 0.35;        // sky light level below which it's "night"

const DESPAWN_MARGIN = 4;        // extra chunks beyond render distance before despawn
const CHUNK_SIZE = 16;           // horizontal chunk size (matches world constants)
const MOB_HEIGHT_FALLBACK = 1.0; // used in ray test when a mob lacks a height

const PASSIVE_TYPES = ['pig', 'cow', 'sheep', 'chicken'];
const HOSTILE_TYPES = ['zombie', 'skeleton', 'spider'];

// Grass-block ids that passive animals are allowed to spawn standing on.
const GRASS_IDS = new Set([Blocks.ID.GRASS]);

/* =========================================================================
   EntityManager
   ========================================================================= */
export class EntityManager {
  constructor(game) {
    this.game = game;
    this.entities = [];   // Mob[]
    this.items = [];      // dropped-item entities

    this._spawnTimer = SPAWN_INTERVAL;
    this._itemIdCounter = 1;

    // A lightly-entropic RNG for ambient spawning. We deliberately avoid
    // Math.random() (per project rules) and seed from the world seed + a clock
    // so spawning varies between sessions without being world-gen.
    this._rng = null;
  }

  init() {
    const seed = (this.game && this.game.seed) | 0;
    this._rng = new RNG((seed ^ 0x9e3779b9) >>> 0);
    this._spawnTimer = SPAWN_INTERVAL;
    return this;
  }

  /* ----------------------------------------------------------------------
     Convenience accessors for sibling systems (read at call time).
     ---------------------------------------------------------------------- */
  get _scene() {
    const g = this.game;
    return (g && (g.scene || (g.engine && g.engine.scene))) || null;
  }
  get _world() { return this.game && this.game.world; }
  get _player() { return this.game && this.game.player; }
  get _sky() { return this.game && this.game.sky; }
  get _events() { return this.game && this.game.events; }

  _renderDistanceChunks() {
    const st = this.game && this.game.state;
    let rd = 6;
    if (st && st.settings && typeof st.settings.renderDistance === 'number') {
      rd = st.settings.renderDistance;
    }
    return rd > 0 ? rd : 6;
  }

  _isNight() {
    const sky = this._sky;
    if (sky && typeof sky.getLightLevel === 'function') {
      try { return sky.getLightLevel() < NIGHT_LIGHT; } catch (_) { /* ignore */ }
    }
    return false;
  }

  /* ----------------------------------------------------------------------
     Mob spawning.
     ---------------------------------------------------------------------- */

  // Spawn a mob of `type` with feet at (x,y,z). Returns the Mob (or null if the
  // type is unknown / the scene is unavailable). The Mob constructor centres the
  // body inside the (x,z) cell, so callers pass integer-ish block coordinates.
  spawn(type, x, y, z) {
    if (!MOB_TYPES[type]) return null;
    let mob;
    try {
      mob = new Mob(this.game, type, x, y, z);
    } catch (err) {
      console.error('[entities] failed to construct mob', type, err);
      return null;
    }
    const scene = this._scene;
    if (scene && mob.mesh) {
      try { scene.add(mob.mesh); } catch (_) { /* ignore */ }
    }
    this.entities.push(mob);
    const events = this._events;
    if (events && typeof events.emit === 'function') {
      try { events.emit('entity:spawn', { entity: mob }); } catch (_) { /* ignore */ }
    }
    return mob;
  }

  /* ----------------------------------------------------------------------
     Dropped item entities.
     ---------------------------------------------------------------------- */

  // Spawn a collectible item entity at (x,y,z). Returns the entity descriptor.
  // The visual is a tiny spinning box tinted by the item's block/icon color so
  // it reads at a glance; it bobs and falls under light gravity onto the ground.
  dropItem(x, y, z, itemKey, count = 1) {
    if (!itemKey || count <= 0) return null;
    // Reject unknown item keys (defensive: an unregistered key has no icon/stack).
    if (typeof Items.has === 'function' && !Items.has(itemKey)) return null;

    // Merge into a nearby same-type drop to keep entity counts sane.
    for (const it of this.items) {
      if (it.removed || it.itemKey !== itemKey) continue;
      const d = dist2D(it.x, it.z, x, z);
      if (d <= ITEM_MERGE_RANGE && Math.abs(it.y - y) <= 1.0) {
        it.count += count;
        it.age = Math.min(it.age, ITEM_DESPAWN_TIME * 0.25); // refresh lifetime a bit
        return it;
      }
    }

    const mesh = this._buildItemMesh(itemKey);
    const entity = {
      id: this._itemIdCounter++,
      itemKey,
      count,
      x, y, z,
      vy: 0,
      // Give a tiny outward toss so a stack of drops fans out instead of stacking.
      vx: this._rng ? this._rng.float(-0.6, 0.6) : 0,
      vz: this._rng ? this._rng.float(-0.6, 0.6) : 0,
      age: 0,
      pickupDelay: ITEM_PICKUP_DELAY,
      spin: this._rng ? this._rng.float(0, Math.PI * 2) : 0,
      mesh,
      removed: false,
    };

    if (mesh) {
      mesh.position.set(x, y, z);
      const scene = this._scene;
      if (scene) { try { scene.add(mesh); } catch (_) { /* ignore */ } }
    }

    this.items.push(entity);
    return entity;
  }

  // Build the little box visual for a dropped item, colored by its block/icon.
  _buildItemMesh(itemKey) {
    let color = [0.8, 0.8, 0.8];
    try {
      const def = Items.get(itemKey);
      if (def) {
        if (def.icon && def.icon.kind === 'block' && def.icon.id != null) {
          color = Blocks.iconColor(def.icon.id);
        } else if (def.blockId != null) {
          color = Blocks.iconColor(def.blockId);
        } else if (def.icon && def.icon.color) {
          color = def.icon.color;
        }
      }
    } catch (_) { /* fall back to grey */ }

    let mesh = null;
    try {
      const geo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(
          clamp01(color[0]), clamp01(color[1]), clamp01(color[2])
        ),
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.name = `item:${itemKey}`;
    } catch (_) {
      mesh = null;
    }
    return mesh;
  }

  // Detach + dispose a dropped-item entity's visual.
  _removeItem(entity) {
    if (!entity || entity.removed) return;
    entity.removed = true;
    const mesh = entity.mesh;
    if (mesh) {
      if (mesh.parent) { try { mesh.parent.remove(mesh); } catch (_) { /* ignore */ } }
      if (mesh.geometry && mesh.geometry.dispose) { try { mesh.geometry.dispose(); } catch (_) {} }
      if (mesh.material && mesh.material.dispose) { try { mesh.material.dispose(); } catch (_) {} }
    }
    entity.mesh = null;
  }

  /* ----------------------------------------------------------------------
     The per-frame update.
     ---------------------------------------------------------------------- */
  update(dt) {
    if (!dt || dt <= 0) return;
    if (dt > 0.1) dt = 0.1;   // clamp huge spikes (tab refocus) to avoid tunneling

    this._updateMobs(dt);
    this._updateItems(dt);
    this._ambientSpawn(dt);
  }

  /* ---- mob ticking + culling ---- */
  _updateMobs(dt) {
    const player = this._player;
    const ppos = player && player.position;
    const renderChunks = this._renderDistanceChunks();
    const despawnDist = (renderChunks + DESPAWN_MARGIN) * CHUNK_SIZE;
    const despawnDistSq = despawnDist * despawnDist;

    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const mob = list[i];
      if (!mob) { list.splice(i, 1); continue; }

      // Update AI/physics defensively.
      if (!mob.removed) {
        try { mob.update(dt); } catch (err) { /* never throw in hot path */ }
      }

      // Remove dead mobs once their death has been processed (mob._die emits the
      // event + drops loot synchronously inside hurt/update).
      if (mob.dead) {
        try { mob.remove(); } catch (_) { /* ignore */ }
        list.splice(i, 1);
        continue;
      }

      // Despawn mobs that have wandered too far from the player.
      if (ppos && mob.position) {
        const dx = mob.position.x - ppos.x;
        const dz = mob.position.z - ppos.z;
        if (dx * dx + dz * dz > despawnDistSq) {
          try { mob.remove(); } catch (_) { /* ignore */ }
          list.splice(i, 1);
          continue;
        }
      }

      // Safety net: if a mob fell out of the world, recycle it.
      if (mob.position && mob.position.y < -8) {
        try { mob.remove(); } catch (_) { /* ignore */ }
        list.splice(i, 1);
      }
    }
  }

  /* ---- dropped-item ticking + pickup ---- */
  _updateItems(dt) {
    const player = this._player;
    const ppos = player && player.position;
    const world = this._world;
    const inv = this.game && this.game.inventory;
    const events = this._events;

    const list = this.items;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it || it.removed) { list.splice(i, 1); continue; }

      it.age += dt;
      if (it.pickupDelay > 0) it.pickupDelay -= dt;

      // Despawn after the lifetime expires.
      if (it.age >= ITEM_DESPAWN_TIME) {
        this._removeItem(it);
        list.splice(i, 1);
        continue;
      }

      // Light physics so drops settle onto the ground rather than float.
      this._integrateItem(it, dt, world);

      // Visual: spin + vertical bob around the resting height.
      it.spin += ITEM_SPIN_SPEED * dt;
      if (it.mesh) {
        const bob = Math.sin(it.age * ITEM_BOB_SPEED) * ITEM_BOB_AMPLITUDE;
        it.mesh.position.set(it.x, it.y + 0.25 + bob, it.z);
        it.mesh.rotation.y = it.spin;
        it.mesh.rotation.x = it.spin * 0.5;
      }

      // Pickup: if the player is close enough (and the grace delay elapsed),
      // funnel the stack into the inventory.
      if (ppos && it.pickupDelay <= 0) {
        // Use a 3D-ish check: horizontal distance + a generous vertical band.
        const horiz = dist2D(it.x, it.z, ppos.x, ppos.z);
        const vert = Math.abs(it.y - ppos.y);
        if (horiz <= ITEM_PICKUP_RANGE && vert <= 2.0) {
          this._collect(it, inv, events);
          if (it.removed) { list.splice(i, 1); continue; }
        }
      }
    }
  }

  // Apply gravity + simple ground clamp to a dropped item so it rests on terrain.
  _integrateItem(it, dt, world) {
    // Horizontal drift, with quick damping.
    it.x += it.vx * dt;
    it.z += it.vz * dt;
    it.vx *= 0.86;
    it.vz *= 0.86;

    // Vertical gravity.
    it.vy += ITEM_GRAVITY * dt;
    let ny = it.y + it.vy * dt;

    if (world && typeof world.heightAt === 'function') {
      let groundY = -Infinity;
      try {
        const h = world.heightAt(Math.floor(it.x), Math.floor(it.z));
        if (h >= 0) groundY = h + 1; // rest on top of the surface block
      } catch (_) { /* ignore */ }
      if (ny <= groundY) {
        ny = groundY;
        it.vy = 0;
        it.vx *= 0.6;
        it.vz *= 0.6;
      }
    } else {
      // No world available: don't let items sink forever.
      if (ny < 0) { ny = 0; it.vy = 0; }
    }
    it.y = ny;
  }

  // Hand a dropped stack to the inventory, dropping the remainder back if the
  // inventory is full. Emits 'item:pickup' for the portion actually taken.
  _collect(it, inv, events) {
    let taken = it.count;
    if (inv && typeof inv.add === 'function') {
      let remaining = it.count;
      try {
        remaining = inv.add(it.itemKey, it.count);
      } catch (_) {
        remaining = it.count; // treat as "nothing fit"
      }
      if (typeof remaining !== 'number' || remaining < 0) remaining = 0;
      remaining = Math.min(remaining, it.count);
      taken = it.count - remaining;
      if (taken <= 0) {
        // Inventory full: leave the item in the world (retry later) but apply a
        // short cooldown so we don't spam add() every frame.
        it.pickupDelay = 0.5;
        return;
      }
      it.count = remaining;
    } else {
      // No inventory system yet: just consume the drop.
      it.count = 0;
    }

    if (events && typeof events.emit === 'function') {
      try { events.emit('item:pickup', { itemId: it.itemKey, count: taken }); } catch (_) { /* ignore */ }
    }

    // If the whole stack was collected, remove the entity; otherwise it lingers.
    if (it.count <= 0) {
      this._removeItem(it);
    }
  }

  /* ----------------------------------------------------------------------
     Ambient spawning.

     Passive animals appear in daylight standing on grass. Hostile monsters
     appear at night on any solid ground, away from the player. Soft caps keep
     the population bounded and rise after dark.
     ---------------------------------------------------------------------- */
  _ambientSpawn(dt) {
    this._spawnTimer -= dt;
    if (this._spawnTimer > 0) return;
    this._spawnTimer = SPAWN_INTERVAL;

    const player = this._player;
    const ppos = player && player.position;
    const world = this._world;
    if (!ppos || !world || !this._rng) return;

    const night = this._isNight();

    // Count current populations so we respect the soft caps.
    let passive = 0, hostile = 0;
    for (const m of this.entities) {
      if (!m || m.dead || m.removed) continue;
      if (m.hostile) hostile++; else passive++;
    }

    const passiveCap = PASSIVE_CAP;
    const hostileCap = night ? HOSTILE_CAP_NIGHT : HOSTILE_CAP_DAY;

    // Pick what to try spawning this tick. Daytime favours passive animals;
    // night favours monsters. We try one category per tick to keep it cheap.
    const canHostile = hostile < hostileCap;
    const canPassive = passive < passiveCap;
    if (!canHostile && !canPassive) return;

    // At night we prioritise filling the (higher) hostile cap; by day we only
    // spawn passive animals on grass.
    let spawnHostile;
    if (night) {
      spawnHostile = canHostile;          // try hostile first; fall back to passive
      if (!spawnHostile && !canPassive) return;
    } else {
      if (!canPassive) return;            // monsters basically don't spawn by day
      spawnHostile = false;
    }

    this._trySpawnNear(ppos, world, spawnHostile);
  }

  // Try a handful of candidate positions in a ring around the player and spawn
  // the first valid one. Validity differs for passive vs hostile mobs.
  _trySpawnNear(ppos, world, hostile) {
    const rng = this._rng;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const ang = rng.float(0, Math.PI * 2);
      const rad = rng.float(SPAWN_MIN_RADIUS, SPAWN_MAX_RADIUS);
      const wx = Math.floor(ppos.x + Math.cos(ang) * rad);
      const wz = Math.floor(ppos.z + Math.sin(ang) * rad);

      let groundY;
      try {
        groundY = world.heightAt(wx, wz);
      } catch (_) {
        continue;
      }
      if (groundY < 0) continue; // open water / void column

      // Need two clear cells above the ground for the mob to stand in.
      if (!this._spaceClear(world, wx, groundY + 1, wz)) continue;

      const surfaceId = this._safeGetBlock(world, wx, groundY, wz);

      if (hostile) {
        // Hostiles: any solid ground, but not on water; prefer darker spots.
        if (!Blocks.isSolid(surfaceId)) continue;
        const type = rng.pick(HOSTILE_TYPES);
        this.spawn(type, wx, groundY + 1, wz);
        return;
      } else {
        // Passives: only on grass blocks.
        if (!GRASS_IDS.has(surfaceId)) continue;
        const type = rng.pick(PASSIVE_TYPES);
        // Animals sometimes spawn in small groups.
        const groupSize = rng.int(1, 3);
        for (let g = 0; g < groupSize; g++) {
          const ox = wx + rng.int(-1, 1);
          const oz = wz + rng.int(-1, 1);
          let gy;
          try { gy = world.heightAt(ox, oz); } catch (_) { gy = groundY; }
          if (gy < 0) gy = groundY;
          if (!this._spaceClear(world, ox, gy + 1, oz)) continue;
          if (!GRASS_IDS.has(this._safeGetBlock(world, ox, gy, oz))) continue;
          this.spawn(type, ox, gy + 1, oz);
        }
        return;
      }
    }
  }

  _safeGetBlock(world, x, y, z) {
    if (!world || typeof world.getBlock !== 'function') return 0;
    try { return world.getBlock(x, y, z); } catch (_) { return 0; }
  }

  // Two stacked air cells (room for most mobs to stand).
  _spaceClear(world, x, y, z) {
    if (!world || typeof world.isSolid !== 'function') return false;
    try {
      return !world.isSolid(x, y, z) && !world.isSolid(x, y + 1, z);
    } catch (_) {
      return false;
    }
  }

  /* ----------------------------------------------------------------------
     Melee targeting: ray vs mob bodies.

     We treat each mob as an axis-aligned box centred on its feet position,
     expanded by its collision footprint and height, and intersect the ray
     against it (slab test). Returns the nearest hit within maxDist.
     ---------------------------------------------------------------------- */
  raycastClosest(origin, dir, maxDist) {
    if (!origin || !dir) return null;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    // Normalize the direction.
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-6) return null;
    dx /= dl; dy /= dl; dz /= dl;
    const maxD = (typeof maxDist === 'number' && maxDist > 0) ? maxDist : 6;

    let best = null;
    let bestDist = maxD;

    for (const mob of this.entities) {
      if (!mob || mob.dead || mob.removed || !mob.position) continue;

      const halfW = (typeof mob.halfW === 'number' ? mob.halfW : (mob.width ? mob.width * 0.5 : 0.45));
      const height = (typeof mob.height === 'number' ? mob.height : MOB_HEIGHT_FALLBACK);

      // AABB in world space (feet at position; box rises by `height`).
      const minX = mob.position.x - halfW, maxX = mob.position.x + halfW;
      const minY = mob.position.y,          maxY = mob.position.y + height;
      const minZ = mob.position.z - halfW, maxZ = mob.position.z + halfW;

      const hit = this._rayAABB(
        ox, oy, oz, dx, dy, dz,
        minX, minY, minZ, maxX, maxY, maxZ
      );
      if (hit !== null && hit >= 0 && hit <= bestDist) {
        bestDist = hit;
        best = mob;
      }
    }

    if (!best) return null;
    return { entity: best, dist: bestDist };
  }

  // Slab method: returns the entry distance t (>=0) if the ray hits the box, or
  // null if it misses. Handles the origin-inside-box case (returns 0).
  _rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
    let tmin = -Infinity, tmax = Infinity;

    // X slab.
    if (Math.abs(dx) < 1e-8) {
      if (ox < minX || ox > maxX) return null;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    // Y slab.
    if (Math.abs(dy) < 1e-8) {
      if (oy < minY || oy > maxY) return null;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    // Z slab.
    if (Math.abs(dz) < 1e-8) {
      if (oz < minZ || oz > maxZ) return null;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }

    if (tmax < 0) return null;          // box is behind the ray
    if (tmin > tmax) return null;       // no overlap → miss
    return tmin >= 0 ? tmin : 0;        // 0 means origin started inside the box
  }

  /* ----------------------------------------------------------------------
     Damage relay + teardown.
     ---------------------------------------------------------------------- */

  // Apply damage to a mob entity (used by the player's attack path). The Mob's
  // own hurt() handles knockback, flash, death, loot, and the death event; we
  // then prune it if it died this tick so callers see a consistent list.
  damageEntity(entity, amount, source) {
    if (!entity || entity.removed || entity.dead) return false;
    if (typeof entity.hurt !== 'function') return false;
    try {
      entity.hurt(amount, source || (this.game && this.game.player) || null);
    } catch (err) {
      return false;
    }
    if (entity.dead) {
      try { entity.remove(); } catch (_) { /* ignore */ }
      const idx = this.entities.indexOf(entity);
      if (idx >= 0) this.entities.splice(idx, 1);
    }
    return true;
  }

  // Remove every mob and dropped item (used on world reset / quit to menu).
  removeAll() {
    for (const mob of this.entities) {
      if (!mob) continue;
      try { mob.remove(); } catch (_) { /* ignore */ }
    }
    this.entities.length = 0;

    for (const it of this.items) {
      this._removeItem(it);
    }
    this.items.length = 0;

    this._spawnTimer = SPAWN_INTERVAL;
  }
}

/* ---- tiny local helper (kept here to avoid an extra import) -------------- */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export default EntityManager;
