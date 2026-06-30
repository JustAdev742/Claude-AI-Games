/* =========================================================================
   particles.js — pooled GPU particle system for block/impact/ambient FX.

   A single THREE.Points object owns a fixed pool of particles backed by typed
   arrays (positions, colors, plus a parallel "soul" arrays for velocity / life
   / size). Spawning a burst just activates dead slots — no per-particle object
   allocation in the hot path. Dead particles are parked far below the world so
   they never draw, and only the live range of the attribute buffers is uploaded
   each frame.

   The system subscribes to gameplay events in init() so most effects happen
   automatically:
     'block:break'  -> colored voxel shatter burst
     'block:place'  -> small dust puff
     'player:hurt'  -> red sparks in front of the camera
     'entity:death' -> puff at the mob

   Public API (per ARCHITECTURE.md):
     new Particles(game)
     init()                                  create points + subscribe
     update(dt)                              integrate + fade + recycle
     reset()                                 kill all live particles
     blockBreak(x, y, z, blockId)            colored burst from a broken block
     emit(x, y, z, color, count, opts)       generic burst (the workhorse)
     splash(x, y, z)                         water splash
     spark(x, y, z, color)                   small bright sparks
   ========================================================================= */

import * as THREE from 'three';
import Blocks from '../world/blocks.js';
import { RNG, clamp01 } from '../core/utils.js';

const MAX_PARTICLES = 2000;     // hard cap on live + dead slots
const GRAVITY = -16;            // world units / s^2 (a touch gentler than the player)
const PARK_Y = -10000;          // dead particles live here, far out of view

export class Particles {
  constructor(game) {
    this.game = game;

    // Filled in init() once we have a scene to attach to.
    this.points = null;
    this.geometry = null;
    this.material = null;

    // Attribute-backing typed arrays (shared with the BufferGeometry).
    this._positions = null;     // Float32Array(MAX*3)
    this._colors = null;        // Float32Array(MAX*3)
    this._sizes = null;         // Float32Array(MAX) — point size per particle

    // Parallel "simulation" arrays (CPU only, never uploaded).
    this._vx = new Float32Array(MAX_PARTICLES);
    this._vy = new Float32Array(MAX_PARTICLES);
    this._vz = new Float32Array(MAX_PARTICLES);
    this._life = new Float32Array(MAX_PARTICLES);     // seconds remaining
    this._maxLife = new Float32Array(MAX_PARTICLES);  // original lifetime
    this._baseSize = new Float32Array(MAX_PARTICLES); // spawn size (for shrink)
    this._r = new Float32Array(MAX_PARTICLES);        // base colour, pre-fade
    this._g = new Float32Array(MAX_PARTICLES);
    this._b = new Float32Array(MAX_PARTICLES);
    this._gravity = new Float32Array(MAX_PARTICLES);  // per-particle gravity scale
    this._drag = new Float32Array(MAX_PARTICLES);     // per-particle linear drag
    this._alive = new Uint8Array(MAX_PARTICLES);      // 0 dead, 1 live

    // A ring cursor so spawns spread across the pool; oldest live slots get
    // overwritten when we run out (graceful degradation instead of dropping FX).
    this._cursor = 0;
    this._liveCount = 0;
    this._maxIndex = 0;         // highest slot index ever touched (upload bound)
    this._dirty = false;        // attributes changed this frame?

    // Deterministic-ish RNG; particles are pure cosmetics so the exact stream
    // does not matter for gameplay, but we avoid Math.random() per the rules.
    this._rng = new RNG((game && game.seed) ? (game.seed ^ 0x9e3779b9) >>> 0 : 1337);

    // Stored unsubscribe handles so reset()/teardown can detach cleanly.
    this._unsub = [];
    this._initialized = false;
  }

  /* ---------------------------------------------------------------------- */
  /* setup                                                                  */
  /* ---------------------------------------------------------------------- */

  init() {
    if (this._initialized) return;
    const scene = this._scene();
    // Even with no scene we still want the API to be callable (no-op draws),
    // so allocate the buffers regardless and only attach to a scene if present.

    const positions = new Float32Array(MAX_PARTICLES * 3);
    const colors = new Float32Array(MAX_PARTICLES * 3);
    const sizes = new Float32Array(MAX_PARTICLES);
    // Park everything off-screen initially so nothing renders at the origin.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      positions[i * 3 + 1] = PARK_Y;
      sizes[i] = 0;
    }
    this._positions = positions;
    this._colors = colors;
    this._sizes = sizes;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Custom per-particle size attribute consumed by the shader tweak below.
    // Named `aSize` (NOT `size`) to avoid clashing with PointsMaterial's
    // built-in `uniform float size;`, which would be a GLSL redefinition.
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);
    this.geometry = geometry;

    // PointsMaterial supports vertexColors + size attenuation out of the box.
    // We additionally fold the per-particle `size` attribute in via onBefore
    // compile so each particle can shrink independently as it dies.
    const material = new THREE.PointsMaterial({
      size: 1.0,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,        // particles shouldn't occlude each other harshly
      blending: THREE.NormalBlending,   // additive off, per spec
      opacity: 1.0,
    });
    material.onBeforeCompile = (shader) => {
      // Inject a per-vertex size multiplier. PointsMaterial's vertex shader
      // computes `gl_PointSize = size;` from its `uniform float size;` (which we
      // keep at 1.0), then applies attenuation. We declare our own `aSize`
      // attribute and fold it in so each particle can shrink independently.
      shader.vertexShader =
        'attribute float aSize;\n' +
        shader.vertexShader.replace(
          'gl_PointSize = size;',
          'gl_PointSize = size * aSize;'
        );
    };
    this.material = material;

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;       // we manage visibility via parking
    points.renderOrder = 5;             // draw after opaque world
    points.name = 'particles';
    this.points = points;

    if (scene && typeof scene.add === 'function') scene.add(points);

    this._subscribe();
    this._initialized = true;
  }

  _scene() {
    const g = this.game;
    if (!g) return null;
    if (g.scene) return g.scene;
    if (g.engine && g.engine.scene) return g.engine.scene;
    return null;
  }

  _subscribe() {
    const ev = this.game && this.game.events;
    if (!ev || typeof ev.on !== 'function') return;

    const onBreak = (p) => {
      if (!p) return;
      this.blockBreak(p.x, p.y, p.z, p.blockId);
    };
    const onPlace = (p) => {
      if (!p) return;
      // A small upward dust puff in the colour of the placed block.
      const col = this._blockColor(p.blockId);
      this.emit(p.x + 0.5, p.y + 0.5, p.z + 0.5, col, 6, {
        speed: 1.2, spread: 0.35, life: 0.45, size: 0.12, gravity: 0.4, up: 0.6,
      });
    };
    const onHurt = () => {
      // Red sparks burst at the camera so the player "feels" the hit.
      const cam = this.game && this.game.camera;
      let x = 0, y = 0, z = 0;
      if (cam && cam.position) { x = cam.position.x; y = cam.position.y; z = cam.position.z; }
      // Push the burst a little ahead of the eye so it's actually visible.
      if (cam && typeof cam.getWorldDirection === 'function') {
        const d = cam.getWorldDirection(_tmpDir);
        x += d.x * 0.6; y += d.y * 0.6; z += d.z * 0.6;
      }
      this.spark(x, y, z, [0.85, 0.12, 0.12]);
    };
    const onDeath = (p) => {
      const e = p && p.entity;
      let x = 0, y = 0, z = 0;
      if (e && e.position) { x = e.position.x; y = e.position.y + 0.6; z = e.position.z; }
      // A pale puff plus a few coloured motes (mob tint if available).
      let col = [0.85, 0.85, 0.85];
      if (e && Array.isArray(e.color)) col = e.color;
      else if (e && e.type && this.game.entities) col = [0.8, 0.8, 0.8];
      this.emit(x, y, z, col, 18, {
        speed: 2.2, spread: 1.0, life: 0.7, size: 0.16, gravity: 0.5, up: 0.4,
      });
    };

    this._unsub.push(ev.on('block:break', onBreak));
    this._unsub.push(ev.on('block:place', onPlace));
    this._unsub.push(ev.on('player:hurt', onHurt));
    this._unsub.push(ev.on('entity:death', onDeath));
  }

  /* ---------------------------------------------------------------------- */
  /* per-frame integration                                                  */
  /* ---------------------------------------------------------------------- */

  update(dt) {
    // Never throw in the hot path; clamp dt against pauses / tab-outs.
    if (!this.geometry || !this._positions) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const pos = this._positions;
    const col = this._colors;
    const siz = this._sizes;
    const vx = this._vx, vy = this._vy, vz = this._vz;
    const life = this._life, maxLife = this._maxLife;
    const baseSize = this._baseSize, gravity = this._gravity, drag = this._drag;
    const alive = this._alive;
    const r = this._r, g = this._g, b = this._b;

    let live = 0;
    let maxIndex = 0;
    const limit = this._maxIndex + 1;

    for (let i = 0; i < limit; i++) {
      if (!alive[i]) continue;

      let t = life[i] - dt;
      if (t <= 0) {
        // Recycle: park it and mark dead.
        alive[i] = 0;
        pos[i * 3 + 1] = PARK_Y;
        siz[i] = 0;
        continue;
      }
      life[i] = t;

      // Integrate velocity (gravity + simple linear drag).
      const gscale = gravity[i];
      vy[i] += GRAVITY * gscale * dt;
      const dr = drag[i];
      if (dr > 0) {
        const f = Math.max(0, 1 - dr * dt);
        vx[i] *= f; vy[i] *= f; vz[i] *= f;
      }

      const o = i * 3;
      pos[o] += vx[i] * dt;
      pos[o + 1] += vy[i] * dt;
      pos[o + 2] += vz[i] * dt;

      // Life-driven fade + shrink. `k` goes 1 -> 0 over the particle's life.
      const k = clamp01(t / (maxLife[i] || 1));
      // Ease the colour toward black a touch as it dies, and shrink the point.
      const fade = k * k * (3 - 2 * k);   // smoothstep for a softer tail
      col[o] = r[i] * (0.35 + 0.65 * fade);
      col[o + 1] = g[i] * (0.35 + 0.65 * fade);
      col[o + 2] = b[i] * (0.35 + 0.65 * fade);
      siz[i] = baseSize[i] * (0.25 + 0.75 * k);

      live++;
      if (i > maxIndex) maxIndex = i;
    }

    this._liveCount = live;
    this._maxIndex = live > 0 ? maxIndex : 0;

    // Upload only the touched range. drawRange covers slot 0..maxIndex.
    const drawCount = live > 0 ? this._maxIndex + 1 : 0;
    this.geometry.setDrawRange(0, drawCount);

    if (this._dirty || live > 0) {
      const upTo = drawCount;
      const posAttr = this.geometry.getAttribute('position');
      const colAttr = this.geometry.getAttribute('color');
      const sizAttr = this.geometry.getAttribute('aSize');
      if (posAttr) { posAttr.needsUpdate = true; this._setUpdateRange(posAttr, upTo * 3); }
      if (colAttr) { colAttr.needsUpdate = true; this._setUpdateRange(colAttr, upTo * 3); }
      if (sizAttr) { sizAttr.needsUpdate = true; this._setUpdateRange(sizAttr, upTo); }
      this._dirty = false;
    }
  }

  // Three.js renamed BufferAttribute.updateRange -> updateRanges over time;
  // set whichever exists so we don't upload the whole buffer needlessly.
  _setUpdateRange(attr, count) {
    if (!attr) return;
    // Prefer the modern API (r159+); only fall back to the deprecated
    // `updateRange` setter on older three builds (avoids deprecation warnings).
    if (typeof attr.addUpdateRange === 'function') {
      if (attr.clearUpdateRanges) attr.clearUpdateRanges();
      attr.addUpdateRange(0, count);
    } else if (attr.updateRange) {
      attr.updateRange.offset = 0;
      attr.updateRange.count = count;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* spawning                                                               */
  /* ---------------------------------------------------------------------- */

  // Find the next slot to (re)use. Prefer a dead slot near the ring cursor;
  // if the pool is saturated, overwrite the cursor slot (oldest-ish).
  _nextSlot() {
    const a = this._alive;
    let i = this._cursor;
    for (let scan = 0; scan < MAX_PARTICLES; scan++) {
      if (!a[i]) { this._cursor = (i + 1) % MAX_PARTICLES; return i; }
      i = (i + 1) % MAX_PARTICLES;
    }
    // Saturated — reuse the cursor slot.
    const slot = this._cursor;
    this._cursor = (this._cursor + 1) % MAX_PARTICLES;
    return slot;
  }

  // Spawn one fully-specified particle. Internal; callers go through emit().
  _spawn(x, y, z, r, g, b, vx, vy, vz, lifeSec, size, gravityScale, dragV) {
    if (!this._positions) return;
    const i = this._nextSlot();

    const o = i * 3;
    this._positions[o] = x;
    this._positions[o + 1] = y;
    this._positions[o + 2] = z;

    this._r[i] = clamp01(r);
    this._g[i] = clamp01(g);
    this._b[i] = clamp01(b);
    this._colors[o] = this._r[i];
    this._colors[o + 1] = this._g[i];
    this._colors[o + 2] = this._b[i];

    this._vx[i] = vx;
    this._vy[i] = vy;
    this._vz[i] = vz;

    this._life[i] = lifeSec;
    this._maxLife[i] = lifeSec;
    this._baseSize[i] = size;
    this._sizes[i] = size;
    this._gravity[i] = gravityScale;
    this._drag[i] = dragV;
    this._alive[i] = 1;

    if (i > this._maxIndex) this._maxIndex = i;
    this._dirty = true;
  }

  /* Generic burst — the workhorse all the named effects build on.
     opts:
       speed    base outward speed (default 2)
       spread   random velocity jitter magnitude (default 0.6)
       life     base lifetime seconds (default 0.6)
       size     base point size (default 0.14)
       gravity  gravity scale 0..1+ (default 1)
       drag     linear drag per second (default 1.5)
       up       extra upward velocity bias (default 0.4)
       jitter   colour jitter 0..1 (default 0.12)
       posSpread initial position scatter radius (default 0.18)
  */
  emit(x, y, z, color, count, opts) {
    if (!this._positions) return;
    if (!Array.isArray(color)) color = [1, 1, 1];
    count = Math.max(0, count | 0);
    opts = opts || {};

    const speed = opts.speed != null ? opts.speed : 2;
    const spread = opts.spread != null ? opts.spread : 0.6;
    const life = opts.life != null ? opts.life : 0.6;
    const size = opts.size != null ? opts.size : 0.14;
    const grav = opts.gravity != null ? opts.gravity : 1;
    const drag = opts.drag != null ? opts.drag : 1.5;
    const up = opts.up != null ? opts.up : 0.4;
    const jitter = opts.jitter != null ? opts.jitter : 0.12;
    const posSpread = opts.posSpread != null ? opts.posSpread : 0.18;

    const rng = this._rng;
    for (let n = 0; n < count; n++) {
      // Random direction on a sphere, biased upward.
      const dx = rng.float(-1, 1);
      const dy = rng.float(-1, 1);
      const dz = rng.float(-1, 1);
      const len = Math.hypot(dx, dy, dz) || 1;
      const sp = speed * (0.6 + rng.float(0, 0.8));
      const vxv = (dx / len) * sp + rng.float(-spread, spread);
      const vyv = (dy / len) * sp + up + rng.float(-spread, spread);
      const vzv = (dz / len) * sp + rng.float(-spread, spread);

      const px = x + rng.float(-posSpread, posSpread);
      const py = y + rng.float(-posSpread, posSpread);
      const pz = z + rng.float(-posSpread, posSpread);

      const j = rng.float(-jitter, jitter);
      const lifeN = life * (0.7 + rng.float(0, 0.6));
      const sizeN = size * (0.7 + rng.float(0, 0.7));

      this._spawn(
        px, py, pz,
        color[0] + j, color[1] + j, color[2] + j,
        vxv, vyv, vzv,
        lifeN, sizeN, grav, drag
      );
    }
  }

  /* Colored shatter burst when a block breaks. Uses the block's icon colour so
     dirt looks brown, grass green, stone grey, etc. */
  blockBreak(x, y, z, blockId) {
    const col = this._blockColor(blockId);
    // Center the burst on the block cube. Accept either feet- or center-coords:
    // events emit integer block coords, so add 0.5 to land in the middle.
    const cx = Math.floor(x) + 0.5;
    const cy = Math.floor(y) + 0.5;
    const cz = Math.floor(z) + 0.5;
    this.emit(cx, cy, cz, col, 22, {
      speed: 2.6, spread: 0.7, life: 0.7, size: 0.16,
      gravity: 1.0, drag: 1.4, up: 1.2, jitter: 0.1, posSpread: 0.32,
    });
    // A few darker "heavy" chunks that fall faster for weight.
    this.emit(cx, cy, cz, [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7], 6, {
      speed: 1.6, spread: 0.4, life: 0.9, size: 0.22,
      gravity: 1.4, drag: 0.8, up: 1.6, jitter: 0.05, posSpread: 0.28,
    });
  }

  /* Water splash — bluish droplets that arc up and fall. */
  splash(x, y, z) {
    const blue = (Blocks.iconColor && Blocks.iconColor(Blocks.ID.WATER)) || [0.16, 0.42, 0.74];
    this.emit(x, y, z, blue, 16, {
      speed: 2.4, spread: 0.5, life: 0.6, size: 0.13,
      gravity: 1.3, drag: 0.6, up: 2.2, jitter: 0.08, posSpread: 0.22,
    });
    // A touch of white foam.
    this.emit(x, y, z, [0.92, 0.95, 1.0], 6, {
      speed: 1.8, spread: 0.4, life: 0.4, size: 0.1,
      gravity: 1.2, drag: 0.8, up: 2.4, jitter: 0.03, posSpread: 0.18,
    });
  }

  /* Bright, fast, short-lived sparks (impacts / hurt). Low gravity so they
     read as energetic flashes rather than falling debris. */
  spark(x, y, z, color) {
    if (!Array.isArray(color)) color = [1, 0.7, 0.2];
    this.emit(x, y, z, color, 10, {
      speed: 3.2, spread: 0.9, life: 0.35, size: 0.1,
      gravity: 0.2, drag: 3.0, up: 0.2, jitter: 0.06, posSpread: 0.1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* helpers + lifecycle                                                    */
  /* ---------------------------------------------------------------------- */

  _blockColor(blockId) {
    // Defensive: unknown / air ids fall back to a neutral grey.
    if (blockId == null) return [0.7, 0.7, 0.7];
    try {
      const c = Blocks.iconColor(blockId);
      if (Array.isArray(c) && c.length >= 3) return c;
    } catch (_) { /* fall through */ }
    return [0.7, 0.7, 0.7];
  }

  // Kill all live particles immediately (e.g. on world reset / quit to menu).
  reset() {
    const alive = this._alive;
    const pos = this._positions;
    const siz = this._sizes;
    if (alive && pos) {
      for (let i = 0; i <= this._maxIndex; i++) {
        if (alive[i]) {
          alive[i] = 0;
          pos[i * 3 + 1] = PARK_Y;
          if (siz) siz[i] = 0;
        }
      }
    }
    this._cursor = 0;
    this._liveCount = 0;
    this._maxIndex = 0;
    this._dirty = true;
    if (this.geometry) {
      this.geometry.setDrawRange(0, 0);
      const posAttr = this.geometry.getAttribute('position');
      const sizAttr = this.geometry.getAttribute('aSize');
      if (posAttr) posAttr.needsUpdate = true;
      if (sizAttr) sizAttr.needsUpdate = true;
    }
  }

  // Optional teardown — detach from scene + event bus and free GPU resources.
  dispose() {
    for (const off of this._unsub) { try { off && off(); } catch (_) {} }
    this._unsub.length = 0;
    const scene = this._scene();
    if (scene && this.points && typeof scene.remove === 'function') scene.remove(this.points);
    if (this.geometry && typeof this.geometry.dispose === 'function') this.geometry.dispose();
    if (this.material && typeof this.material.dispose === 'function') this.material.dispose();
    this._initialized = false;
  }

  // Diagnostics (used by debug overlays if present).
  get liveCount() { return this._liveCount; }
  get capacity() { return MAX_PARTICLES; }
}

// A scratch vector reused for camera-direction maths so onHurt allocates nothing.
const _tmpDir = new THREE.Vector3();

export default Particles;
