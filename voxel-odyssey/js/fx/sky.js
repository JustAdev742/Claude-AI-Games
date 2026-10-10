/* =========================================================================
   sky.js — the day/night cycle: gradient sky dome, sun & moon, starfield,
   drifting clouds, and the scene lighting (hemisphere + directional sun/moon).

   The whole celestial rig is kept centered on the camera each frame so the
   dome never clips and the player can never reach its edge. Colors, fog, and
   light intensities are recomputed every frame from `timeOfDay` (0..1):

       0.00  midnight   (deep navy, stars out, moon high)
       0.25  sunrise    (warm orange horizon, sun rising in the east)
       0.50  noon       (bright blue, sun overhead)
       0.75  sunset     (warm orange/red horizon, sun setting in the west)

   A full day lasts ~`DAY_LENGTH` seconds of game time. The `dt` handed to
   update() has already been scaled by `settings.daylightSpeed` by main.js, so
   here we simply advance `timeOfDay` by `dt / DAY_LENGTH`.

   Everything degrades gracefully: if `engine`, `scene`, or `camera` are
   missing we simply skip the relevant work rather than throwing in the hot
   path.
   ========================================================================= */

import * as THREE from 'three';
import { lerp, clamp, clamp01, mixColor, TAU, smoothstep } from '../core/utils.js';
import { CHUNK_SX } from '../world/constants.js';

// A full day/night cycle in seconds of (scaled) game time.
const DAY_LENGTH = 600;            // ~10 minutes

// Dome radius — large enough to sit far beyond the fog far-plane so its
// gradient reads as the actual sky, but inside the camera's far clip (1000).
const DOME_RADIUS = 480;

// Orbit radius for the sun/moon billboards (kept well inside the dome).
const ORBIT_RADIUS = 400;

// Keyframed palettes for the sky. Each entry is sampled and blended by the
// current time of day. Colors are [r,g,b] in 0..1 (mixColor-friendly).
// `top`   — zenith color of the dome
// `horizon` — color at the horizon (also drives fog + scene.background)
// `sun`   — tint of sunlight (warm at dawn/dusk, white at noon)
// `sunI`  — directional sun intensity
// `hemiSky`/`hemiGround` — hemisphere light colors
// `hemiI` — hemisphere intensity
// `light` — abstract global light level 0..1 (mob spawning / HUD)
const KEYS = [
  // t,    top,                 horizon,             sun,                 sunI, hemiSky,             hemiGround,          hemiI, light
  { t: 0.00, top: [0.02, 0.03, 0.10], horizon: [0.05, 0.06, 0.14], sun: [0.30, 0.36, 0.62], sunI: 0.04, hemiSky: [0.06, 0.08, 0.18], hemiGround: [0.02, 0.03, 0.05], hemiI: 0.18, light: 0.04 },
  { t: 0.20, top: [0.06, 0.08, 0.20], horizon: [0.16, 0.12, 0.22], sun: [0.55, 0.45, 0.55], sunI: 0.10, hemiSky: [0.18, 0.16, 0.26], hemiGround: [0.06, 0.06, 0.08], hemiI: 0.30, light: 0.12 },
  { t: 0.25, top: [0.26, 0.30, 0.52], horizon: [0.95, 0.55, 0.32], sun: [1.00, 0.66, 0.42], sunI: 0.55, hemiSky: [0.70, 0.56, 0.52], hemiGround: [0.24, 0.18, 0.14], hemiI: 0.55, light: 0.45 },
  { t: 0.32, top: [0.30, 0.52, 0.86], horizon: [0.66, 0.78, 0.92], sun: [1.00, 0.92, 0.78], sunI: 0.95, hemiSky: [0.66, 0.80, 0.98], hemiGround: [0.38, 0.36, 0.30], hemiI: 0.78, light: 0.82 },
  { t: 0.50, top: [0.27, 0.52, 0.92], horizon: [0.62, 0.80, 1.00], sun: [1.00, 0.98, 0.92], sunI: 1.15, hemiSky: [0.64, 0.82, 1.00], hemiGround: [0.42, 0.40, 0.34], hemiI: 0.90, light: 1.00 },
  { t: 0.68, top: [0.30, 0.52, 0.86], horizon: [0.70, 0.74, 0.90], sun: [1.00, 0.90, 0.74], sunI: 0.95, hemiSky: [0.66, 0.78, 0.96], hemiGround: [0.38, 0.36, 0.30], hemiI: 0.78, light: 0.82 },
  { t: 0.75, top: [0.28, 0.26, 0.46], horizon: [0.96, 0.46, 0.26], sun: [1.00, 0.56, 0.34], sunI: 0.55, hemiSky: [0.72, 0.50, 0.46], hemiGround: [0.24, 0.16, 0.14], hemiI: 0.52, light: 0.42 },
  { t: 0.80, top: [0.08, 0.08, 0.22], horizon: [0.22, 0.12, 0.20], sun: [0.55, 0.40, 0.48], sunI: 0.10, hemiSky: [0.18, 0.14, 0.24], hemiGround: [0.06, 0.06, 0.08], hemiI: 0.30, light: 0.12 },
  { t: 1.00, top: [0.02, 0.03, 0.10], horizon: [0.05, 0.06, 0.14], sun: [0.30, 0.36, 0.62], sunI: 0.04, hemiSky: [0.06, 0.08, 0.18], hemiGround: [0.02, 0.03, 0.05], hemiI: 0.18, light: 0.04 },
];

// Cloud layer: a CLOUD_GRID x CLOUD_GRID bitmap of CLOUD_CELL-block slabs.
const CLOUD_GRID = 64;
const CLOUD_CELL = 14;
const CLOUD_THICK = 5;
const CLOUD_HEIGHT = 112;     // world y of the cloud base
const CLOUD_DRIFT = 2.4;      // blocks per second toward +x

// sRGB-ish display value -> linear light.
const lin = (v) => Math.pow(v < 0 ? 0 : v, 2.2);

// Scale from the terrain shader's linear light to the built-in entity lights.
const ENTITY_GAIN = 0.55;
const BASE_EXPOSURE = 1.15;

// Cold blue floors blended in at night (linear light).
const NIGHT_AMBIENT_SKY = [0.010, 0.016, 0.040];
const NIGHT_AMBIENT_GROUND = [0.004, 0.006, 0.014];
const NIGHT_MOONLIGHT = [0.020, 0.030, 0.062];

// A reusable, mutable palette object so per-frame sampling is allocation-free.
const SAMPLE = {
  top: [0, 0, 0], horizon: [0, 0, 0], sun: [0, 0, 0],
  hemiSky: [0, 0, 0], hemiGround: [0, 0, 0],
  sunI: 0, hemiI: 0, light: 0,
};

export class Sky {
  constructor(game) {
    this.game = game;

    // The canonical clock for the world. 0.30 ≈ a pleasant mid-morning start.
    this.timeOfDay = 0.30;

    // Cached phase so we only emit 'time:phase' on an actual change, and a day
    // counter so 'time:day' fires once per dawn crossing.
    this._phase = this._phaseFor(this.timeOfDay);
    this._dayCount = 0;
    this._lastTime = this.timeOfDay;

    // Three.js objects, created in init().
    this.group = null;          // holds dome + celestial bodies, follows camera
    this.dome = null;
    this.domeMat = null;
    this.sunMesh = null;
    this.moonMesh = null;
    this.sunSprite = null;
    this.moonSprite = null;
    this.stars = null;
    this.starMat = null;
    this.cloudGroup = null;
    this.clouds = [];

    // Lights.
    this.hemi = null;
    this.sun = null;            // DirectionalLight following the sun
    this.moon = null;           // dim DirectionalLight for moonlight

    // Current sampled light level (0..1), exposed via getLightLevel().
    this._lightLevel = 1;

    // Terrain lighting state consumed by the voxel shader each frame.
    this._terrainTint = [1, 1, 1];
    this._terrainDaylight = 1;
    // Linear-light inputs for the terrain shader (see render/material.js):
    // hemisphere ambient for upward / downward facing surfaces, and the colour
    // and strength of the direct sun (or moon).
    this._ambSky = [0.3, 0.4, 0.6];
    this._ambGround = [0.1, 0.1, 0.1];
    this._sunLight = [1, 1, 1];
    this._sunOnly = [1, 1, 1];     // direct sun colour without the moonlight floor
    this._horizonLin = [0.4, 0.6, 1];
    this._underwater = 0;        // 0..1, eased: how submerged the camera is
    this._zenithLin = [0.1, 0.3, 0.8];
    this._elapsed = 0;             // seconds, drives foliage wind sway

    this._initialized = false;
  }

  /* ----------------------------------------------------------------------
     init — build the dome, celestial bodies, stars, clouds, and lights.
     ---------------------------------------------------------------------- */
  init() {
    if (this._initialized) return;
    const game = this.game;
    const scene = game && (game.scene || (game.engine && game.engine.scene));
    if (!scene) { this._initialized = true; return; }

    this.group = new THREE.Group();
    this.group.name = 'sky';
    // The sky must never be culled (it is centered on the camera) and never
    // occluded by anything; it is drawn first behind everything else.
    this.group.frustumCulled = false;

    this._buildDome();
    this._buildCelestialBodies();
    this._buildStars();
    this.setClouds(this._fancy());

    scene.add(this.group);

    this._buildLights(scene);

    // Prime all visuals to the current time so frame 0 already looks right.
    this._applyTime(0);
    this._initialized = true;
  }

  /* ---- builders -------------------------------------------------------- */

  _buildDome() {
    // A large inverted sphere viewed from the inside (BackSide). The dome uses
    // a vertex-colored material we recolor per frame: top vertices get the
    // zenith color, equator/bottom vertices the horizon color. A small custom
    // attribute `skyMix` stores each vertex's 0..1 vertical blend so recoloring
    // is a cheap lerp without recomputing geometry.
    const geo = new THREE.SphereGeometry(DOME_RADIUS, 32, 20);
    const pos = geo.attributes.position;
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Normalize y (-R..R) into 0..1, then bias so the warm band hugs the
      // horizon and the zenith color dominates most of the sky.
      const y = pos.getY(i) / DOME_RADIUS;       // -1..1
      let t = clamp01((y + 0.15) / 0.85);        // horizon a touch below eye
      t = Math.pow(t, 0.55);                     // expand the upper gradient
      mix[i] = t;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('skyMix', new THREE.BufferAttribute(mix, 1));
    this._domeMix = mix;
    this._domeColors = colors;

    this.domeMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,            // the dome IS the sky; do not fog it
      depthWrite: false,     // never occlude the world
      depthTest: false,      // always render behind everything
    });
    this.dome = new THREE.Mesh(geo, this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;   // draw first, behind the world
    this.group.add(this.dome);
  }

  _buildCelestialBodies() {
    // Sun: a bright emissive disc. Moon: a paler disc. We use small flat
    // circle meshes that always face the camera-centered origin (they orbit
    // the group, which itself follows the camera, so no per-frame billboarding
    // math is required — a camera-facing plane is good enough at this scale).
    const sunGeo = new THREE.CircleGeometry(26, 24);
    // depthTest MUST be on. These are drawn in the transparent pass, i.e.
    // AFTER opaque terrain, so the depth buffer already holds the terrain in
    // front of them; without the test they simply paint over mountains and
    // walls. depthWrite stays off so they never occlude each other or water.
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c4, fog: false, depthWrite: false, depthTest: true,
      transparent: true, opacity: 1,
    });
    this.sunMat = sunMat;
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.sunMesh.frustumCulled = false;
    this.sunMesh.renderOrder = -900;

    // A soft glow halo around the sun.
    const glowGeo = new THREE.CircleGeometry(46, 24);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffe9a0, fog: false, depthWrite: false, depthTest: true,
      transparent: true, opacity: 0.28,
    });
    this.sunGlowMat = glowMat;
    this.sunGlow = new THREE.Mesh(glowGeo, glowMat);
    this.sunGlow.frustumCulled = false;
    this.sunGlow.renderOrder = -901;
    this.sunMesh.add(this.sunGlow);

    const moonGeo = new THREE.CircleGeometry(20, 24);
    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xeef0ff, fog: false, depthWrite: false, depthTest: true,
      transparent: true, opacity: 1,
    });
    this.moonMat = moonMat;
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.moonMesh.frustumCulled = false;
    this.moonMesh.renderOrder = -900;

    this.group.add(this.sunMesh);
    this.group.add(this.moonMesh);
  }

  _buildStars() {
    // A field of points scattered on a sphere just inside the dome. Deterministic
    // pseudo-random placement (a fixed seed) so the constellations are stable,
    // and we vary point sizes for a little depth. Opacity is animated at night.
    const COUNT = 1400;
    const positions = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    let s = 0x9e3779b9 >>> 0;
    const rnd = () => {
      // xorshift for stable star placement (no Math.random dependency).
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
    const R = DOME_RADIUS * 0.92;
    let k = 0;
    for (let i = 0; i < COUNT; i++) {
      // Uniform sphere sampling.
      const u = rnd() * 2 - 1;             // cos(theta)
      const phi = rnd() * TAU;
      const r = Math.sqrt(1 - u * u);
      const x = r * Math.cos(phi);
      const y = u;
      const z = r * Math.sin(phi);
      // Keep most stars in the upper hemisphere (a few below for richness).
      const yy = y < -0.1 ? -0.1 + (y + 0.1) * 0.3 : y;
      positions[k] = x * R;
      positions[k + 1] = yy * R;
      positions[k + 2] = z * R;
      sizes[i] = 1.2 + rnd() * 2.6;
      k += 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,             // faded in at night
      fog: false,
      depthWrite: false,
      // Stars are occluded by terrain for the same reason the sun is: they
      // are drawn after opaque geometry, so without the test a mountain at
      // night has a starfield painted across it.
      depthTest: true,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -950;   // behind sun/moon, in front of dome
    this.group.add(this.stars);
  }

  // Show or hide the cloud layer, building it the first time it is wanted.
  // Clouds cost nine transparent draws and a lot of overdraw, so the low
  // quality preset leaves them off.
  setClouds(on) {
    if (on && !this.cloudGroup && this.group) this._buildClouds();
    if (this.cloudGroup) this.cloudGroup.visible = !!on;
  }

  _buildClouds() {
    // Blocky voxel clouds in the classic style: a tileable noise bitmap becomes
    // a layer of slabs, only the faces you could see are meshed, and the whole
    // layer is one geometry drawn nine times (a 3x3 tiling) so it can scroll
    // forever. The layer is fixed in the WORLD, not the camera, so walking
    // gives proper parallax — see _updateClouds. Only built with fancyGraphics.
    this.cloudGroup = new THREE.Group();
    this.cloudGroup.frustumCulled = false;

    const N = CLOUD_GRID, CELL = CLOUD_CELL, H = CLOUD_THICK;
    // Tileable value noise: lattices wrap, so the bitmap has no seam.
    let seed = 0x51ed270b >>> 0;
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    const octaves = [[6, 0.55], [12, 0.30], [24, 0.15]].map(([size, weight]) => {
      const lat = new Float32Array(size * size);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      return { size, weight, lat };
    });
    const sample = (x, z) => {
      let v = 0;
      for (const o of octaves) {
        const fx = (x / N) * o.size, fz = (z / N) * o.size;
        const x0 = Math.floor(fx), z0 = Math.floor(fz);
        const tx = fx - x0, tz = fz - z0;
        const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
        const at = (i, j) => o.lat[(((j % o.size) + o.size) % o.size) * o.size + (((i % o.size) + o.size) % o.size)];
        const top = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * sx;
        const bot = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * sx;
        v += (top + (bot - top) * sz) * o.weight;
      }
      return v;
    };
    const filled = new Uint8Array(N * N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) filled[z * N + x] = sample(x, z) > 0.605 ? 1 : 0;
    const at = (x, z) => filled[(((z % N) + N) % N) * N + (((x % N) + N) % N)];

    const pos = [], col = [], idx = [];
    const quad = (a, b2, c, d, shade) => {
      const base = pos.length / 3;
      for (const v of [a, b2, c, d]) { pos.push(v[0], v[1], v[2]); col.push(shade, shade, shade); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (!at(x, z)) continue;
        const x0 = x * CELL, x1 = x0 + CELL, z0 = z * CELL, z1 = z0 + CELL;
        quad([x0, H, z1], [x1, H, z1], [x1, H, z0], [x0, H, z0], 1.0);          // top
        quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], 0.8);          // underside
        if (!at(x + 1, z)) quad([x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1], 0.82);
        if (!at(x - 1, z)) quad([x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0], 0.82);
        if (!at(x, z + 1)) quad([x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1], 0.9);
        if (!at(x, z - 1)) quad([x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0], 0.9);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: true,       // a hill in front of a cloud must hide it
      fog: true,             // clouds DO catch fog so they fade with distance
    });
    this.cloudMat = mat;

    const span = N * CELL;
    for (let tz = -1; tz <= 1; tz++) {
      for (let tx = -1; tx <= 1; tx++) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(tx * span, 0, tz * span);
        mesh.frustumCulled = false;
        this.cloudGroup.add(mesh);
        this.clouds.push(mesh);
      }
    }
    this._cloudDrift = 0;
    this.group.add(this.cloudGroup);
  }

  _buildLights(scene) {
    // Hemisphere light gives soft ambient sky/ground bounce; the directional
    // "sun" provides the primary shading direction for the vertex-lit meshes.
    this.hemi = new THREE.HemisphereLight(0xa8c8ff, 0x4a4438, 0.9);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
    this.sun.position.set(0.5, 1, 0.3);
    scene.add(this.sun);
    // A target the directional light points at; we move sun.position relative.
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun.target);

    this.moon = new THREE.DirectionalLight(0x8090c0, 0.0);
    this.moon.position.set(-0.5, 1, -0.3);
    scene.add(this.moon);
    this.moon.target.position.set(0, 0, 0);
    scene.add(this.moon.target);
  }

  /* ----------------------------------------------------------------------
     update — advance the clock and refresh every visual + light.
     dt is already scaled by daylightSpeed upstream.
     ---------------------------------------------------------------------- */
  update(dt) {
    if (!this._initialized) return;
    if (!(dt > 0)) dt = 0;

    // Wall-clock accumulator, independent of the day cycle: drives the
    // foliage wind sway in the terrain shader.
    this._elapsed += dt;

    // Advance the day clock and wrap into [0,1).
    const prev = this.timeOfDay;
    this.timeOfDay += dt / DAY_LENGTH;
    if (this.timeOfDay >= 1) this.timeOfDay -= Math.floor(this.timeOfDay);
    if (this.timeOfDay < 0) this.timeOfDay -= Math.floor(this.timeOfDay);

    // Detect a new day: dawn (0.25) crossing while time advances. We test the
    // wrap of the *raw* progression so it fires once per cycle reliably.
    this._detectDayRollover(prev, this.timeOfDay);

    this._applyTime(dt);

    // Phase change → emit once.
    const phase = this._phaseFor(this.timeOfDay);
    if (phase !== this._phase) {
      this._phase = phase;
      this._emit('time:phase', { phase });
    }
    this._lastTime = this.timeOfDay;
  }

  // Fire 'time:day' when the clock passes the dawn marker (0.25) going forward.
  _detectDayRollover(prev, now) {
    const DAWN = 0.25;
    // Handle both the normal forward crossing and a midnight wrap-around.
    let crossed = false;
    if (now >= prev) {
      crossed = prev < DAWN && now >= DAWN;
    } else {
      // Wrapped past 1.0 → 0.0 this frame; crossed dawn if either segment did.
      crossed = (prev < DAWN) || (now >= DAWN);
    }
    if (crossed) {
      this._dayCount++;
      this._emit('time:day', { day: this._dayCount });
    }
  }

  /* ----------------------------------------------------------------------
     _applyTime — the per-frame recolor / reposition work.
     ---------------------------------------------------------------------- */
  _applyTime(dt) {
    const t = this.timeOfDay;
    this._samplePalette(t, SAMPLE);
    this._lightLevel = SAMPLE.light;

    // Keep the whole rig centered on the camera so it never clips.
    const cam = this._camera();
    if (cam && this.group) {
      this.group.position.copy(cam.position);
    }

    this._recolorDome(SAMPLE);
    this._orbitBodies(t, SAMPLE);
    this._updateLights(SAMPLE, t);
    this._updateFog(SAMPLE, dt);
    this._updateStars(t);
    this._updateClouds(dt, cam);
  }

  // Sample and blend the keyframe palette at time t into `out`.
  _samplePalette(t, out) {
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (t >= KEYS[i].t && t <= KEYS[i + 1].t) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    }
    const span = (b.t - a.t) || 1;
    const f = smoothstep(0, 1, clamp01((t - a.t) / span));
    mix3(out.top, a.top, b.top, f);
    mix3(out.horizon, a.horizon, b.horizon, f);
    mix3(out.sun, a.sun, b.sun, f);
    mix3(out.hemiSky, a.hemiSky, b.hemiSky, f);
    mix3(out.hemiGround, a.hemiGround, b.hemiGround, f);
    out.sunI = lerp(a.sunI, b.sunI, f);
    out.hemiI = lerp(a.hemiI, b.hemiI, f);
    out.light = lerp(a.light, b.light, f);

    // Overcast: rain pulls colour out of the sky, dims and cools the sun, and
    // takes a little off the light level. Driven by the weather system's eased
    // intensity, so a shower greys the world over seconds, not in one frame.
    const weather = this.game && this.game.weather;
    const wet = weather ? weather.intensity : 0;
    if (wet > 0.001) {
      const k = Math.min(1, wet) * 0.75;
      for (const c of [out.top, out.horizon]) {
        const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
        c[0] = lerp(c[0], l * 0.86, k);
        c[1] = lerp(c[1], l * 0.9, k);
        c[2] = lerp(c[2], l * 0.98, k);
      }
      const sunGrey = 0.62 * (0.3 * out.sun[0] + 0.59 * out.sun[1] + 0.11 * out.sun[2]);
      for (let i = 0; i < 3; i++) out.sun[i] = lerp(out.sun[i], sunGrey * (i === 2 ? 1.08 : 1), wet * 0.6);
      out.sunI *= 1 - 0.55 * wet;
      out.hemiI *= 1 - 0.15 * wet;
      out.light *= 1 - 0.2 * wet;
    }
    return out;
  }

  _recolorDome(p) {
    if (!this.dome || !this._domeColors) return;
    const colors = this._domeColors;
    const mix = this._domeMix;
    const top = p.top, hor = p.horizon;
    for (let i = 0, j = 0; i < mix.length; i++, j += 3) {
      const m = mix[i];
      colors[j] = lerp(hor[0], top[0], m);
      colors[j + 1] = lerp(hor[1], top[1], m);
      colors[j + 2] = lerp(hor[2], top[2], m);
    }
    this.dome.geometry.attributes.color.needsUpdate = true;
  }

  _orbitBodies(t, p) {
    // The sun sweeps a great circle: at t=0.25 it sits at the eastern horizon,
    // at t=0.5 directly overhead, at t=0.75 the western horizon, and below the
    // ground at night. The moon is exactly opposite (t + 0.5).
    const sunAngle = (t - 0.25) * TAU;     // 0 at sunrise → PI at sunset
    const sx = Math.cos(sunAngle);
    const sy = Math.sin(sunAngle);

    if (this.sunMesh) {
      this.sunMesh.position.set(sx * ORBIT_RADIUS, sy * ORBIT_RADIUS, 0);
      this._faceOrigin(this.sunMesh);
      // Fade the disc out smoothly as it dips below the horizon.
      const above = clamp01(smoothstep(-0.12, 0.06, sy));
      if (this.sunMat) this.sunMat.opacity = above;
      if (this.sunGlowMat) this.sunGlowMat.opacity = 0.28 * above;
      // Warm the sun tint near the horizon.
      if (this.sunMat) setColor(this.sunMat.color, p.sun);
    }

    if (this.moonMesh) {
      const ma = sunAngle + Math.PI;
      const mx = Math.cos(ma), my = Math.sin(ma);
      this.moonMesh.position.set(mx * ORBIT_RADIUS, my * ORBIT_RADIUS, 0);
      this._faceOrigin(this.moonMesh);
      const above = clamp01(smoothstep(-0.12, 0.06, my));
      if (this.moonMat) this.moonMat.opacity = above;
    }
  }

  // Orient a celestial disc so its face points back toward the rig origin,
  // which sits at the camera (the group follows the camera each frame). Using
  // the group's world position — not (0,0,0) — keeps the discs facing the
  // viewer everywhere, not just near the world origin.
  _faceOrigin(mesh) {
    if (this.group) mesh.lookAt(this.group.position);
    else mesh.lookAt(0, 0, 0);
  }

  _updateLights(p, t) {
    // Cache the colour terrain should be lit by. The voxel shader multiplies
    // baked skylight by this, so it carries the whole warm-dusk / cold-night
    // mood without any per-chunk work. Sunlight fades toward a dim blue at
    // night rather than to black, so moonlit ground still reads as ground.
    const day = clamp01(p.light);
    const moonlit = [0.30, 0.38, 0.62];
    this._terrainTint[0] = lerp(moonlit[0], p.sun[0], day);
    this._terrainTint[1] = lerp(moonlit[1], p.sun[1], day);
    this._terrainTint[2] = lerp(moonlit[2], p.sun[2], day);
    // Keep a floor under daylight so night is dim, not pitch black outdoors.
    this._terrainDaylight = 0.16 + 0.84 * day;

    // Linear-light terms for the shader. The palette is authored as display
    // colours, so linearise each channel; the shader lights in linear space
    // and tone-maps afterwards, which is what keeps dark albedos (leaves,
    // water) from collapsing to black under multiplied-down display values.
    // Night is not allowed to fall to zero: a cold blue floor stands in for
    // moon- and starlight so the ground stays readable.
    const night = clamp01(smoothstep(0.40, 0.04, day));
    for (let i = 0; i < 3; i++) {
      this._ambSky[i] = lin(p.hemiSky[i]) * p.hemiI * 0.80 + NIGHT_AMBIENT_SKY[i] * night;
      this._ambGround[i] = lin(p.hemiGround[i]) * p.hemiI * 0.85 + NIGHT_AMBIENT_GROUND[i] * night;
      this._sunOnly[i] = lin(p.sun[i]) * p.sunI * 1.2;
      this._sunLight[i] = this._sunOnly[i] + NIGHT_MOONLIGHT[i] * night;
      this._horizonLin[i] = lin(p.horizon[i]);
      this._zenithLin[i] = lin(p.top[i]);
    }

    // The THREE lights only light what the terrain shader does not: mobs,
    // dropped items and other entities. Feed them the same linear terms the
    // terrain shader uses, so a pig standing on grass is lit like the grass.
    // Three's Lambert divides by pi, hence the PI in the intensities; ENTITY_GAIN
    // stands in for the terrain shader's tone mapping, which the built-in
    // materials do not get.
    if (this.hemi) {
      this.hemi.color.setRGB(this._ambSky[0], this._ambSky[1], this._ambSky[2]);
      this.hemi.groundColor.setRGB(this._ambGround[0], this._ambGround[1], this._ambGround[2]);
      this.hemi.intensity = Math.PI * ENTITY_GAIN * this._brightness();
    }
    if (this.sun) {
      // Match the directional light direction to the visible sun position.
      const sunAngle = (t - 0.25) * TAU;
      const sx = Math.cos(sunAngle);
      const sy = Math.sin(sunAngle);
      // Direction is from the sun toward the scene origin; place the light on
      // the sun side. A little forward z offset keeps shading from being flat.
      this.sun.position.set(sx, Math.max(sy, -0.2), 0.35).multiplyScalar(100);
      // Direct sun only (the night floor lives in the moon light below), and
      // fading out as it sets so it cannot light from below the horizon.
      const up = clamp01(smoothstep(-0.05, 0.12, sy));
      this.sun.color.setRGB(this._sunOnly[0], this._sunOnly[1], this._sunOnly[2]);
      this.sun.intensity = Math.PI * ENTITY_GAIN * this._brightness() * up;
    }
    if (this.moon) {
      const moonAngle = (t - 0.25) * TAU + Math.PI;
      const mx = Math.cos(moonAngle);
      const my = Math.sin(moonAngle);
      this.moon.position.set(mx, Math.max(my, -0.2), -0.35).multiplyScalar(100);
      this.moon.color.setRGB(NIGHT_MOONLIGHT[0] * 6, NIGHT_MOONLIGHT[1] * 6, NIGHT_MOONLIGHT[2] * 6);
      this.moon.intensity = Math.PI * ENTITY_GAIN * this._brightness() * night * clamp01(smoothstep(-0.05, 0.12, my));
    }
  }

  _updateFog(p, dt) {
    const engine = this._engine();
    const scene = this._scene();
    // Drive fog + background to the horizon color so the world blends into the
    // sky at distance. Build a hex-less THREE.Color via its rgb setter.
    if (engine && typeof engine.setFogColor === 'function') {
      // Submerged: the world closes in to a few blocks of blue-green murk. Eased
      // in and out so crossing the surface is a quick fade, not a pop.
      const player = this.game && this.game.player;
      const under = player && player.eyesUnderWater ? 1 : 0;
      this._underwater += (under - this._underwater) * Math.min(1, (dt > 0 ? dt : 0.016) * 9);
      if (this._underwater < 0.002) this._underwater = 0;
      const uw = this._underwater;
      const lum = 0.22 + 0.78 * clamp01(p.light);
      _tmpColor.setRGB(
        lerp(p.horizon[0], 0.06 * lum + 0.01, uw),
        lerp(p.horizon[1], 0.30 * lum + 0.02, uw),
        lerp(p.horizon[2], 0.46 * lum + 0.04, uw),
      );
      engine.setFogColor(_tmpColor);
      // Widen view by day, tighten a little at night for mood + performance.
      if (typeof engine.setFogRange === 'function') {
        // Fog must END where the world does. Chunks only stream in out to the
        // render distance, so a fog range reaching past it shows the raw edge
        // of the loaded terrain (a hard cliff against the sky). Tie the range
        // to the setting: fully fogged just inside the last loaded chunk.
        const st = this.game && this.game.state;
        const rd = st && typeof st.renderDistance === 'number' ? Math.max(2, Math.min(12, st.renderDistance)) : 6;
        const reach = rd * CHUNK_SX * 0.94;
        let far = reach * lerp(0.82, 1.0, p.light);     // a little closer at night, for mood
        let near = far * lerp(0.34, 0.42, p.light);
        // Rain closes the horizon in. Driven by the eased weather intensity,
        // so a shower rolls the fog in over seconds rather than snapping it.
        const weather = this.game && this.game.weather;
        const wet = weather ? weather.intensity : 0;
        near *= 1 - 0.35 * wet;
        far *= 1 - 0.45 * wet;
        // Underwater visibility: about 30 blocks in daylight, less in the dark.
        near = lerp(near, 0.4, uw);
        far = lerp(far, 10 + 24 * clamp01(p.light), uw);
        engine.setFogRange(near, far);
      }
    } else if (scene) {
      // Fallback if engine helpers are unavailable.
      if (scene.fog && scene.fog.color) scene.fog.color.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
      if (scene.background && scene.background.setRGB) scene.background.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
    }
  }

  _updateStars(t) {
    if (!this.starMat) return;
    // Stars fade in around dusk and out around dawn. Use the abstract light
    // level: bright day → invisible, dark night → ~0.9 opacity with a twinkle.
    const night = clamp01(smoothstep(0.30, 0.06, this._lightLevel));
    // Gentle global twinkle so the field feels alive.
    const twinkle = 0.85 + 0.15 * Math.sin(t * TAU * 40);
    this.starMat.opacity = night * 0.9 * twinkle;
    if (this.stars) this.stars.visible = this.starMat.opacity > 0.01;
  }

  _updateClouds(dt, cam) {
    if (!this.clouds.length || !this.cloudGroup) return;
    // The sky rig is glued to the camera, so to make the layer sit in the
    // world (and give real parallax as you walk) its position is the world
    // offset of the pattern MINUS the camera position, wrapped onto the tile
    // that currently contains the player. The 3x3 tiling hides the wrap.
    const span = CLOUD_GRID * CLOUD_CELL;
    this._cloudDrift = ((this._cloudDrift || 0) + CLOUD_DRIFT * dt) % span;
    const cx = cam ? cam.position.x : 0, cy = cam ? cam.position.y : 0, cz = cam ? cam.position.z : 0;
    const wrap = (v) => v - Math.floor(v / span + 0.5) * span;     // into [-span/2, span/2)
    this.cloudGroup.position.set(
      wrap(this._cloudDrift - cx) - span / 2,
      CLOUD_HEIGHT - cy,
      wrap(-cz) - span / 2
    );
    // Brighter and warmer by day (and rose-gold at dusk), dim and cold by night.
    if (this.cloudMat) {
      const lvl = this._lightLevel;
      const k = lerp(0.16, 1.0, clamp01(lvl * 1.15));
      const warm = SAMPLE.sun;
      this.cloudMat.color.setRGB(k * lerp(0.80, warm[0], 0.65), k * lerp(0.84, warm[1], 0.65), k * lerp(0.95, warm[2], 0.65));
      const wet = this.game && this.game.weather ? this.game.weather.intensity : 0;
      this.cloudMat.color.multiplyScalar(1 - 0.38 * wet);          // heavy, grey cloud
      this.cloudMat.opacity = lerp(lerp(0.35, 0.86, clamp01(lvl * 1.5)), 0.97, wet);
      this.cloudMat.visible = true;
    }
  }

  /* ----------------------------------------------------------------------
     Public query API.
     ---------------------------------------------------------------------- */

  setTime(t) {
    if (typeof t !== 'number' || !isFinite(t)) return;
    t = t - Math.floor(t);          // wrap into [0,1)
    this.timeOfDay = t;
    this._lastTime = t;
    this._phase = this._phaseFor(t);
    if (this._initialized) this._applyTime(0);
  }

  getPhase() { return this._phaseFor(this.timeOfDay); }

  getLightLevel() { return clamp01(this._lightLevel); }

  /* The state the voxel terrain shader needs each frame: how strong daylight
     currently is, and what colour it is. Terrain lighting is baked per-vertex
     (see world/lighting.js) and combined with these at draw time, so a sunset
     recolours the entire world without re-meshing a single chunk. */
  getTerrainLight() {
    const s = this._sunDirScratch || (this._sunDirScratch = new THREE.Vector3(0, 1, 0));
    this.getSunDirection(s);
    // Below the horizon the light source is the moon, which sits opposite the
    // sun — flip rather than letting terrain shade toward a sun that is
    // underground.
    if (s.y < 0) s.multiplyScalar(-1);
    // The visible sun crosses the sky in the x/y plane, which would leave
    // north- and south-facing walls permanently out of direct light. Tilt the
    // LIGHT (not the disc) a little toward +z so every wall catches the sun at
    // some point in the day.
    s.z += 0.32;
    s.normalize();
    return {
      daylight: this._terrainDaylight,
      skyTint: this._terrainTint,
      time: this._elapsed || 0,
      sunDir: s,
      ambSky: this._ambSky,
      ambGround: this._ambGround,
      sunLight: this._sunLight,
      horizon: this._horizonLin,
      zenith: this._zenithLin,
      exposure: BASE_EXPOSURE * this._brightness(),
    };
  }

  // Returns a unit Vector3 pointing from the world toward the sun (for shaders
  // or gameplay that wants the sun direction). Safe before init.
  getSunDirection(out) {
    const v = out || new THREE.Vector3();
    const a = (this.timeOfDay - 0.25) * TAU;
    return v.set(Math.cos(a), Math.sin(a), 0).normalize();
  }

  /* ---- serialization --------------------------------------------------- */

  serialize() {
    return { timeOfDay: this.timeOfDay, day: this._dayCount };
  }

  load(obj) {
    if (!obj) return;
    if (typeof obj.timeOfDay === 'number' && isFinite(obj.timeOfDay)) {
      this.setTime(obj.timeOfDay);
    }
    if (typeof obj.day === 'number') this._dayCount = obj.day | 0;
  }

  /* ---- teardown -------------------------------------------------------- */

  dispose() {
    const scene = this._scene();
    const drop = (obj) => {
      if (!obj) return;
      if (obj.parent) obj.parent.remove(obj);
      obj.traverse && obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    };
    drop(this.group);
    if (scene) {
      if (this.hemi) scene.remove(this.hemi);
      if (this.sun) { scene.remove(this.sun); scene.remove(this.sun.target); }
      if (this.moon) { scene.remove(this.moon); scene.remove(this.moon.target); }
    }
    this.group = null;
    this.clouds = [];
    this._initialized = false;
  }

  /* ---- internal helpers ------------------------------------------------ */

  _phaseFor(t) {
    // dawn 0.20..0.32, day 0.32..0.68, dusk 0.68..0.80, night otherwise.
    if (t >= 0.20 && t < 0.32) return 'dawn';
    if (t >= 0.32 && t < 0.68) return 'day';
    if (t >= 0.68 && t < 0.80) return 'dusk';
    return 'night';
  }

  // The player's brightness setting (1 = as designed).
  _brightness() {
    const s = this.game && this.game.state && this.game.state.settings;
    const b = s && typeof s.brightness === 'number' ? s.brightness : 1;
    return b > 0.3 && b < 3 ? b : 1;
  }

  _fancy() {
    const s = this.game && this.game.state && this.game.state.settings;
    return s ? !!s.fancyGraphics : false;
  }

  _engine() { return this.game && this.game.engine ? this.game.engine : null; }
  _scene() {
    const g = this.game;
    if (!g) return null;
    return g.scene || (g.engine && g.engine.scene) || null;
  }
  _camera() {
    const g = this.game;
    if (!g) return null;
    return g.camera || (g.engine && g.engine.camera) || null;
  }

  _emit(name, payload) {
    const ev = this.game && this.game.events;
    if (ev && typeof ev.emit === 'function') {
      try { ev.emit(name, payload); } catch (_) { /* never throw from update */ }
    }
  }
}

/* ---- module-local utilities (no allocation in the hot path) ------------ */

const _tmpColor = new THREE.Color();

// Lerp two [r,g,b] arrays into a preallocated `out`.
function mix3(out, a, b, f) {
  out[0] = lerp(a[0], b[0], f);
  out[1] = lerp(a[1], b[1], f);
  out[2] = lerp(a[2], b[2], f);
  return out;
}

// Set a THREE.Color from an [r,g,b] 0..1 array.
function setColor(color, rgb) {
  color.setRGB(rgb[0], rgb[1], rgb[2]);
}

export default Sky;
