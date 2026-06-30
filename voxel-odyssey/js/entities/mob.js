/* =========================================================================
   mob.js — living creatures (passive animals + hostile monsters).

   A Mob is a small AABB physics body driven by gravity and resolved against
   solid voxels (`game.world.isSolid`), plus a simple behaviour tree:

     - passive mobs wander, pause, and loosely avoid walking off cliffs or
       into deep water;
     - hostile mobs chase the player when it is dark (or once aggravated),
       greedily stepping toward them, hopping single-block ledges, and
       meleeing on contact (with a cooldown);

   The visual is a small `THREE.Group` of colored `MeshLambertMaterial` boxes
   shaped per creature type (body / head / legs), so the shared Sky lighting
   (hemisphere + sun directional) applies. Legs gently swing while moving and
   the whole body flashes red briefly when hurt.

   This module DOES build geometry, so it imports Three.js. It is therefore a
   "view" module (like player.js / world.js) and is not expected to import in
   a headless Node test — but it stays defensive so a missing sibling system
   never throws inside the update() hot path.
   ========================================================================= */

import * as THREE from 'three';
import { clamp, lerp, RNG, dist2D } from '../core/utils.js';
import Blocks from '../world/blocks.js';

/* -------------------------------------------------------------------------
   Mob type table.

   Each entry describes stats and a rough body shape. Sizes are in world
   units (1 = one block). `size` is the collision AABB:
     { w: footprint width/depth, h: standing height }
   `parts` describes the visual boxes relative to the body so we can build a
   recognisable little creature without per-type modelling code.
   ------------------------------------------------------------------------- */

export const MOB_TYPES = {
  /* ---- passive animals ---- */
  pig: {
    hostile: false,
    hp: 10,
    speed: 1.6,
    attack: 0,
    color: 0xea9aa2,        // pink
    accent: 0xc77a82,
    size: { w: 0.9, h: 0.9 },
    legs: 4,
    drops: [{ item: 'raw_meat', min: 1, max: 3 }],
  },
  cow: {
    hostile: false,
    hp: 10,
    speed: 1.5,
    attack: 0,
    color: 0x4a3a2a,        // dark brown
    accent: 0xe8e4dc,       // white patches
    size: { w: 0.95, h: 1.3 },
    legs: 4,
    drops: [
      { item: 'leather', min: 1, max: 2 },
      { item: 'raw_meat', min: 1, max: 3 },
    ],
  },
  sheep: {
    hostile: false,
    hp: 8,
    speed: 1.5,
    attack: 0,
    color: 0xe8e8e2,        // wool white
    accent: 0xd8b8a8,       // bare head
    size: { w: 0.9, h: 1.2 },
    legs: 4,
    drops: [{ item: 'raw_meat', min: 1, max: 2 }],
  },
  chicken: {
    hostile: false,
    hp: 4,
    speed: 1.7,
    attack: 0,
    color: 0xf2f2ee,        // white feathers
    accent: 0xe0a83c,       // beak / legs
    size: { w: 0.5, h: 0.7 },
    legs: 2,
    drops: [
      { item: 'feather', min: 0, max: 2 },
      { item: 'raw_meat', min: 1, max: 1 },
    ],
  },

  /* ---- hostile monsters ---- */
  zombie: {
    hostile: true,
    hp: 20,
    speed: 2.2,
    attack: 3,
    color: 0x4f7a3a,        // sickly green skin
    accent: 0x3a5a8a,       // tattered blue clothes
    size: { w: 0.6, h: 1.9 },
    legs: 2,
    humanoid: true,
    drops: [{ item: 'raw_meat', min: 0, max: 1 }],
  },
  skeleton: {
    hostile: true,
    hp: 16,
    speed: 2.4,
    attack: 2,
    ranged: true,
    color: 0xdedacb,        // bone white
    accent: 0xb6b2a4,
    size: { w: 0.6, h: 1.9 },
    legs: 2,
    humanoid: true,
    drops: [
      { item: 'bone', min: 0, max: 2 },
      { item: 'string', min: 0, max: 1 },
    ],
  },
  spider: {
    hostile: true,
    hp: 16,
    speed: 2.8,
    attack: 2,
    color: 0x2a2630,        // near-black
    accent: 0x7a2a2a,       // red eyes / markings
    size: { w: 1.2, h: 0.8 },
    legs: 8,
    drops: [{ item: 'string', min: 0, max: 2 }],
  },
};

// Shared physics tuning.
const GRAVITY = -26;            // m/s^2
const TERMINAL_VY = -50;        // clamp fall speed
const JUMP_VELOCITY = 8.2;      // enough to clear a 1-block ledge
const ATTACK_RANGE = 1.6;       // melee reach (centre-to-centre, horizontal)
const ATTACK_COOLDOWN = 0.9;    // seconds between melee hits
const AGGRO_RANGE = 16;         // hostile detection radius
const DEAGGRO_RANGE = 26;       // give up beyond this
const NIGHT_LIGHT = 0.35;       // sky light level under which monsters hunt
const HURT_FLASH_TIME = 0.28;   // seconds of red flash
const STEP_EPS = 1e-3;

let _idCounter = 1;

/* =========================================================================
   Mob
   ========================================================================= */
export class Mob {
  constructor(game, type, x, y, z) {
    this.game = game;
    this.type = MOB_TYPES[type] ? type : 'pig';
    this.def = MOB_TYPES[this.type];

    this.id = _idCounter++;
    this.hostile = !!this.def.hostile;
    this.maxHealth = this.def.hp;
    this.health = this.def.hp;
    this.attack = this.def.attack || 0;
    this.speed = this.def.speed || 1.6;
    this.dead = false;
    this.removed = false;

    // Collision box dimensions.
    this.width = this.def.size.w;
    this.height = this.def.size.h;
    this.halfW = this.width * 0.5;

    // Feet position (matches mesh.position). Authoritative state lives here;
    // the mesh is synced to it each frame.
    this.position = new THREE.Vector3(x + 0.5, y, z + 0.5);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.onGround = false;
    this.inWater = false;

    // Per-mob deterministic-ish RNG seeded from spawn position + id so two
    // mobs don't wander in lock-step. (Not world-gen, so a little entropy is
    // fine; we still avoid Math.random for repeatability within a session.)
    this.rng = new RNG((this.id * 2654435761) ^ ((x | 0) * 73856093) ^ ((z | 0) * 19349663));

    // Facing (radians, around +Y). 0 faces +Z.
    this.yaw = this.rng.float(0, Math.PI * 2);

    // AI scratch state.
    this.aggro = false;             // hostile: locked onto the player
    this.attackTimer = 0;           // melee cooldown countdown
    this.rangedTimer = 0;           // ranged cooldown countdown
    this.wanderTimer = this.rng.float(0.5, 2.5);
    this.wandering = false;         // currently walking a wander leg
    this.wishX = 0;                 // desired horizontal move dir (unit-ish)
    this.wishZ = 0;
    this.jumpCooldown = 0;
    this.age = 0;                   // seconds alive (drives leg swing)
    this.moveAmount = 0;            // smoothed "am I moving" for animation
    this.hurtFlash = 0;             // remaining flash time
    this.despawnTimer = 0;          // EntityManager may read/extend this

    // Build the visual.
    this.mesh = new THREE.Group();
    this.mesh.name = `mob:${this.type}:${this.id}`;
    this._parts = [];               // { mesh, baseColor, role }
    this._legParts = [];            // legs we animate
    this._buildMesh();
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
  }

  /* ----------------------------------------------------------------------
     Mesh construction — a handful of boxes per type.
     ---------------------------------------------------------------------- */
  _addBox(w, h, d, x, y, z, color, role = 'body') {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshLambertMaterial({ color });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.mesh.add(m);
    const rec = { mesh: m, baseColor: new THREE.Color(color), role };
    this._parts.push(rec);
    if (role === 'leg') this._legParts.push(rec);
    return m;
  }

  _buildMesh() {
    const def = this.def;
    const col = def.color;
    const acc = def.accent != null ? def.accent : def.color;
    const H = this.height;
    const W = this.width;

    if (def.humanoid) {
      // Upright biped (zombie / skeleton): legs, torso, head, arms.
      const legH = H * 0.45;
      const torsoH = H * 0.35;
      const headS = H * 0.2;
      const legW = W * 0.32;
      // legs
      this._addBox(legW, legH, legW, -W * 0.18, legH * 0.5, 0, col, 'leg');
      this._addBox(legW, legH, legW, W * 0.18, legH * 0.5, 0, col, 'leg');
      // torso
      const torso = this._addBox(W * 0.7, torsoH, W * 0.42, 0, legH + torsoH * 0.5, 0, acc, 'body');
      torso.userData.role = 'body';
      // arms (swing opposite to legs)
      const armH = torsoH * 1.05;
      this._addBox(legW * 0.7, armH, legW * 0.7, -(W * 0.45), legH + torsoH * 0.5, 0.05, col, 'arm');
      this._addBox(legW * 0.7, armH, legW * 0.7, (W * 0.45), legH + torsoH * 0.5, 0.05, col, 'arm');
      // head
      this._addBox(headS * 1.4, headS * 1.4, headS * 1.4, 0, legH + torsoH + headS * 0.7, 0, col, 'head');
    } else if (def.legs === 8) {
      // Spider: low flat body, big head, eight little legs splayed out.
      const bodyY = H * 0.5;
      this._addBox(W * 0.55, H * 0.55, W * 0.6, 0, bodyY, -W * 0.08, col, 'body');   // abdomen
      this._addBox(W * 0.4, H * 0.5, W * 0.35, 0, bodyY, W * 0.4, col, 'head');       // cephalothorax
      // eyes
      this._addBox(W * 0.07, H * 0.07, W * 0.05, -W * 0.1, bodyY + H * 0.1, W * 0.56, acc, 'head');
      this._addBox(W * 0.07, H * 0.07, W * 0.05, W * 0.1, bodyY + H * 0.1, W * 0.56, acc, 'head');
      // 4 legs per side
      for (let i = 0; i < 4; i++) {
        const lz = (i - 1.5) * (W * 0.22);
        this._addBox(W * 0.5, H * 0.12, W * 0.1, -W * 0.4, bodyY * 0.75, lz, col, 'leg');
        this._addBox(W * 0.5, H * 0.12, W * 0.1, W * 0.4, bodyY * 0.75, lz, col, 'leg');
      }
    } else {
      // Quadruped / bird (pig, cow, sheep, chicken).
      const quad = def.legs >= 4;
      const bodyH = H * (quad ? 0.42 : 0.5);
      const bodyW = W * 0.78;
      const bodyD = quad ? W * 1.05 : W * 0.85;
      const legH = H * (quad ? 0.34 : 0.4);
      const legW = W * 0.18;
      const bodyY = legH + bodyH * 0.5;

      // legs (front/back pairs)
      if (quad) {
        const fz = bodyD * 0.32, lx = bodyW * 0.32;
        this._addBox(legW, legH, legW, -lx, legH * 0.5, fz, def.accent ? acc : col, 'leg');
        this._addBox(legW, legH, legW, lx, legH * 0.5, fz, def.accent ? acc : col, 'leg');
        this._addBox(legW, legH, legW, -lx, legH * 0.5, -fz, def.accent ? acc : col, 'leg');
        this._addBox(legW, legH, legW, lx, legH * 0.5, -fz, def.accent ? acc : col, 'leg');
      } else {
        // chicken: two thin legs
        const lx = bodyW * 0.22;
        this._addBox(legW * 0.7, legH, legW * 0.7, -lx, legH * 0.5, 0, acc, 'leg');
        this._addBox(legW * 0.7, legH, legW * 0.7, lx, legH * 0.5, 0, acc, 'leg');
      }

      // body
      this._addBox(bodyW, bodyH, bodyD, 0, bodyY, 0, col, 'body');

      // head at the +Z "front"
      const headS = W * (quad ? 0.5 : 0.42);
      const headZ = bodyD * 0.5 + headS * 0.35;
      const headY = bodyY + bodyH * 0.25;
      this._addBox(headS, headS, headS, 0, headY, headZ, col, 'head');

      // small snout / beak accent
      if (!quad) {
        // beak
        this._addBox(headS * 0.4, headS * 0.3, headS * 0.4, 0, headY, headZ + headS * 0.5, acc, 'head');
        // comb
        this._addBox(headS * 0.25, headS * 0.3, headS * 0.5, 0, headY + headS * 0.6, headZ, 0xc0392b, 'head');
      } else {
        this._addBox(headS * 0.55, headS * 0.45, headS * 0.35, 0, headY - headS * 0.1, headZ + headS * 0.45, acc, 'head');
      }
    }
  }

  /* ----------------------------------------------------------------------
     Collision helpers — AABB swept against solid voxels.
     ---------------------------------------------------------------------- */
  _isSolidAt(wx, wy, wz) {
    const world = this.game && this.game.world;
    if (!world || typeof world.isSolid !== 'function') return false;
    try {
      return !!world.isSolid(Math.floor(wx), Math.floor(wy), Math.floor(wz));
    } catch (_) {
      return false;
    }
  }

  // Does the mob's AABB (at the given feet position) intersect any solid voxel?
  _collides(px, py, pz) {
    const minX = Math.floor(px - this.halfW + STEP_EPS);
    const maxX = Math.floor(px + this.halfW - STEP_EPS);
    const minY = Math.floor(py + STEP_EPS);
    const maxY = Math.floor(py + this.height - STEP_EPS);
    const minZ = Math.floor(pz - this.halfW + STEP_EPS);
    const maxZ = Math.floor(pz + this.halfW - STEP_EPS);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (this._isSolidAt(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  // Move along one axis, stopping at the first collision. Returns true if blocked.
  _moveAxis(axis, amount) {
    if (amount === 0) return false;
    const p = this.position;
    if (axis === 'x') {
      const nx = p.x + amount;
      if (this._collides(nx, p.y, p.z)) { this.velocity.x = 0; return true; }
      p.x = nx;
    } else if (axis === 'y') {
      const ny = p.y + amount;
      if (this._collides(p.x, ny, p.z)) {
        if (amount < 0) this.onGround = true;
        this.velocity.y = 0;
        return true;
      }
      p.y = ny;
    } else {
      const nz = p.z + amount;
      if (this._collides(p.x, p.y, nz)) { this.velocity.z = 0; return true; }
      p.z = nz;
    }
    return false;
  }

  _checkInWater() {
    const world = this.game && this.game.world;
    if (!world || typeof world.isLiquid !== 'function') { this.inWater = false; return; }
    try {
      const fx = Math.floor(this.position.x);
      const fz = Math.floor(this.position.z);
      const fy = Math.floor(this.position.y + this.height * 0.4);
      this.inWater = !!world.isLiquid(fx, fy, fz);
    } catch (_) {
      this.inWater = false;
    }
  }

  /* ----------------------------------------------------------------------
     The frame update — AI + physics + animation. Must never throw.
     ---------------------------------------------------------------------- */
  update(dt) {
    if (this.dead || this.removed) return;
    if (!dt || dt <= 0) return;
    // Guard against huge dt spikes (tab refocus) that would tunnel collisions.
    dt = clamp(dt, 0, 0.1);

    this.age += dt;
    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.rangedTimer > 0) this.rangedTimer -= dt;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      if (this.hurtFlash <= 0) this._setFlash(false);
    }
    this.despawnTimer += dt;

    this._checkInWater();

    // Decide what we want to do this frame (sets this.wishX/wishZ + maybe jump).
    if (this.hostile) this._hostileAI(dt);
    else this._passiveAI(dt);

    this._applyMovement(dt);
    this._animate(dt);

    // Sync the visual to the authoritative feet position + facing.
    this.mesh.position.copy(this.position);
    // Smoothly turn toward the movement direction.
    if (this.wishX !== 0 || this.wishZ !== 0) {
      const targetYaw = Math.atan2(this.wishX, this.wishZ);
      this.yaw = this._approachAngle(this.yaw, targetYaw, dt * 8);
    }
    this.mesh.rotation.y = this.yaw;
  }

  _approachAngle(cur, target, t) {
    let d = target - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return cur + d * clamp(t, 0, 1);
  }

  /* ---- physics integration ---- */
  _applyMovement(dt) {
    const onGroundBefore = this.onGround;
    this.onGround = false;

    // Horizontal wish → target velocity.
    let spd = this.speed;
    if (this.inWater) spd *= 0.6;
    const wlen = Math.hypot(this.wishX, this.wishZ);
    let tx = 0, tz = 0;
    if (wlen > 1e-4) {
      tx = (this.wishX / wlen) * spd;
      tz = (this.wishZ / wlen) * spd;
    }
    // Accelerate toward target horizontal velocity (smooth, with friction).
    const accel = onGroundBefore ? 12 : 4;
    this.velocity.x = lerp(this.velocity.x, tx, clamp(accel * dt, 0, 1));
    this.velocity.z = lerp(this.velocity.z, tz, clamp(accel * dt, 0, 1));

    // Gravity / buoyancy.
    if (this.inWater) {
      this.velocity.y += GRAVITY * 0.3 * dt;     // reduced gravity
      this.velocity.y += 9 * dt;                  // buoyancy: bob upward
      this.velocity.y = clamp(this.velocity.y, -4, 4);
    } else {
      this.velocity.y += GRAVITY * dt;
      if (this.velocity.y < TERMINAL_VY) this.velocity.y = TERMINAL_VY;
    }

    // Resolve axis-by-axis. Y last so onGround reflects the final step.
    this._moveAxis('x', this.velocity.x * dt);
    this._moveAxis('z', this.velocity.z * dt);
    this._moveAxis('y', this.velocity.y * dt);

    // If we're stuck against a wall while wanting to move forward, try a hop.
    if (this.onGround && wlen > 1e-4 && this.jumpCooldown <= 0) {
      if (this._wantsToHop(tx, tz, dt)) {
        this.velocity.y = JUMP_VELOCITY;
        this.jumpCooldown = 0.4;
      }
    }

    // Track smoothed movement amount for animation.
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveAmount = lerp(this.moveAmount, clamp(horizSpeed / Math.max(spd, 0.01), 0, 1), clamp(dt * 8, 0, 1));
  }

  // Look one block ahead in the wish direction: if there's a solid block at
  // foot height but air above it (a climbable 1-block ledge), request a jump.
  _wantsToHop(tx, tz, dt) {
    const len = Math.hypot(tx, tz);
    if (len < 1e-4) return false;
    const dx = tx / len, dz = tz / len;
    const aheadX = this.position.x + dx * (this.halfW + 0.45);
    const aheadZ = this.position.z + dz * (this.halfW + 0.45);
    const footY = Math.floor(this.position.y + 0.1);
    const blockedAtFoot = this._isSolidAt(aheadX, footY, aheadZ);
    const clearAbove1 = !this._isSolidAt(aheadX, footY + 1, aheadZ);
    const clearAbove2 = !this._isSolidAt(aheadX, footY + 2, aheadZ);
    // Also need headroom for ourselves to rise.
    const ownHead = !this._isSolidAt(this.position.x, footY + this.height + 0.2, this.position.z);
    return blockedAtFoot && clearAbove1 && clearAbove2 && ownHead;
  }

  /* ----------------------------------------------------------------------
     Passive AI — wander, pause, loosely avoid cliffs and deep water.
     ---------------------------------------------------------------------- */
  _passiveAI(dt) {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      // Toggle between wandering and pausing.
      this.wandering = !this.wandering;
      if (this.wandering) {
        // Pick a new heading.
        this.yaw = this.rng.float(0, Math.PI * 2);
        this.wanderTimer = this.rng.float(1.5, 4.0);
      } else {
        this.wishX = 0; this.wishZ = 0;
        this.wanderTimer = this.rng.float(1.0, 3.5);
      }
    }

    if (this.wandering) {
      let dx = Math.sin(this.yaw);
      let dz = Math.cos(this.yaw);

      // Loose hazard avoidance: probe the cell we'd step into next.
      if (this._hazardAhead(dx, dz)) {
        // Turn away (pick a fresh random heading) and idle this frame.
        this.yaw = this.rng.float(0, Math.PI * 2);
        dx = 0; dz = 0;
        this.wanderTimer = Math.min(this.wanderTimer, 0.4);
      }
      this.wishX = dx; this.wishZ = dz;
    } else {
      this.wishX = 0; this.wishZ = 0;
    }
  }

  // Returns true if stepping ahead would walk off a cliff (drop > 2) or into
  // deep water. Only consulted when on the ground.
  _hazardAhead(dx, dz) {
    if (!this.onGround) return false;
    const len = Math.hypot(dx, dz) || 1;
    const nx = this.position.x + (dx / len) * (this.halfW + 0.5);
    const nz = this.position.z + (dz / len) * (this.halfW + 0.5);
    const baseY = Math.floor(this.position.y);

    // Cliff: no ground within 2 blocks below the step cell.
    let groundFound = false;
    for (let d = 0; d <= 2; d++) {
      if (this._isSolidAt(nx, baseY - d, nz)) { groundFound = true; break; }
    }
    if (!groundFound) return true;

    // Deep water: liquid at the step cell.
    const world = this.game && this.game.world;
    if (world && typeof world.isLiquid === 'function') {
      try {
        if (world.isLiquid(Math.floor(nx), baseY, Math.floor(nz))) return true;
      } catch (_) { /* ignore */ }
    }
    return false;
  }

  /* ----------------------------------------------------------------------
     Hostile AI — chase + melee (skeleton may also shoot).
     ---------------------------------------------------------------------- */
  _hostileAI(dt) {
    const player = this.game && this.game.player;
    if (!player || !player.position) {
      // No target available — behave like a passive wanderer so it still moves.
      this._passiveAI(dt);
      return;
    }

    const pp = player.position;
    const horiz = dist2D(this.position.x, this.position.z, pp.x, pp.z);

    // Decide whether we should be hunting.
    let dark = false;
    const sky = this.game && this.game.sky;
    if (sky && typeof sky.getLightLevel === 'function') {
      try { dark = sky.getLightLevel() < NIGHT_LIGHT; } catch (_) { dark = false; }
    }
    if (!this.aggro) {
      if (horiz <= AGGRO_RANGE && dark) this.aggro = true;
    } else if (horiz > DEAGGRO_RANGE) {
      this.aggro = false;
    }

    if (!this.aggro) {
      // Idle wander while not engaged.
      this._passiveAI(dt);
      return;
    }

    // Chase: greedy step toward the player on the horizontal plane.
    let dx = pp.x - this.position.x;
    let dz = pp.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;

    // Don't blindly walk into deep-water suicide unless very close.
    if (horiz > ATTACK_RANGE && this._hazardAhead(dx, dz)) {
      // Try a small sidestep to route around the hazard.
      const sideX = -dz, sideZ = dx;
      if (!this._hazardAhead(sideX, sideZ)) { dx = sideX; dz = sideZ; }
      else if (!this._hazardAhead(-sideX, -sideZ)) { dx = -sideX; dz = -sideZ; }
      else { dx = 0; dz = 0; }
    }

    this.wishX = dx;
    this.wishZ = dz;

    // Melee on contact (account for vertical proximity too).
    const dy = Math.abs(pp.y - this.position.y);
    if (horiz <= ATTACK_RANGE && dy < this.height + 0.5) {
      if (this.attackTimer <= 0) {
        this._meleePlayer(player);
        this.attackTimer = ATTACK_COOLDOWN;
      }
      // Stop pressing forward while in melee range so we don't shove into them.
      this.wishX = 0; this.wishZ = 0;
    }

    // Skeleton ranged attack: a light projectile via particles/dropItem is not
    // available, so we model a ranged "shot" as direct damage with a longer
    // cooldown when within sight and at mid range. (Melee fallback otherwise.)
    if (this.def.ranged && horiz > ATTACK_RANGE && horiz <= AGGRO_RANGE) {
      if (this.rangedTimer <= 0 && dark) {
        this._rangedAttack(player, horiz);
        this.rangedTimer = 2.2;
      }
    }
  }

  _meleePlayer(player) {
    try {
      if (typeof player.hurt === 'function') player.hurt(this.attack, this);
    } catch (_) { /* never throw in update */ }
    // Lunge animation hint.
    this.attackTimer = ATTACK_COOLDOWN;
  }

  _rangedAttack(player, dist) {
    // Simplified hitscan "arrow": deal a fraction of melee damage and emit a
    // spark so it reads as a shot. Falls back gracefully if systems missing.
    try {
      if (typeof player.hurt === 'function') player.hurt(Math.max(1, this.attack - 1), this);
    } catch (_) { /* ignore */ }
    const particles = this.game && this.game.particles;
    if (particles && typeof particles.spark === 'function') {
      try {
        particles.spark(
          this.position.x, this.position.y + this.height * 0.7, this.position.z,
          [0.9, 0.9, 0.85]
        );
      } catch (_) { /* ignore */ }
    }
  }

  /* ----------------------------------------------------------------------
     Animation — gentle leg swing while moving, plus hurt flash handling.
     ---------------------------------------------------------------------- */
  _animate(dt) {
    const swingSpeed = 9;
    const amp = 0.5 * this.moveAmount;     // radians, scaled by movement
    const phase = this.age * swingSpeed;
    const legs = this._legParts;
    for (let i = 0; i < legs.length; i++) {
      // Alternate legs swing in opposite phase.
      const sign = (i % 2 === 0) ? 1 : -1;
      legs[i].mesh.rotation.x = Math.sin(phase) * amp * sign;
    }
    // Arms (humanoids) swing opposite to legs.
    for (const rec of this._parts) {
      if (rec.role === 'arm') {
        rec.mesh.rotation.x = -Math.sin(phase) * amp * 0.9;
      }
    }
    // A small idle bob for the head so mobs feel alive even when still.
    const head = this._parts.find((p) => p.role === 'head');
    if (head) {
      head.mesh.rotation.z = Math.sin(this.age * 1.7 + this.id) * 0.04;
    }
  }

  _setFlash(on) {
    for (const rec of this._parts) {
      const mat = rec.mesh.material;
      if (!mat || !mat.color) continue;
      if (on) mat.color.setRGB(1.0, 0.25, 0.25);
      else mat.color.copy(rec.baseColor);
    }
  }

  /* ----------------------------------------------------------------------
     Damage + death.
     ---------------------------------------------------------------------- */
  hurt(amount, source) {
    if (this.dead || this.removed) return;
    amount = Math.max(0, amount || 0);
    if (amount <= 0) return;

    this.health -= amount;

    // Red flash.
    this._setFlash(true);
    this.hurtFlash = HURT_FLASH_TIME;

    // Knockback away from the source (horizontal) + a little pop up.
    const src = source && (source.position || source);
    if (src && typeof src.x === 'number') {
      let kx = this.position.x - src.x;
      let kz = this.position.z - src.z;
      const len = Math.hypot(kx, kz);
      if (len > 1e-4) { kx /= len; kz /= len; }
      else { kx = Math.sin(this.yaw); kz = Math.cos(this.yaw); }
      const power = 6.5;
      this.velocity.x += kx * power;
      this.velocity.z += kz * power;
      if (this.onGround) this.velocity.y = Math.max(this.velocity.y, 4.5);
    }

    // Hostile mobs aggro on whoever hit them (if it was the player).
    const game = this.game;
    if (this.hostile && source && game && source === game.player) {
      this.aggro = true;
    }

    // Hurt SFX (auto-handled by audio via the 'sfx' event).
    if (game && game.events && typeof game.events.emit === 'function') {
      game.events.emit('sfx', { name: 'mobHurt', opts: { x: this.position.x, y: this.position.y, z: this.position.z } });
    }

    if (this.health <= 0) {
      this.health = 0;
      this._die(source);
    }
  }

  _die(source) {
    if (this.dead) return;
    this.dead = true;
    const game = this.game;

    // Drop loot via the EntityManager.
    this._dropLoot();

    // Stats + event.
    if (game) {
      if (game.state && typeof game.state.addStat === 'function') {
        try { game.state.addStat('mobsDefeated', 1); } catch (_) { /* ignore */ }
      }
      if (game.events && typeof game.events.emit === 'function') {
        try { game.events.emit('entity:death', { entity: this, by: source || null }); } catch (_) { /* ignore */ }
      }
    }
    // The EntityManager observes 'entity:death' / mob.dead to recycle us; we
    // also flag for removal so update() becomes a no-op immediately.
  }

  _dropLoot() {
    const game = this.game;
    const em = game && game.entities;
    if (!em || typeof em.dropItem !== 'function') return;
    const drops = this.def.drops || [];
    for (const d of drops) {
      if (!d || !d.item) continue;
      const min = d.min != null ? d.min : 1;
      const max = d.max != null ? d.max : min;
      let count = min;
      if (max > min) count = this.rng.int(min, max);
      if (count <= 0) continue;
      try {
        em.dropItem(
          this.position.x,
          this.position.y + this.height * 0.4,
          this.position.z,
          d.item,
          count
        );
      } catch (_) { /* never throw */ }
    }
  }

  /* ----------------------------------------------------------------------
     Lifecycle + serialization.
     ---------------------------------------------------------------------- */
  remove() {
    if (this.removed) return;
    this.removed = true;
    // Detach from scene.
    if (this.mesh && this.mesh.parent) {
      try { this.mesh.parent.remove(this.mesh); } catch (_) { /* ignore */ }
    }
    // Dispose geometry + materials to avoid GPU leaks.
    for (const rec of this._parts) {
      const m = rec.mesh;
      if (!m) continue;
      if (m.geometry && typeof m.geometry.dispose === 'function') {
        try { m.geometry.dispose(); } catch (_) { /* ignore */ }
      }
      if (m.material && typeof m.material.dispose === 'function') {
        try { m.material.dispose(); } catch (_) { /* ignore */ }
      }
    }
    this._parts.length = 0;
    this._legParts.length = 0;
  }

  serialize() {
    return {
      type: this.type,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      health: this.health,
      yaw: this.yaw,
      aggro: this.aggro,
    };
  }

  // Restore mutable runtime state from a serialized snapshot (best-effort).
  load(obj) {
    if (!obj) return;
    if (typeof obj.x === 'number') this.position.x = obj.x;
    if (typeof obj.y === 'number') this.position.y = obj.y;
    if (typeof obj.z === 'number') this.position.z = obj.z;
    if (typeof obj.health === 'number') this.health = clamp(obj.health, 0, this.maxHealth);
    if (typeof obj.yaw === 'number') this.yaw = obj.yaw;
    if (typeof obj.aggro === 'boolean') this.aggro = obj.aggro;
    if (this.mesh) {
      this.mesh.position.copy(this.position);
      this.mesh.rotation.y = this.yaw;
    }
  }
}

export default Mob;
