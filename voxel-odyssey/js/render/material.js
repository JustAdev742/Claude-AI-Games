/* =========================================================================
   material.js — the voxel terrain shader.

   Replaces MeshLambertMaterial + DirectionalLight. A real directional light
   can't express voxel occlusion (see lighting.js), so terrain is lit entirely
   from the baked per-vertex light the flood-fill produced.

   THE KEY DESIGN DECISION
   -----------------------
   Skylight and blocklight arrive as a *vertex attribute* (aLight), while the
   time of day is a *uniform* (uDaylight). The combination happens in the
   fragment shader. That split is what makes a smooth day/night cycle
   affordable: sunset dims every chunk in the world by changing one float,
   with zero re-meshing. Baking the final colour into vertex colours instead —
   the obvious approach — would mean re-meshing every visible chunk every time
   the sun moved a few degrees.

   Two channels are kept separate all the way to the fragment shader because
   they behave differently: skylight is tinted by the sky and scaled by the
   sun, blocklight is a fixed warm glow that survives midnight. Collapsing
   them to one value would make torches go out at night.

   Also supports an optional texture atlas (see atlas.js). Until one is bound
   the shader falls back to flat vertex colour, so the renderer works
   identically with or without a resource pack loaded.
   ========================================================================= */

import * as THREE from 'three';

/* Minecraft's light curve is not linear — each level down is roughly 80% of
   the one above, which is what gives torch-lit caves their steep, cosy
   falloff instead of a flat grey ramp. We approximate it in closed form and
   lift the floor slightly so "pitch dark" is still barely readable rather
   than a pure black screen. */
export const LIGHT_CURVE_GLSL = /* glsl */`
  float lightCurve(float level) {
    // level is 0..1 (i.e. voxel light 0..15 normalised)
    float l = clamp(level, 0.0, 1.0);
    return pow(l, 1.45);
  }
`;

const VERT = /* glsl */`
  attribute vec3 aColor;
  attribute vec2 aLight;   // x = skylight 0..1, y = blocklight 0..1
  attribute float aAO;     // 0..1 ambient-occlusion multiplier
  attribute float aTexIdx; // atlas tile index (-1 = untextured)

  varying vec3 vColor;
  varying vec2 vLight;
  varying float vAO;
  varying vec2 vUv;
  varying float vTexIdx;
  varying vec3 vWorldPos;

  uniform float uTime;
  uniform float uWaveStrength;  // >0 makes foliage/liquids sway

  #include <fog_pars_vertex>

  void main() {
    vColor = aColor;
    vLight = aLight;
    vAO = aAO;
    vUv = uv;
    vTexIdx = aTexIdx;

    vec3 pos = position;

    // Gentle wind sway. Driven per-vertex from world position so neighbouring
    // plants move out of phase instead of the whole field pulsing together.
    if (uWaveStrength > 0.0) {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      float phase = wp.x * 0.6 + wp.z * 0.45;
      // Only the upper vertices of a quad sway, so plants stay rooted.
      float anchor = fract(position.y) > 0.01 ? 1.0 : 0.0;
      pos.x += sin(uTime * 1.6 + phase) * 0.045 * uWaveStrength * anchor;
      pos.z += cos(uTime * 1.3 + phase * 1.1) * 0.035 * uWaveStrength * anchor;
    }

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  varying vec3 vColor;
  varying vec2 vLight;
  varying float vAO;
  varying vec2 vUv;
  varying float vTexIdx;
  varying vec3 vWorldPos;

  uniform sampler2D uAtlas;
  uniform float uHasAtlas;
  uniform vec3 uSkyTint;      // colour sunlight contributes (warm at dusk)
  uniform vec3 uBlockTint;    // colour torches contribute (fixed warm orange)
  uniform float uDaylight;    // 0 = midnight, 1 = noon
  uniform float uAmbient;     // floor so caves are dark but not unreadable
  uniform float uOpacity;
  uniform float uAlphaTest;

  ${LIGHT_CURVE_GLSL}

  #include <fog_pars_fragment>

  void main() {
    vec4 base = vec4(vColor, 1.0);

    if (uHasAtlas > 0.5 && vTexIdx >= 0.0) {
      vec4 tex = texture2D(uAtlas, vUv);
      if (tex.a < uAlphaTest) discard;
      // Tint the texture by the vertex colour. Grey-ish textures come through
      // as-is; grass/foliage carry a biome tint in vColor.
      base = vec4(tex.rgb * vColor, tex.a);
    }

    // --- combine the two light channels -----------------------------------
    float sky = lightCurve(vLight.x) * uDaylight;
    float blk = lightCurve(vLight.y);

    vec3 skyContrib = uSkyTint * sky;
    vec3 blkContrib = uBlockTint * blk;

    // Take the stronger channel and add a fraction of the weaker one. A plain
    // sum would blow out to white where a torch sits in daylight; a plain max
    // would make torches invisible outdoors. This keeps both readable.
    vec3 light = max(skyContrib, blkContrib) + min(skyContrib, blkContrib) * 0.32;
    light = max(light, vec3(uAmbient));

    vec3 rgb = base.rgb * light * vAO;

    gl_FragColor = vec4(rgb, base.a * uOpacity);

    #include <fog_fragment>
  }
`;

/* Shared uniform block. Every terrain material references the SAME uniform
   objects, so updating the day/night state once updates opaque, water and
   foliage passes together — no chance of them drifting out of sync. */
export function createSharedUniforms() {
  return {
    uAtlas: { value: null },
    uHasAtlas: { value: 0 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
    uBlockTint: { value: new THREE.Color(1.0, 0.78, 0.52) },
    uDaylight: { value: 1 },
    uAmbient: { value: 0.035 },
    uTime: { value: 0 },
  };
}

/**
 * Build the three terrain materials (opaque / liquid / foliage) around one
 * shared uniform block.
 *
 * @param {object} shared  from createSharedUniforms()
 */
export function createVoxelMaterials(shared) {
  const mk = (extra, uniformOverrides) => {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uOpacity: { value: 1 },
        uAlphaTest: { value: 0.5 },
        uWaveStrength: { value: 0 },
      },
    ]);
    // Point the merged block at the SHARED uniform objects (merge deep-clones,
    // which would otherwise give every material its own private copy and break
    // the single-update-drives-everything property above).
    Object.assign(uniforms, shared);
    Object.assign(uniforms, uniformOverrides || {});

    const m = new THREE.ShaderMaterial(Object.assign({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
    }, extra));
    return m;
  };

  const opaque = mk({ name: 'voxel-opaque' });

  const water = mk({
    name: 'voxel-water',
    transparent: true,
    depthWrite: false,          // don't occlude other transparent surfaces
    side: THREE.FrontSide,
  }, {
    uOpacity: { value: 0.78 },
    uWaveStrength: { value: 0.35 },
  });

  // Foliage: alpha-tested rather than blended, so cross-quads sort correctly
  // against each other at any angle without a per-frame depth sort.
  const foliage = mk({
    name: 'voxel-foliage',
    side: THREE.DoubleSide,
    transparent: false,
    alphaTest: 0.5,
  }, {
    uWaveStrength: { value: 1.0 },
  });

  return { opaque, water, foliage };
}

/**
 * Drive the shared uniforms from the current sky state. Called once per frame.
 *
 * @param {object} shared    the shared uniform block
 * @param {object} skyState  { daylight, skyTint:[r,g,b], time }
 */
export function updateVoxelUniforms(shared, skyState) {
  if (!shared) return;
  const d = Math.max(0, Math.min(1, skyState.daylight));
  shared.uDaylight.value = d;
  if (skyState.skyTint) {
    shared.uSkyTint.value.setRGB(skyState.skyTint[0], skyState.skyTint[1], skyState.skyTint[2]);
  }
  if (typeof skyState.time === 'number') shared.uTime.value = skyState.time;
  // Night keeps a faint blue ambient so open ground under moonlight still
  // reads as ground, while enclosed caves (skylight 0) stay genuinely dark.
  shared.uAmbient.value = 0.028 + 0.012 * d;
}

export default createVoxelMaterials;
