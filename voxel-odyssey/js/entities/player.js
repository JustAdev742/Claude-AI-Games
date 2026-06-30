/* =========================================================================
   player.js — the first-person player: look, movement, collision, physics,
   block interaction (mining/placing/eating/attacking), health & damage, and a
   small held-item viewmodel.

   The player is the only entity that reads input directly. main.js calls
   player.update(dt) once per frame while the world is active and the game is
   actually being played (mode === 'play' && !paused).

   Coordinate conventions match the rest of the game: +Y is up, one block = one
   world unit, and `position` is the player's FEET position. The camera (eye)
   sits `EYE_HEIGHT` above the feet. The collision volume is an axis-aligned box
   centered on the feet in x/z and rising from the feet to `PLAYER_HEIGHT`.
   ========================================================================= */

import * as THREE from 'three';
import Blocks, { ID } from '../world/blocks.js';
import Items from '../items/items.js';
import { clamp, lerp, damp, DEG2RAD } from '../core/utils.js';

/* ---- tuning constants ---------------------------------------------------- */

const PLAYER_WIDTH = 0.6;            // full width (x and z); half-extent = 0.3
const PLAYER_HEIGHT = 1.8;           // full standing height
const EYE_HEIGHT = 1.62;             // eye offset above feet
const SNEAK_EYE_DROP = 0.18;         // how much the eye lowers while sneaking

const WALK_SPEED = 4.3;              // blocks/s
const SPRINT_SPEED = 5.6;
const SNEAK_SPEED = 1.6;
const SWIM_SPEED = 3.3;
const FLY_SPEED = 9.0;
const FLY_SPRINT_SPEED = 16.0;

const ACCEL_GROUND = 60;             // how quickly we reach wish velocity on land
const ACCEL_AIR = 14;                // weaker air control
const ACCEL_WATER = 22;
const ACCEL_FLY = 40;

const GRAVITY = -28;                 // blocks/s^2
const JUMP_SPEED = 8.6;              // initial upward velocity on jump
const WATER_BUOYANCY = 18;           // upward accel while swimming and holding jump less
const WATER_SINK = -3.2;             // gentle sink when not swimming up
const MAX_FALL_SPEED = -56;

const PITCH_LIMIT = 89 * DEG2RAD;    // clamp so we never fully flip
const LOOK_BASE = 0.0022;            // radians per mouse pixel at sensitivity 1

const REACH = 5;                     // block interaction distance
const MINE_COOLDOWN = 0.0;           // (instant re-target; progress handles pacing)
const PLACE_COOLDOWN = 0.18;         // seconds between right-click placements when held
const ATTACK_COOLDOWN = 0.45;        // seconds between melee swings

const IFRAME_TIME = 0.5;             // invulnerability window after taking a hit
const FALL_SAFE = 3.2;               // blocks of fall that cause no damage
const FALL_DAMAGE_PER_BLOCK = 1;     // hp per block beyond the safe distance
const DROWN_GRACE = 11;              // seconds of held breath before drowning
const DROWN_INTERVAL = 1.0;          // seconds between drowning ticks
const DROWN_DAMAGE = 2;
const CONTACT_DAMAGE_INTERVAL = 0.5; // cactus/lava contact tick spacing

const DOUBLE_TAP_WINDOW = 0.28;      // seconds for double-tap detection

const MOVE_EVENT_INTERVAL = 0.2;     // throttle for 'player:move'

/* ========================================================================= */

export class Player {
  constructor(game) {
    this.game = game;

    // ---- transform / kinematics ----
    this.position = new THREE.Vector3(0, 64, 0); // feet
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;     // radians; 0 = looking toward -Z
    this.pitch = 0;   // radians; + looks down, - looks up

    // ---- movement state ----
    this.onGround = false;
    this.inWater = false;
    this.headUnderwater = false;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;

    // ---- vitals ----
    this.maxHealth = 20;
    this.health = 20;
    this.gamemode = 'survival';
    this.dead = false;
    this.iframes = 0;

    // ---- environment timers ----
    this.breath = DROWN_GRACE;
    this._drownTimer = 0;
    this._contactTimer = 0;
    this._prevFeetY = this.position.y;
    this._fallStartY = this.position.y;
    this._wasOnGround = true;

    // ---- interaction state ----
    this._miningKey = null;       // voxelKey of the block currently being mined
    this.mineProgress = 0;        // 0..1 progress on the current target
    this._placeTimer = 0;
    this._attackTimer = 0;
    this._lastTarget = null;      // last raycast result (for HUD/particles)

    // ---- double-tap trackers ----
    this._lastForwardTap = -Infinity;
    this._lastJumpTap = -Infinity;
    this._forwardWasDown = false;
    this._jumpWasDown = false;

    // ---- camera feel ----
    this._bobPhase = 0;
    this._bobAmount = 0;
    this._swing = 0;              // viewmodel swing animation 0..1
    this._eyeY = EYE_HEIGHT;

    // ---- viewmodel ----
    this._viewmodel = null;
    this._viewmodelKey = undefined;

    // ---- misc ----
    this._moveEventTimer = 0;
    this._tmpV = new THREE.Vector3();

    this.spawnPoint = { x: 0, y: 64, z: 0 };
  }

  /* ---- lifecycle ------------------------------------------------------- */

  init() {
    // Keep the held-item viewmodel in sync with the selected hotbar slot.
    const ev = this.game.events;
    if (ev) {
      ev.on('hotbar:select', () => { this._refreshViewmodel(); });
      ev.on('inventory:change', () => { this._refreshViewmodel(); });
    }
    // Build the initial viewmodel (deferred-safe: inventory may be empty).
    this._refreshViewmodel();
  }

  /* ---- spawning / respawn --------------------------------------------- */

  spawnAt(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.spawnPoint = { x, y, z };
    this.onGround = false;
    this.dead = false;
    this._prevFeetY = y;
    this._fallStartY = y;
    this._wasOnGround = false;
    this.breath = DROWN_GRACE;
    this._drownTimer = 0;
  }

  respawn() {
    this.health = this.maxHealth;
    this.dead = false;
    this.iframes = 0;
    this.breath = DROWN_GRACE;
    this._drownTimer = 0;
    this.velocity.set(0, 0, 0);
    this.flying = false;

    // Find a fresh safe spawn near the saved spawn point (or world spawn 0,0).
    const world = this.game.world;
    let s = this.spawnPoint;
    if (world && typeof world.getGroundSpawn === 'function') {
      try { s = world.getGroundSpawn(this.spawnPoint.x | 0, this.spawnPoint.z | 0); }
      catch (_) { s = this.spawnPoint; }
    }
    this.position.set(s.x, s.y, s.z);
    this._prevFeetY = s.y;
    this._fallStartY = s.y;
    this._wasOnGround = false;

    const ev = this.game.events;
    if (ev) ev.emit('player:respawn', {});
  }

  setGamemode(m) {
    this.gamemode = (m === 'creative') ? 'creative' : 'survival';
    if (this.gamemode !== 'creative') this.flying = false;
    if (this.gamemode === 'creative') {
      // Creative can't drown or die from fall; top up health for safety.
      this.health = this.maxHealth;
    }
  }

  get isCreative() { return this.gamemode === 'creative'; }

  /* ---- queries --------------------------------------------------------- */

  getEyePosition() {
    return this._tmpV.set(
      this.position.x,
      this.position.y + this._eyeY,
      this.position.z
    );
  }

  getLookDir() {
    // -Z forward, rotated by yaw then pitched. Matches camera.rotation YXZ.
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // Forward vector for YXZ Euler looking down -Z:
    const dir = new THREE.Vector3(
      -cp * sy,
      sp * -1,   // positive pitch (look down) gives negative Y
      -cp * cy
    );
    return dir.normalize();
  }

  /* ---- the per-frame update ------------------------------------------- */

  update(dt) {
    if (!dt || dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // belt-and-braces; engine already clamps

    try {
      this._updateLook(dt);
      this._updateMovement(dt);
      this._updateCollision(dt);
      this._updateEnvironment(dt);
      this._updateInteraction(dt);
      this._updateCamera(dt);
      this._updateTimers(dt);
    } catch (err) {
      // Never throw out of the hot path — log once-ish and keep going.
      if (!this._loggedErr) { console.error('Player.update error:', err); this._loggedErr = true; }
    }
  }

  /* ---- 1. look --------------------------------------------------------- */

  _updateLook() {
    const input = this.game.input;
    if (!input) return;
    const settings = (this.game.state && this.game.state.settings) || {};
    const sens = (settings.mouseSensitivity != null ? settings.mouseSensitivity : 1) * LOOK_BASE;

    let dx = 0, dy = 0;
    if (input.locked) {
      dx = input.mouseDX || 0;
      dy = input.mouseDY || 0;
    } else if (input.touch && input.touch.active) {
      // Touch look deltas (already in pixel-ish units).
      dx = input.touch.mx || 0;
      dy = input.touch.my || 0;
    }

    this.yaw -= dx * sens;
    const invert = settings.invertY ? -1 : 1;
    this.pitch += dy * sens * invert;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    // Keep yaw in a sane range to avoid float drift over long sessions.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /* ---- 2. movement ----------------------------------------------------- */

  _updateMovement(dt) {
    const input = this.game.input;
    const world = this.game.world;
    if (!input) return;

    // --- environment sampling: are we (head/feet) in liquid? ---
    this.inWater = this._isLiquidAt(this.position.x, this.position.y + 0.4, this.position.z);
    this.headUnderwater = this._isLiquidAt(
      this.position.x, this.position.y + this._eyeY, this.position.z
    );

    // --- toggles: creative flight via fly action or double-tap jump ---
    const jumpDown = input.action('jump');
    const jumpTapped = jumpDown && !this._jumpWasDown;
    if (input.actionPressed && input.actionPressed('fly') && this.isCreative) {
      this.flying = !this.flying;
      this.velocity.y = 0;
    } else if (jumpTapped && this.isCreative) {
      const now = this.game.elapsed || 0;
      if (now - this._lastJumpTap < DOUBLE_TAP_WINDOW) {
        this.flying = !this.flying;
        this.velocity.y = 0;
        this._lastJumpTap = -Infinity;
      } else {
        this._lastJumpTap = now;
      }
    }
    if (!this.isCreative) this.flying = false;
    this._jumpWasDown = jumpDown;

    // --- sneak ---
    this.sneaking = !!input.action('sneak') && this.onGround && !this.flying;

    // --- sprint: hold sprint, or double-tap forward ---
    const fwdDown = input.action('forward');
    const fwdTapped = fwdDown && !this._forwardWasDown;
    if (fwdTapped) {
      const now = this.game.elapsed || 0;
      if (now - this._lastForwardTap < DOUBLE_TAP_WINDOW) {
        this._sprintLatch = true;
      }
      this._lastForwardTap = now;
    }
    if (!fwdDown) this._sprintLatch = false;
    this._forwardWasDown = fwdDown;

    const wantSprint = (input.action('sprint') || this._sprintLatch) && fwdDown && !this.sneaking;
    this.sprinting = wantSprint;

    // --- desired horizontal direction in world space ---
    // input.moveAxis() returns {x,z} where x=+1 is strafe-right and z=-1 is
    // forward (toward -Z). Rotate that local vector by yaw about the Y axis:
    //   forward(-Z) world dir = (-sin yaw, -cos yaw)
    //   right(+X)   world dir = ( cos yaw, -sin yaw)
    const axis = input.moveAxis ? input.moveAxis() : { x: 0, z: 0 };
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    let wishX = axis.x * cy - axis.z * sy;
    let wishZ = -axis.x * sy - axis.z * cy;

    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; }

    // --- choose target speed ---
    let speed;
    if (this.flying) {
      speed = (input.action('sprint') ? FLY_SPRINT_SPEED : FLY_SPEED);
    } else if (this.inWater) {
      speed = SWIM_SPEED * (this.sprinting ? 1.15 : 1);
    } else if (this.sneaking) {
      speed = SNEAK_SPEED;
    } else if (this.sprinting) {
      speed = SPRINT_SPEED;
    } else {
      speed = WALK_SPEED;
    }
    const targetVX = wishX * speed * wishLen;
    const targetVZ = wishZ * speed * wishLen;

    // --- horizontal acceleration ---
    let accel;
    if (this.flying) accel = ACCEL_FLY;
    else if (this.inWater) accel = ACCEL_WATER;
    else if (this.onGround) accel = ACCEL_GROUND;
    else accel = ACCEL_AIR;

    this.velocity.x = this._approachVel(this.velocity.x, targetVX, accel, dt, wishLen > 1e-4);
    this.velocity.z = this._approachVel(this.velocity.z, targetVZ, accel, dt, wishLen > 1e-4);

    // --- vertical motion ---
    if (this.flying) {
      // Direct vertical control; no gravity.
      let vy = 0;
      if (jumpDown) vy += 1;
      if (input.action('sneak')) vy -= 1;
      const flySpeed = (input.action('sprint') ? FLY_SPRINT_SPEED : FLY_SPEED);
      this.velocity.y = damp(this.velocity.y, vy * flySpeed, 18, dt);
    } else if (this.inWater) {
      // Buoyancy: swim up while holding jump, otherwise sink slowly.
      if (jumpDown) {
        this.velocity.y += WATER_BUOYANCY * dt;
        if (this.velocity.y > SWIM_SPEED) this.velocity.y = SWIM_SPEED;
      } else {
        // Gravity is heavily damped in water.
        this.velocity.y += (GRAVITY * 0.28) * dt;
        if (this.velocity.y < WATER_SINK) this.velocity.y = WATER_SINK;
      }
      // Extra drag in water.
      this.velocity.y *= (1 - clamp(2.5 * dt, 0, 0.6));
    } else {
      // Normal gravity + jump.
      if (jumpDown && this.onGround) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
        // Sprint-jump preserves a bit of momentum (handled by air accel).
        this._emitSfx('step', { surface: this._groundSurface() });
      }
      this.velocity.y += GRAVITY * dt;
      if (this.velocity.y < MAX_FALL_SPEED) this.velocity.y = MAX_FALL_SPEED;
    }

    void world; // referenced for clarity; collision uses it directly
  }

  // Move a velocity component toward a target with acceleration; apply friction
  // (stronger) when there's no input so the player stops crisply.
  _approachVel(current, target, accel, dt, hasInput) {
    const rate = hasInput ? accel : accel * 1.4;
    const diff = target - current;
    const step = rate * dt;
    if (Math.abs(diff) <= step) return target;
    return current + Math.sign(diff) * step;
  }

  /* ---- 3. collision (swept AABB, axis-by-axis) ------------------------ */

  _updateCollision(dt) {
    const world = this.game.world;
    if (!world || typeof world.isSolid !== 'function') {
      // No world to collide with — integrate freely (defensive).
      this.position.addScaledVector(this.velocity, dt);
      return;
    }

    const half = PLAYER_WIDTH * 0.5;
    const height = PLAYER_HEIGHT;

    // Remember whether sneaking so we can prevent walking off edges.
    const sneakEdgeGuard = this.sneaking && this.onGround && !this.flying;

    let dx = this.velocity.x * dt;
    let dy = this.velocity.y * dt;
    let dz = this.velocity.z * dt;

    // --- Y axis ---
    this.position.y += dy;
    if (this._collidesAABB(world, half, height)) {
      this.position.y -= dy;
      // Resolve precisely against the offending surface.
      this.position.y = this._resolveAxis(world, half, height, 'y', dy);
      if (dy < 0) { this.onGround = true; }
      this.velocity.y = 0;
    } else {
      this.onGround = false;
    }

    // --- X axis (with optional sneak edge guard) ---
    if (dx !== 0) {
      const before = this.position.x;
      this.position.x += dx;
      if (this._collidesAABB(world, half, height)) {
        this.position.x = this._resolveAxis(world, half, height, 'x', dx);
        this.velocity.x = 0;
      } else if (sneakEdgeGuard && !this._hasGroundUnder(world, half)) {
        // Would step off a ledge while sneaking — revert.
        this.position.x = before;
        this.velocity.x = 0;
      }
    }

    // --- Z axis ---
    if (dz !== 0) {
      const before = this.position.z;
      this.position.z += dz;
      if (this._collidesAABB(world, half, height)) {
        this.position.z = this._resolveAxis(world, half, height, 'z', dz);
        this.velocity.z = 0;
      } else if (sneakEdgeGuard && !this._hasGroundUnder(world, half)) {
        this.position.z = before;
        this.velocity.z = 0;
      }
    }

    // Keep the player inside the vertical world range.
    if (this.position.y < -8) {
      // Fell out of the world — emergency respawn (or clamp in creative).
      if (this.isCreative) { this.position.y = 8; this.velocity.y = 0; }
      else { this.hurt(this.maxHealth, 'void'); }
    }
  }

  // True if the player AABB at the current position overlaps any solid voxel.
  _collidesAABB(world, half, height) {
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const minX = Math.floor(px - half), maxX = Math.floor(px + half);
    const minY = Math.floor(py), maxY = Math.floor(py + height - 1e-4);
    const minZ = Math.floor(pz - half), maxZ = Math.floor(pz + half);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (world.isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  // Snap the position along one axis to rest flush against the colliding voxel.
  _resolveAxis(world, half, height, axis, delta) {
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    if (axis === 'y') {
      if (delta < 0) {
        // Moving down: place feet on top of the highest solid voxel below.
        const y = Math.floor(py);
        return y + 1; // top surface of that block
      } else {
        // Moving up: cap head under the lowest solid voxel above.
        const headY = Math.floor(py + height);
        return headY - height;
      }
    } else if (axis === 'x') {
      if (delta > 0) return Math.floor(px + half) - half - 1e-3;
      return Math.floor(px - half) + 1 + half + 1e-3;
    } else { // z
      if (delta > 0) return Math.floor(pz + half) - half - 1e-3;
      return Math.floor(pz - half) + 1 + half + 1e-3;
    }
  }

  // Is there solid ground directly beneath the player's footprint (for sneak)?
  _hasGroundUnder(world, half) {
    const px = this.position.x, pz = this.position.z;
    const y = Math.floor(this.position.y - 0.05);
    const minX = Math.floor(px - half), maxX = Math.floor(px + half);
    const minZ = Math.floor(pz - half), maxZ = Math.floor(pz + half);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (world.isSolid(x, y, z)) return true;
      }
    }
    return false;
  }

  /* ---- 4. environment: fall damage, drowning, overlays ---------------- */

  _updateEnvironment(dt) {
    const ev = this.game.events;

    // --- fall damage: measure the drop since we left the ground ---
    if (!this._wasOnGround && this.onGround) {
      // Just landed.
      const fell = this._fallStartY - this.position.y;
      if (!this.isCreative && !this.inWater && fell > FALL_SAFE) {
        const dmg = Math.floor((fell - FALL_SAFE) * FALL_DAMAGE_PER_BLOCK);
        if (dmg > 0) {
          this.hurt(dmg, 'fall');
          this._emitSfx('hurt');
        }
      }
      this._emitSfx('step', { surface: this._groundSurface() });
    }
    if (this.onGround || this.inWater || this.flying) {
      this._fallStartY = this.position.y;
    } else if (this.position.y > this._fallStartY) {
      // Rising (jump): reset the fall reference to the apex.
      this._fallStartY = this.position.y;
    }
    this._wasOnGround = this.onGround;

    // --- drowning: head underwater consumes breath ---
    if (this.headUnderwater && !this.isCreative) {
      this.breath -= dt;
      if (this.breath <= 0) {
        this._drownTimer += dt;
        if (this._drownTimer >= DROWN_INTERVAL) {
          this._drownTimer = 0;
          this.hurt(DROWN_DAMAGE, 'drown');
        }
      }
      if (ev) ev.emit('player:breath', { breath: clamp(this.breath / DROWN_GRACE, 0, 1) });
    } else {
      if (this.breath < DROWN_GRACE) this.breath = Math.min(DROWN_GRACE, this.breath + dt * 4);
      this._drownTimer = 0;
    }

    // --- water HUD overlay ---
    if (this.game.hud && typeof this.game.hud.setOverlay === 'function') {
      this.game.hud.setOverlay('water', this.headUnderwater);
    }

    // --- contact damage from cactus while standing next to it ---
    this._contactTimer -= dt;
    if (!this.isCreative && this._contactTimer <= 0) {
      if (this._touchingBlock(ID.CACTUS)) {
        this._contactTimer = CONTACT_DAMAGE_INTERVAL;
        this.hurt(1, 'cactus');
      }
    }

    // --- footstep cadence while walking on the ground ---
    if (this.onGround && !this.sneaking) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > 0.8) {
        this._stepAccum = (this._stepAccum || 0) + speed * dt;
        const stride = this.sprinting ? 2.4 : 1.9;
        if (this._stepAccum >= stride) {
          this._stepAccum = 0;
          this._emitSfx('step', { surface: this._groundSurface() });
          // Track distance walked for stats.
          if (this.game.state) this.game.state.addStat('distanceWalked', stride);
        }
      }
    }
  }

  // Is the player AABB overlapping a voxel of the given block id?
  _touchingBlock(blockId) {
    const world = this.game.world;
    if (!world || typeof world.getBlock !== 'function') return false;
    const half = PLAYER_WIDTH * 0.5 + 0.02;
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const minX = Math.floor(px - half), maxX = Math.floor(px + half);
    const minY = Math.floor(py), maxY = Math.floor(py + PLAYER_HEIGHT - 1e-4);
    const minZ = Math.floor(pz - half), maxZ = Math.floor(pz + half);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (world.getBlock(x, y, z) === blockId) return true;
        }
      }
    }
    return false;
  }

  _groundSurface() {
    const world = this.game.world;
    if (!world || typeof world.getBlock !== 'function') return 'stone';
    const y = Math.floor(this.position.y - 0.1);
    const id = world.getBlock(Math.floor(this.position.x), y, Math.floor(this.position.z));
    const b = Blocks.get(id);
    return (b && b.walkSound) ? b.walkSound : 'stone';
  }

  /* ---- 5. interaction: mine / attack / place / eat / select / drop ---- */

  _updateInteraction(dt) {
    const input = this.game.input;
    if (!input) return;

    // Ignore world interaction while a menu/inventory is open.
    const flags = (this.game.state && this.game.state.flags) || {};
    if (flags.inventoryOpen || flags.paused) {
      this.mineProgress = 0;
      this._miningKey = null;
      return;
    }

    this._placeTimer -= dt;
    this._attackTimer -= dt;

    // --- hotbar selection via number keys 1..9 ---
    const inv = this.game.inventory;
    if (inv) {
      for (let i = 0; i < 9; i++) {
        if (input.justPressed && input.justPressed('Digit' + (i + 1))) {
          inv.setSelected(i);
        }
      }
      // --- mouse wheel scroll ---
      const w = input.consumeWheel ? input.consumeWheel() : 0;
      if (w !== 0 && typeof inv.scrollSelected === 'function') inv.scrollSelected(Math.sign(w));
    }

    // --- drop selected (Q) ---
    if (input.actionPressed && input.actionPressed('drop')) {
      this._dropSelected();
    }

    // --- raycast the world for a targeted block ---
    const eye = this.getEyePosition().clone();
    const dir = this.getLookDir();
    const world = this.game.world;
    const hit = (world && typeof world.raycast === 'function')
      ? world.raycast(eye, dir, REACH)
      : null;
    this._lastTarget = hit;

    const held = inv ? inv.selectedItem() : null;
    const heldKey = held ? held.id : null;

    // ===== LEFT MOUSE =====
    const leftHeld = input.mouseDown ? input.mouseDown(0) : false;
    const leftPressed = input.mousePressed ? input.mousePressed(0) : false;
    const touchBreak = input.touch && input.touch.break;

    // Touch attack on press: check mob first.
    if (leftPressed) {
      if (this._tryAttack(eye, dir, heldKey)) {
        // Attacked a mob; skip mining this frame.
      }
    }

    if ((leftHeld || touchBreak) && hit) {
      this._tickMining(dt, hit, heldKey);
    } else {
      this.mineProgress = 0;
      this._miningKey = null;
    }

    // ===== RIGHT MOUSE =====
    const rightPressed = input.mousePressed ? input.mousePressed(2) : false;
    const touchPlace = input.touch && input.touch.place;
    if ((rightPressed || touchPlace) && this._placeTimer <= 0) {
      this._handleUse(hit, held, heldKey);
      this._placeTimer = PLACE_COOLDOWN;
    }
  }

  // Accumulate mining progress; on completion break the block.
  _tickMining(dt, hit, heldKey) {
    const world = this.game.world;
    const b = hit.block;
    const key = b.x + ',' + b.y + ',' + b.z;
    if (key !== this._miningKey) {
      this._miningKey = key;
      this.mineProgress = 0;
    }

    const blockId = hit.blockId;
    const def = Blocks.get(blockId);
    if (!def || def.drop === null && def.hardness === Infinity) {
      // Unbreakable (e.g. bedrock): no progress.
      if (!isFinite(def.hardness)) { this.mineProgress = 0; return; }
    }

    if (this.isCreative) {
      // Instant break, no drop.
      this._breakBlock(b.x, b.y, b.z, blockId, /*drop*/ false);
      this._swing = 1;
      return;
    }

    const hardness = isFinite(def.hardness) ? def.hardness : Infinity;
    if (!isFinite(hardness)) { this.mineProgress = 0; return; }

    // Tool power scales mining speed; correct tool gives a strong bonus.
    const power = this._toolPowerFor(heldKey, def);
    // Time to break ~ hardness * 1.5 / power seconds. Guard against 0 hardness.
    const breakTime = Math.max(0.05, (hardness * 1.5) / Math.max(1, power));
    this.mineProgress += dt / breakTime;
    this._swing = Math.min(1, this._swing + dt * 6);

    if (this.mineProgress >= 1) {
      this.mineProgress = 0;
      this._miningKey = null;
      this._breakBlock(b.x, b.y, b.z, blockId, /*drop*/ true);
    }

    void world;
  }

  // Determine effective mining power for a held item vs a block definition.
  _toolPowerFor(heldKey, blockDef) {
    if (!heldKey) return 1;
    const item = Items.get(heldKey);
    if (!item || !item.tool) return 1;
    const tool = item.tool;
    // Right tool type for the block => full power; wrong tool => 1 (hands).
    const wants = blockDef.tool;
    if (wants && wants !== 'any' && wants !== 'none' && tool.type === wants) {
      return tool.power;
    }
    // A sword (or wrong tool) still chops a touch faster than bare hands.
    return Math.max(1, Math.floor(tool.power * 0.35));
  }

  // Remove a block, emit events, optionally drop its item.
  _breakBlock(x, y, z, blockId, drop) {
    const world = this.game.world;
    if (!world || typeof world.setBlock !== 'function') return;
    const ok = world.setBlock(x, y, z, ID.AIR, { cause: 'break', by: 'player' });
    if (ok === false) return;

    this._swing = 1;
    this._emitSfx('break', { surface: (Blocks.get(blockId) || {}).walkSound });

    // Particles react to 'block:break' from setBlock, but emit directly too.
    if (this.game.particles && typeof this.game.particles.blockBreak === 'function') {
      try { this.game.particles.blockBreak(x + 0.5, y + 0.5, z + 0.5, blockId); } catch (_) {}
    }

    if (this.game.state) this.game.state.addStat('blocksMined', 1);

    if (drop) {
      const dropKey = Items.dropFor(blockId);
      if (dropKey && this.game.entities && typeof this.game.entities.dropItem === 'function') {
        try { this.game.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, dropKey, 1); } catch (_) {}
      }
    }
  }

  // Try to attack a mob under the crosshair. Returns true if a mob was hit.
  _tryAttack(eye, dir, heldKey) {
    if (this._attackTimer > 0) return false;
    const em = this.game.entities;
    if (!em || typeof em.raycastClosest !== 'function') return false;
    let result = null;
    try { result = em.raycastClosest(eye, dir, REACH); } catch (_) { result = null; }
    if (!result || !result.entity) return false;

    const dmg = Items.attack(heldKey);
    this._attackTimer = ATTACK_COOLDOWN;
    this._swing = 1;
    try {
      if (typeof em.damageEntity === 'function') em.damageEntity(result.entity, dmg, this);
      else if (typeof result.entity.hurt === 'function') result.entity.hurt(dmg, this);
    } catch (_) {}
    this._emitSfx('mobHurt');
    return true;
  }

  // Right-click use: place a block, eat food, or open a crafting table.
  _handleUse(hit, held, heldKey) {
    const inv = this.game.inventory;

    // 1) Crafting table under the crosshair → open the 3×3 grid.
    if (hit && this.game.world) {
      if (hit.blockId === ID.CRAFTING_TABLE) {
        if (this.game.menus && typeof this.game.menus.toggleInventory === 'function') {
          this.game.menus.toggleInventory(true);
          return;
        }
      }
    }

    if (!held || !heldKey) return;

    // 2) Food → eat when not at full health.
    if (Items.isFood(heldKey)) {
      if (this.health < this.maxHealth) {
        const item = Items.get(heldKey);
        const heal = (item && item.food) ? item.food : 0;
        if (heal > 0) {
          this.heal(heal);
          if (inv && typeof inv.removeSelected === 'function') inv.removeSelected(1);
          this._emitSfx('eat');
          this._swing = 1;
        }
        return;
      }
      // At full health: fall through (food can't be placed) → do nothing.
      return;
    }

    // 3) Placeable block → place at hit.place if valid.
    if (Items.isPlaceable(heldKey) && hit && hit.place) {
      this._placeBlock(hit, heldKey);
      return;
    }
  }

  _placeBlock(hit, heldKey) {
    const world = this.game.world;
    const inv = this.game.inventory;
    if (!world || typeof world.setBlock !== 'function') return;

    const blockId = Items.blockId(heldKey);
    if (blockId === undefined || blockId === null) return;

    const px = hit.place.x, py = hit.place.y, pz = hit.place.z;

    // Target cell must be empty / replaceable (air or a cross plant or liquid).
    const targetId = world.getBlock(px, py, pz);
    const targetDef = Blocks.get(targetId);
    const replaceable = targetId === ID.AIR ||
      (targetDef && (targetDef.render === 'cross' || targetDef.liquid));
    if (!replaceable) return;

    // Must not intersect the player's body (unless placing a non-solid).
    if (Blocks.isSolid(blockId) && this._aabbOverlapsCell(px, py, pz)) return;

    // Consume from inventory first (survival); creative does not consume.
    if (!this.isCreative) {
      if (!inv || typeof inv.removeSelected !== 'function') return;
      const removed = inv.removeSelected(1);
      if (!removed) return;
    }

    const ok = world.setBlock(px, py, pz, blockId, { cause: 'place', by: 'player' });
    if (ok === false) return;

    this._swing = 1;
    this._emitSfx('place', { surface: (Blocks.get(blockId) || {}).walkSound });
    if (this.game.state) this.game.state.addStat('blocksPlaced', 1);
  }

  // Does the player AABB overlap a given integer voxel cell?
  _aabbOverlapsCell(cx, cy, cz) {
    const half = PLAYER_WIDTH * 0.5;
    const minX = this.position.x - half, maxX = this.position.x + half;
    const minY = this.position.y, maxY = this.position.y + PLAYER_HEIGHT;
    const minZ = this.position.z - half, maxZ = this.position.z + half;
    return (cx + 1 > minX && cx < maxX &&
            cy + 1 > minY && cy < maxY &&
            cz + 1 > minZ && cz < maxZ);
  }

  _dropSelected() {
    const inv = this.game.inventory;
    if (!inv || typeof inv.selectedItem !== 'function') return;
    const stack = inv.selectedItem();
    if (!stack) return;
    const key = stack.id;
    const removed = (typeof inv.removeSelected === 'function') ? inv.removeSelected(1) : 0;
    if (!removed) return;

    // Spawn a world item just in front of the eye.
    const eye = this.getEyePosition();
    const dir = this.getLookDir();
    const x = eye.x + dir.x * 0.8;
    const y = eye.y - 0.2 + dir.y * 0.8;
    const z = eye.z + dir.z * 0.8;
    if (this.game.entities && typeof this.game.entities.dropItem === 'function') {
      try {
        const ent = this.game.entities.dropItem(x, y, z, key, 1);
        // Give it a little outward toss if the entity exposes a velocity.
        if (ent && ent.velocity) {
          ent.velocity.x = dir.x * 4;
          ent.velocity.y = 3;
          ent.velocity.z = dir.z * 4;
        }
      } catch (_) {}
    }
  }

  /* ---- 6. camera + viewmodel ----------------------------------------- */

  _updateCamera(dt) {
    const cam = this.game.camera;
    if (!cam) return;
    const settings = (this.game.state && this.game.state.settings) || {};

    // Smoothly lower the eye while sneaking.
    const targetEye = EYE_HEIGHT - (this.sneaking ? SNEAK_EYE_DROP : 0);
    this._eyeY = damp(this._eyeY, targetEye, 16, dt);

    // View-bob driven by horizontal speed while grounded.
    let bobX = 0, bobY = 0;
    if (settings.viewBobbing) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const moving = this.onGround && speed > 0.6;
      const targetAmt = moving ? clamp(speed / WALK_SPEED, 0, 1.2) : 0;
      this._bobAmount = damp(this._bobAmount, targetAmt, 8, dt);
      if (moving) this._bobPhase += dt * (this.sprinting ? 13 : 10);
      bobY = Math.abs(Math.sin(this._bobPhase)) * 0.045 * this._bobAmount;
      bobX = Math.cos(this._bobPhase) * 0.035 * this._bobAmount;
    } else {
      this._bobAmount = 0;
    }

    // Position the camera at the eye (+ bob offsets).
    const eyeY = this.position.y + this._eyeY + bobY;
    cam.position.set(this.position.x, eyeY, this.position.z);

    // Apply a small lateral bob by nudging along the camera's right vector.
    if (bobX !== 0) {
      const rx = Math.cos(this.yaw); // right vector (x) for yaw
      const rz = -Math.sin(this.yaw);
      cam.position.x += rx * bobX;
      cam.position.z += rz * bobX;
    }

    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    // Update the held-item viewmodel transform / swing.
    this._updateViewmodel(dt);

    // Throttled move event for systems that care.
    this._moveEventTimer -= dt;
    if (this._moveEventTimer <= 0) {
      this._moveEventTimer = MOVE_EVENT_INTERVAL;
      if (this.game.events) {
        this.game.events.emit('player:move', {
          x: this.position.x, y: this.position.y, z: this.position.z,
        });
      }
    }
  }

  _updateTimers(dt) {
    if (this.iframes > 0) this.iframes = Math.max(0, this.iframes - dt);
    // Decay the swing animation back to rest.
    if (this._swing > 0) this._swing = Math.max(0, this._swing - dt * 4);
  }

  /* ---- viewmodel (held item in front of the camera) ------------------- */

  _refreshViewmodel() {
    const inv = this.game.inventory;
    const held = (inv && typeof inv.selectedItem === 'function') ? inv.selectedItem() : null;
    const key = held ? held.id : null;
    if (key === this._viewmodelKey) return;
    this._viewmodelKey = key;
    this._buildViewmodel(key);
  }

  _buildViewmodel(itemKey) {
    const engine = this.game.engine;
    const vmScene = engine && engine.viewmodelScene;
    if (!vmScene) return;

    // Dispose the old viewmodel.
    if (this._viewmodel) {
      vmScene.remove(this._viewmodel);
      this._disposeObject(this._viewmodel);
      this._viewmodel = null;
    }
    if (!itemKey) return;

    const group = new THREE.Group();
    const item = Items.get(itemKey);

    if (item && Items.isPlaceable(itemKey) && item.blockId !== undefined) {
      // Show a little cube colored by the block.
      const col = Blocks.iconColor(item.blockId);
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(col[0], col[1], col[2]) });
      const cube = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), mat);
      group.add(cube);
    } else {
      // Show a generic stick/tool sliver colored by the item.
      let col = [0.7, 0.7, 0.72];
      if (item && item.icon && item.icon.color) col = item.icon.color;
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(col[0], col[1], col[2]) });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), mat);
      bar.rotation.z = -0.5;
      group.add(bar);
    }

    // A soft light so the viewmodel isn't dependent on the world's Sky lights.
    const light = new THREE.DirectionalLight(0xffffff, 0.9);
    light.position.set(0.5, 1, 1);
    group.add(light);
    group.add(new THREE.AmbientLight(0xffffff, 0.5));

    this._viewmodel = group;
    vmScene.add(group);
  }

  _updateViewmodel(dt) {
    if (!this._viewmodel) return;
    // Rest pose: lower-right of the screen, in front of the camera.
    const swing = this._swing;
    const bob = this._bobAmount;
    const t = this.game.elapsed || 0;

    // Base position in camera-local-ish space (viewmodel scene shares the camera).
    const baseX = 0.55, baseY = -0.45, baseZ = -0.9;
    const idleBob = Math.sin(t * 2) * 0.01 * (1 - bob) + Math.sin(t * 9) * 0.015 * bob;

    this._viewmodel.position.set(
      baseX,
      baseY + idleBob - swing * 0.12,
      baseZ + swing * 0.1
    );
    this._viewmodel.rotation.set(
      -swing * 0.9,
      0.3 + swing * 0.2,
      0
    );

    // The viewmodel scene is rendered with the same camera, so transform the
    // local offset into world space relative to the camera each frame.
    const cam = this.game.camera;
    if (cam) {
      this._viewmodel.position.applyQuaternion(cam.quaternion);
      this._viewmodel.position.add(cam.position);
      this._viewmodel.quaternion.copy(cam.quaternion);
      this._viewmodel.rotateX(-swing * 0.9);
      this._viewmodel.rotateY(0.2 + swing * 0.2);
    }
  }

  _disposeObject(obj) {
    obj.traverse((child) => {
      if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose && m.dispose());
        else if (child.material.dispose) child.material.dispose();
      }
    });
  }

  /* ---- health / damage ------------------------------------------------- */

  hurt(amount, source) {
    if (this.dead) return;
    if (this.isCreative && source !== 'void') return; // creative is mostly invincible
    if (amount <= 0) return;
    // Respect i-frames for non-environmental, repeated hits.
    const bypassIFrames = (source === 'void' || source === 'fall' || source === 'drown' || source === 'cactus');
    if (this.iframes > 0 && !bypassIFrames) return;

    this.health = clamp(this.health - amount, 0, this.maxHealth);
    this.iframes = IFRAME_TIME;

    const ev = this.game.events;
    if (ev) ev.emit('player:hurt', { amount, source });

    // HUD hurt overlay flash (HUD also listens to the event, but be explicit).
    if (this.game.hud && typeof this.game.hud.setOverlay === 'function') {
      this.game.hud.setOverlay('hurt', true);
      // It self-clears via HUD's own timer / on the next frame.
    }

    if (this.health <= 0) this._die(source);
  }

  heal(amount) {
    if (this.dead || amount <= 0) return;
    const before = this.health;
    this.health = clamp(this.health + amount, 0, this.maxHealth);
    if (this.health !== before && this.game.events) {
      this.game.events.emit('player:heal', { amount: this.health - before });
    }
  }

  _die(source) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.velocity.set(0, 0, 0);
    if (this.game.state) this.game.state.addStat('deaths', 1);
    if (this.game.events) this.game.events.emit('player:die', { source });
  }

  /* ---- helpers --------------------------------------------------------- */

  _isLiquidAt(x, y, z) {
    const world = this.game.world;
    if (!world) return false;
    if (typeof world.isLiquid === 'function') {
      return world.isLiquid(Math.floor(x), Math.floor(y), Math.floor(z));
    }
    if (typeof world.getBlock === 'function') {
      return Blocks.isLiquid(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
    }
    return false;
  }

  _emitSfx(name, opts) {
    if (this.game.events) this.game.events.emit('sfx', { name, opts: opts || {} });
  }

  /* ---- serialization --------------------------------------------------- */

  serialize() {
    return {
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      velocity: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      maxHealth: this.maxHealth,
      gamemode: this.gamemode,
      flying: this.flying,
      breath: this.breath,
      spawnPoint: { x: this.spawnPoint.x, y: this.spawnPoint.y, z: this.spawnPoint.z },
    };
  }

  load(obj) {
    if (!obj) return;
    if (obj.position) this.position.set(obj.position.x || 0, obj.position.y || 64, obj.position.z || 0);
    if (obj.velocity) this.velocity.set(obj.velocity.x || 0, obj.velocity.y || 0, obj.velocity.z || 0);
    if (typeof obj.yaw === 'number') this.yaw = obj.yaw;
    if (typeof obj.pitch === 'number') this.pitch = clamp(obj.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (typeof obj.maxHealth === 'number') this.maxHealth = obj.maxHealth;
    if (typeof obj.health === 'number') this.health = clamp(obj.health, 0, this.maxHealth);
    if (obj.gamemode) this.setGamemode(obj.gamemode);
    if (typeof obj.flying === 'boolean') this.flying = obj.flying && this.isCreative;
    if (typeof obj.breath === 'number') this.breath = obj.breath;
    if (obj.spawnPoint) this.spawnPoint = { x: obj.spawnPoint.x, y: obj.spawnPoint.y, z: obj.spawnPoint.z };
    this.dead = false;
    this._wasOnGround = false;
    this._fallStartY = this.position.y;
    this._prevFeetY = this.position.y;
    this._refreshViewmodel();
  }
}

export default Player;
