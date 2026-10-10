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

   LIGHTING IS DONE IN LINEAR SPACE
   --------------------------------
   Texture and vertex colours are display (sRGB-ish) values. Multiplying those
   directly by light levels compounds the darkening — a mid-green leaf texture
   (0.25) times a morning light (0.5) times a side-face shade (0.8) lands near
   0.1, i.e. black. So the fragment shader converts albedo to linear light,
   adds hemisphere ambient + a directional sun/moon + torch light there, then
   tone-maps and re-encodes for display. The sky supplies the ambient and sun
   colours as ready-made linear uniforms (see Sky.getTerrainLight).

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
  varying vec3 vNormal;

  uniform float uTime;
  uniform float uWaveStrength;  // >0 makes foliage/liquids sway
  uniform float uViewmodel;     // 1 = held item: light it from a fixed direction

  #include <fog_pars_vertex>

  void main() {
    vColor = aColor;
    vLight = aLight;
    vAO = aAO;
    vUv = uv;
    vTexIdx = aTexIdx;
    // World-space normal for the sun term. mat3(modelMatrix) rather than
    // normalMatrix because normalMatrix goes to VIEW space, and the sun
    // direction uniform is a world-space vector. Chunk meshes only translate
    // (mat3 = identity); the held-item viewmodel actually rotates.
    // The held item is rotated with the camera every frame, so a world-space
    // normal would make its shading swim as you look around; its object-space
    // normal is stable and is lit by a fixed light instead.
    vNormal = uViewmodel > 0.5 ? normal : mat3(modelMatrix) * normal;

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

  // Under GLSL3 Three aliases attribute/varying/texture2D for us but
  // deliberately does NOT alias gl_FragColor — an ES3 shader is expected to
  // declare its own output. We declare it and restore the alias, because the
  // stock <fog_fragment> chunk included below still writes to gl_FragColor.
  layout(location = 0) out highp vec4 pc_fragColor;
  #define gl_FragColor pc_fragColor

  varying vec3 vColor;
  varying vec2 vLight;
  varying float vAO;
  varying vec2 vUv;
  varying float vTexIdx;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  // A texture ARRAY, not an atlas image: each block texture owns a layer, so
  // mip filtering can never blend one block's texels into another's. vTexIdx
  // selects the layer. See render/atlas.js.
  uniform sampler2DArray uAtlas;
  uniform float uHasAtlas;
  uniform vec3 uBlockTint;    // colour torches contribute (fixed warm orange)
  uniform vec3 uSunDir;       // world-space direction toward the sun/moon
  uniform vec3 uAmbSky;       // linear ambient light from straight above
  uniform vec3 uAmbGround;    // linear ambient light bounced up from below
  uniform vec3 uSunLight;     // linear colour * strength of direct sun/moon
  uniform vec3 uHorizon;      // linear sky colour at the horizon
  uniform vec3 uZenith;       // linear sky colour overhead
  uniform float uExposure;
  uniform float uAmbient;     // linear floor so caves are dark but not unreadable
  uniform float uTime;
  uniform float uOpacity;
  uniform float uAlphaTest;
  uniform float uIsWater;     // 1 = shade as a reflective water surface
  uniform float uViewmodel;   // 1 = held item: fixed light direction

  ${LIGHT_CURVE_GLSL}

  #include <fog_pars_fragment>

  vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

  // Extended Reinhard: keeps shadows and mid-tones where they are (no filmic
  // toe to crush the dark end) and rolls highlights off smoothly instead of
  // clipping, so snow and sunlit sand stay readable at noon.
  vec3 toneMap(vec3 c) {
    const float W2 = 6.0;   // white point squared
    return c * (1.0 + c / W2) / (1.0 + c);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Slope (d height / dx, d height / dz) of the water surface: three layers of
  // travelling ripples at different scales and speeds, so the surface never
  // shows an obvious repeat or a single direction of travel.
  vec2 waterSlope(vec2 p, float t) {
    vec2 g = vec2(0.0);
    g += vec2(cos(p.x * 1.30 + p.y * 0.70 + t * 1.10), cos(p.y * 1.10 + p.x * 0.50 - t * 0.90)) * 0.085;
    g += vec2(cos(p.x * 3.10 - t * 1.90), cos(p.y * 2.70 + p.x * 1.30 + t * 1.60)) * 0.045;
    g += vec2(cos(p.x * 7.30 + p.y * 3.10 + t * 2.70), cos(p.y * 6.10 - p.x * 2.90 - t * 2.30)) * 0.020;
    return g;
  }

  void main() {
    vec4 base = vec4(vColor, 1.0);

    if (uHasAtlas > 0.5 && vTexIdx >= 0.0) {
      vec4 tex = texture(uAtlas, vec3(vUv, vTexIdx));
      if (tex.a < uAlphaTest) discard;
      // Tint the texture by the vertex colour. Grey-ish textures come through
      // as-is; grass/foliage carry a biome tint in vColor.
      base = vec4(tex.rgb * vColor, tex.a);
    }

    vec3 albedo = toLinear(base.rgb);

    // Baked light: how much sky / torch reaches this face (0..1).
    float skyVis = lightCurve(vLight.x);
    float blkVis = lightCurve(vLight.y);

    // Back faces of double-sided foliage flip the normal so both sides of a
    // cross-quad read identically.
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;

    vec3 L = uSunDir;
    if (uViewmodel > 0.5) L = normalize(vec3(0.45, 0.8, 0.4));

    // Water gets a rippled normal on its top surface; everything else shades
    // from its face normal.
    vec3 Nl = N;
    vec3 V = normalize(cameraPosition - vWorldPos);
    if (uIsWater > 0.5 && N.y > 0.5) {
      vec2 g = waterSlope(vWorldPos.xz, uTime);
      Nl = normalize(vec3(-g.x, 1.0, -g.y));
    }

    // --- sky light: hemisphere ambient + direct sun ------------------------
    float up = Nl.y * 0.5 + 0.5;
    vec3 hemi = mix(uAmbGround, uAmbSky, up);
    float ndl = max(dot(Nl, L), 0.0);
    // Direct light only reaches cells that can see most of the sky, which is a
    // cheap stand-in for a shadow: under a canopy or an overhang the baked sky
    // level drops and the sun term fades out while the ambient survives.
    float sunVis = smoothstep(0.50, 0.92, skyVis);
    vec3 skyLight = hemi * skyVis + uSunLight * ndl * sunVis;

    // --- torch light --------------------------------------------------------
    vec3 blkLight = uBlockTint * blkVis * 1.7;

    vec3 light = max(skyLight + blkLight, vec3(uAmbient));
    // Vertex ambient occlusion: the mesher's 0.7..1 range reads faint once the
    // light is linear, so square it to get properly dark creases and corners.
    float ao = vAO * vAO;
    vec3 lit = albedo * light * ao;
    float alpha = base.a * uOpacity;

    if (uIsWater > 0.5) {
      // Fresnel: look straight down and you see through the water; look along
      // it and you see the sky in it.
      float cosT = max(dot(Nl, V), 0.0);
      float fres = 0.03 + 0.97 * pow(1.0 - cosT, 4.0);
      vec3 R = reflect(-V, Nl);
      vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));
      lit = mix(lit, sky * (0.35 + 0.65 * sunVis), fres * (N.y > 0.5 ? 1.0 : 0.35));
      // Sun / moon glint on the ripples.
      float spec = pow(max(dot(R, L), 0.0), 240.0);
      lit += uSunLight * spec * 3.0 * sunVis * step(0.0, L.y);
      alpha = clamp(mix(alpha, 0.97, fres), 0.0, 1.0);
    }

    lit *= uExposure;
    vec3 mapped = toneMap(lit);
    // A touch of saturation back: tone mapping pulls everything toward grey.
    float luma = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    mapped = mix(vec3(luma), mapped, 1.12);
    vec3 rgb = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));
    // Sub-LSB noise breaks up banding in the long dark gradients.
    rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(rgb, alpha);

    #include <fog_fragment>
  }
`;

/* Shared uniform block. Every terrain material references the SAME uniform
   objects, so updating the day/night state once updates opaque, water and
   foliage passes together — no chance of them drifting out of sync. */
/* A 1x1x1 transparent array texture. GLSL requires every sampler to be bound
   to something of the right type; leaving uAtlas null before a pack loads
   would have the renderer substitute a plain 2D default, which mismatches
   sampler2DArray and fails to link on some drivers. */
function makeFallbackArrayTexture() {
  const tex = new THREE.DataArrayTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export function createSharedUniforms() {
  return {
    uAtlas: { value: makeFallbackArrayTexture() },
    uHasAtlas: { value: 0 },
    uSkyTint: { value: new THREE.Color(1, 1, 1) },
    // Linear light: torchlight is warm orange, strong enough to read in a
    // cave and to hold its own against dusk ambient.
    uBlockTint: { value: new THREE.Color(1.0, 0.55, 0.22) },
    uSunDir: { value: new THREE.Vector3(0.35, 0.85, 0.4).normalize() },
    uAmbSky: { value: new THREE.Color(0.30, 0.45, 0.70) },
    uAmbGround: { value: new THREE.Color(0.12, 0.11, 0.09) },
    uSunLight: { value: new THREE.Color(1.3, 1.25, 1.1) },
    uHorizon: { value: new THREE.Color(0.35, 0.58, 1.0) },
    uZenith: { value: new THREE.Color(0.06, 0.24, 0.80) },
    uExposure: { value: 1.15 },
    uDaylight: { value: 1 },
    uAmbient: { value: 0.006 },
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
        uIsWater: { value: 0 },
        uViewmodel: { value: 0 },
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
      // GLSL3 is required for sampler2DArray. Three's ES3 prefix aliases
      // attribute/varying/gl_FragColor/texture2D, so the shader source above
      // still reads like conventional GLSL1.
      glslVersion: THREE.GLSL3,
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
    uOpacity: { value: 0.66 },
    uWaveStrength: { value: 0.35 },
    uIsWater: { value: 1 },
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

  // The held-item viewmodel. Same shader, same shared uniforms — so it picks
  // up the texture atlas and the time of day automatically and can never
  // drift from how the world looks.
  //
  // Fog is disabled rather than inherited: the viewmodel is drawn in its own
  // scene with the depth buffer cleared, sitting centimetres from the camera,
  // and a fogged held item would be nonsense. It also matters mechanically —
  // Three compiles USE_FOG from scene.fog, so sharing one material between a
  // fogged scene and an unfogged one would force a shader recompile on every
  // scene switch, every frame.
  const viewmodel = mk({
    name: 'voxel-viewmodel',
    fog: false,
  }, {
    uViewmodel: { value: 1 },
  });

  return { opaque, water, foliage, viewmodel };
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
  if (skyState.sunDir) shared.uSunDir.value.copy(skyState.sunDir);
  if (skyState.ambSky) shared.uAmbSky.value.setRGB(skyState.ambSky[0], skyState.ambSky[1], skyState.ambSky[2]);
  if (skyState.ambGround) shared.uAmbGround.value.setRGB(skyState.ambGround[0], skyState.ambGround[1], skyState.ambGround[2]);
  if (skyState.sunLight) shared.uSunLight.value.setRGB(skyState.sunLight[0], skyState.sunLight[1], skyState.sunLight[2]);
  if (skyState.horizon) shared.uHorizon.value.setRGB(skyState.horizon[0], skyState.horizon[1], skyState.horizon[2]);
  if (skyState.zenith) shared.uZenith.value.setRGB(skyState.zenith[0], skyState.zenith[1], skyState.zenith[2]);
  // A faint linear floor so enclosed caves (skylight 0, no torch) stay barely
  // readable rather than pure black; open ground at night is lit by the sky
  // module's moonlight floor, not by this.
  shared.uAmbient.value = 0.004 + 0.003 * d;
}

export default createVoxelMaterials;
