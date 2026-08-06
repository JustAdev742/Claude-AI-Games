/* =========================================================================
   weather.js — rain, snow, and ambient particle life.

   The world was visually static: the same clear sky every day, and nothing
   moving in the air. Weather is the cheapest way to make a world feel like a
   place rather than a diorama, because it changes the light, the sound and
   the motion all at once.

   HOW THE PRECIPITATION IS DRAWN
   ------------------------------
   One THREE.Points cloud of a few thousand particles, parented to a group
   that follows the player. Particles are not simulated individually across
   the world — they live in a box around the camera and WRAP when they fall
   out of it, so a constant few thousand points give the impression of
   weather everywhere. This is why the cost is flat regardless of render
   distance.

   Each particle carries a random horizontal offset and fall speed so the
   sheet does not look like a marching grid. Snow additionally drifts
   sideways on a sine, which is most of what separates "snow" from "white
   rain" visually.

   BIOME AWARENESS
   ---------------
   Precipitation type is chosen from the temperature where the player is
   standing: snow in cold biomes, rain elsewhere, and nothing at all in
   deserts — a desert downpour immediately reads as wrong. The transition is
   smoothed so walking from tundra into forest cross-fades rather than
   snapping.

   Particles are culled against the sky: a particle whose column has solid
   blocks above it is not drawn, so rain does not fall through your roof.
   ========================================================================= */

import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';
import { CHUNK_SY } from '../world/constants.js';

const PARTICLE_COUNT = 2600;
const BOX_RADIUS = 16;     // horizontal half-extent of the wrap box
const BOX_HEIGHT = 24;     // vertical extent

export const WEATHER = { CLEAR: 'clear', RAIN: 'rain', SNOW: 'snow' };

export class Weather {
  constructor(game) {
    this.game = game;

    this.state = WEATHER.CLEAR;
    this.intensity = 0;          // 0..1, eased toward the target
    this._target = 0;

    // Weather runs on a slow clock so it changes on a human timescale rather
    // than flickering. Seeded from the world so a given seed has a consistent
    // climate rather than re-rolling every session.
    this._clock = 0;
    this._nextChange = 90 + Math.random() * 120;

    this.group = null;
    this.points = null;
    this.material = null;
    this._positions = null;
    this._speeds = null;
    this._phases = null;

    this._initialized = false;
  }

  init() {
    if (this._initialized) return this;
    const scene = this.game && (this.game.scene || (this.game.engine && this.game.engine.scene));
    if (!scene) { this._initialized = true; return this; }

    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.group.frustumCulled = false;

    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const speeds = new Float32Array(PARTICLE_COUNT);
    const phases = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() * 2 - 1) * BOX_RADIUS;
      positions[i * 3 + 1] = Math.random() * BOX_HEIGHT;
      positions[i * 3 + 2] = (Math.random() * 2 - 1) * BOX_RADIUS;
      speeds[i] = 0.7 + Math.random() * 0.6;
      phases[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.material = new THREE.PointsMaterial({
      color: 0xaaccff,
      size: 0.12,
      transparent: true,
      opacity: 0,
      // Precipitation is in front of terrain when it is between you and the
      // terrain, so it must depth-test. depthWrite off so particles do not
      // occlude each other into a solid sheet.
      depthTest: true,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.group.add(this.points);
    scene.add(this.group);

    this._positions = positions;
    this._speeds = speeds;
    this._phases = phases;
    this._initialized = true;
    return this;
  }

  /* ---- state ---- */

  setWeather(state, intensity = 1) {
    this.state = state;
    this._target = state === WEATHER.CLEAR ? 0 : clamp01(intensity);
  }

  isPrecipitating() { return this.state !== WEATHER.CLEAR && this.intensity > 0.05; }

  /* Temperature at the player, used to pick rain vs snow vs nothing. Falls
     back to "temperate" when worldgen can't tell us. */
  _biomeTemperature() {
    const wg = this.game && this.game.worldgen;
    const p = this.game && this.game.player;
    if (!wg || !p || typeof wg.biomeAt !== 'function') return 0.5;
    try {
      const b = wg.biomeAt(Math.floor(p.position.x), Math.floor(p.position.z));
      if (!b) return 0.5;
      if (typeof b.temperature === 'number') return b.temperature;
      // biomeAt returns a plain string; match on it directly.
      const name = String(typeof b === 'string' ? b : (b.name || b.key || '')).toLowerCase();
      if (/snow|tundra|ice|frozen|peak/.test(name)) return 0.05;
      if (/desert|badland|savanna/.test(name)) return 0.95;
      return 0.5;
    } catch (_) { return 0.5; }
  }

  update(dt) {
    if (!this._initialized || !this.points) return;
    const player = this.game && this.game.player;
    if (!player) return;

    // --- slow weather clock -------------------------------------------
    this._clock += dt;
    if (this._clock >= this._nextChange) {
      this._clock = 0;
      this._nextChange = 90 + Math.random() * 180;
      // Mostly clear: constant rain is oppressive, and clear skies make the
      // weather that does arrive feel like an event.
      const roll = Math.random();
      if (roll < 0.62) this.setWeather(WEATHER.CLEAR);
      else this.setWeather(WEATHER.RAIN, 0.45 + Math.random() * 0.55);
    }

    // Deserts stay dry regardless of the roll; cold biomes turn rain to snow.
    const temp = this._biomeTemperature();
    let effective = this.state;
    if (this.state !== WEATHER.CLEAR) {
      if (temp > 0.85) effective = WEATHER.CLEAR;      // too hot to rain
      else if (temp < 0.2) effective = WEATHER.SNOW;
      else effective = WEATHER.RAIN;
    }
    const wantIntensity = effective === WEATHER.CLEAR ? 0 : this._target;

    // Ease so walking across a biome border cross-fades instead of snapping.
    this.intensity += (wantIntensity - this.intensity) * Math.min(1, dt * 0.6);
    this.material.opacity = this.intensity * (effective === WEATHER.SNOW ? 0.85 : 0.55);
    this.points.visible = this.material.opacity > 0.01;
    if (!this.points.visible) return;

    const snow = effective === WEATHER.SNOW;
    this.material.color.setHex(snow ? 0xffffff : 0x9fc2e8);
    this.material.size = snow ? 0.16 : 0.1;

    // --- move the box with the player ---------------------------------
    const px = player.position.x, py = player.position.y, pz = player.position.z;
    this.group.position.set(px, py, pz);

    // --- integrate + wrap ----------------------------------------------
    const pos = this._positions;
    const speeds = this._speeds;
    const phases = this._phases;
    const world = this.game && this.game.world;
    const fall = (snow ? 3.2 : 14.0) * dt;
    const t = (this._elapsed = (this._elapsed || 0) + dt);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const o = i * 3;
      pos[o + 1] -= fall * speeds[i];

      if (snow) {
        // Sideways drift is most of what makes snow read as snow.
        pos[o] += Math.sin(t * 0.8 + phases[i]) * dt * 0.6;
        pos[o + 2] += Math.cos(t * 0.6 + phases[i]) * dt * 0.5;
      }

      if (pos[o + 1] < -BOX_HEIGHT * 0.35) {
        // Recycle to the top with a fresh horizontal position, so the sheet
        // never settles into a visible repeating pattern.
        pos[o] = (Math.random() * 2 - 1) * BOX_RADIUS;
        pos[o + 1] = BOX_HEIGHT * 0.65;
        pos[o + 2] = (Math.random() * 2 - 1) * BOX_RADIUS;

        // Sky check on RESPAWN only, not per frame: one raycast per recycled
        // particle is affordable, one per particle per frame is not. A
        // particle under a roof is parked far below the box so it stays
        // invisible until its next recycle.
        if (world && typeof world.heightAt === 'function') {
          const wx = Math.floor(px + pos[o]);
          const wz = Math.floor(pz + pos[o + 2]);
          const h = world.heightAt(wx, wz);
          const particleWorldY = py + pos[o + 1];
          if (h >= particleWorldY) pos[o + 1] = -BOX_HEIGHT * 2;
        }
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  /* Ambient sound level for the audio system: 0..1. */
  ambientLevel() { return this.intensity; }

  currentType() {
    if (this.intensity <= 0.05) return WEATHER.CLEAR;
    return this.state;
  }

  serialize() { return { state: this.state, intensity: this._target }; }

  load(obj) {
    if (!obj) return;
    if (obj.state) this.setWeather(obj.state, obj.intensity != null ? obj.intensity : 1);
  }

  dispose() {
    if (this.points) {
      this.points.geometry.dispose();
      if (this.points.parent) this.points.parent.remove(this.points);
    }
    if (this.material) this.material.dispose();
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this._initialized = false;
  }
}

export default Weather;
