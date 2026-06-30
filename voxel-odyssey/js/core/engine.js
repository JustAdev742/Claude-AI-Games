/* =========================================================================
   engine.js — wraps the Three.js renderer, scene, camera and the main loop.

   The engine owns nothing game-specific; it just renders whatever is added to
   `scene` from the camera, and drives a fixed-ish update loop. Game systems
   register their per-frame work through the callback passed to start().
   ========================================================================= */

import * as THREE from 'three';

export class Engine {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings || {};

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !!this.settings.fancyGraphics,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.sortObjects = true;
    this.renderer.shadowMap.enabled = false; // voxel AO baked into vertex colors

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fc7ff);
    this.fog = new THREE.Fog(0x8fc7ff, 40, 220);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov || 75,
      window.innerWidth / window.innerHeight,
      0.05,
      1000
    );
    this.camera.position.set(0, 50, 0);

    // A separate group for things rendered in front of the world (held item).
    this.viewmodelScene = new THREE.Scene();
    this.viewmodelCamera = this.camera;

    this.clock = { last: 0, elapsed: 0 };
    this.frame = 0;
    this.fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._running = false;
    this._updateFn = null;
    this._raf = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }

  setFov(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setFogColor(color) {
    // color: THREE.Color or hex
    this.fog.color.set(color);
    if (this.scene.background && this.scene.background.set) this.scene.background.set(color);
  }
  setFogRange(near, far) { this.fog.near = near; this.fog.far = far; }

  start(updateFn) {
    this._updateFn = updateFn;
    this._running = true;
    const loop = (tMs) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      if (!this.clock.last) this.clock.last = tMs;
      let dt = (tMs - this.clock.last) / 1000;
      this.clock.last = tMs;
      // Clamp dt so tab-switches / hitches don't explode physics.
      if (dt > 0.1) dt = 0.1;
      if (dt < 0) dt = 0;
      this.clock.elapsed += dt;
      this.frame++;

      // FPS smoothing
      this._fpsAccum += dt;
      this._fpsFrames++;
      if (this._fpsAccum >= 0.5) {
        this.fps = this._fpsFrames / this._fpsAccum;
        this._fpsAccum = 0;
        this._fpsFrames = 0;
      }

      if (this._updateFn) this._updateFn(dt, this.clock.elapsed, tMs);

      this.renderer.render(this.scene, this.camera);
      // Held-item viewmodel drawn on top, depth cleared.
      if (this.viewmodelScene.children.length) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
        this.renderer.autoClear = true;
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}

export default Engine;
