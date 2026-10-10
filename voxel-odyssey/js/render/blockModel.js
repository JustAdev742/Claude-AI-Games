/* =========================================================================
   blockModel.js — build a single block as world-format geometry.

   The held-item viewmodel used to be a plain coloured box with its own
   MeshLambertMaterial and its own private lights. That guaranteed it could
   never match the world: no texture atlas, no voxel lighting, no per-face
   shading, and a flat tint from Blocks.iconColor. A wooden plank in hand was
   a featureless beige cube while the planks in the world were textured.

   The fix is not to re-implement the world's look for the viewmodel, but to
   emit the SAME vertex format the chunk mesher emits, so the same shader can
   draw it. That is what this module is for:

     positions / normals   geometry
     aColor                base tint (neutral when textured, so the shader
                           doesn't square the albedo — see chunk.js)
     aLight                (skylight, blocklight), supplied by the caller
     aAO                   ambient occlusion; 1.0 for a free-standing block
     uv / aTexIdx          atlas layer coordinates

   FACES is imported rather than duplicated, so face
   orientation, winding and UV order have exactly one definition shared with
   the mesher. If the mesher's conventions change, this follows automatically.

   Also usable for dropped items and inventory previews.
   ========================================================================= */

import * as THREE from 'three';
import Blocks, { FACES, FACE_UVS } from '../world/blocks.js';

/**
 * Geometry for one block, centred on the origin.
 *
 * @param {number} blockId
 * @param {object|null} atlas   TextureAtlas, or null for untextured colour
 * @param {number} size         edge length in world units
 * @returns {THREE.BufferGeometry}
 */
export function buildBlockGeometry(blockId, atlas, size = 1) {
  const positions = [];
  const normals = [];
  const colors = [];
  const light = [];
  const ao = [];
  const uv = [];
  const texIdx = [];
  const indices = [];

  const h = size / 2;

  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const dir = face.dir;
    const shade = 1;   // directional shading happens in the shader
    const layer = atlas ? atlas.layerFor(blockId, f) : -1;
    const faceUV = FACE_UVS[f];

    // Textured faces carry a neutral vertex colour so the shader multiplies
    // the texture by shading alone; untextured ones carry the block colour,
    // which is then the only thing describing the block. Identical rule to
    // the chunk mesher.
    const base = layer >= 0 ? [1, 1, 1] : Blocks.faceColor(blockId, f);
    const r = base[0] * shade, g = base[1] * shade, b = base[2] * shade;

    const start = positions.length / 3;
    for (let c = 0; c < 4; c++) {
      const cor = face.corners[c];
      // FACES corners are unit-cube 0/1; recentre on the origin.
      positions.push((cor[0] - 0.5) * size, (cor[1] - 0.5) * size, (cor[2] - 0.5) * size);
      normals.push(dir[0], dir[1], dir[2]);
      colors.push(r, g, b);
      ao.push(1.0);                        // nothing occludes a held block
      light.push(1.0, 0.0);                // overwritten by setBlockGeometryLight
      uv.push(faceUV[c * 2], faceUV[c * 2 + 1]);
      texIdx.push(layer);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geom.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(light), 2));
  geom.setAttribute('aAO', new THREE.BufferAttribute(new Float32Array(ao), 1));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geom.setAttribute('aTexIdx', new THREE.BufferAttribute(new Float32Array(texIdx), 1));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  geom.computeBoundingSphere();
  // Marks this as buildBlockGeometry output so callers can assert on it.
  geom.userData.voxelFormat = true;
  return geom;
}

/* Shared tail for the hand-built geometries below: pack plain arrays into the
   same attribute layout the terrain shader reads. */
function packVoxelGeometry(positions, normals, colors, indices) {
  const n = positions.length / 3;
  const light = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) light[i * 2] = 1;          // sky 1, torch 0 (rewritten per frame)
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geom.setAttribute('aLight', new THREE.BufferAttribute(light, 2));
  geom.setAttribute('aAO', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  geom.setAttribute('aTexIdx', new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geom.computeBoundingSphere();
  geom.userData.voxelFormat = true;
  return geom;
}

/**
 * Extrude a flat sprite into a one-voxel-thick slab, the way held tools and
 * items are drawn in first person: every opaque pixel becomes a small cube,
 * faces between neighbouring pixels are dropped, and the result is lit by the
 * same terrain shader as everything else.
 *
 * @param {Uint8ClampedArray} rgba  w*h RGBA pixels, row 0 at the top
 * @param {number} w
 * @param {number} h
 * @param {number} size  world-space edge length of the whole sprite
 */
export function buildSpriteGeometry(rgba, w, h, size = 0.6) {
  const positions = [], normals = [], colors = [], indices = [];
  const px = size / w;          // one pixel, in world units
  const depth = px;             // one pixel thick
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] >= 110;

  const quad = (a, b, c, d, n, col) => {
    const base = positions.length / 3;
    for (const v of [a, b, c, d]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(n[0], n[1], n[2]);
      colors.push(col[0], col[1], col[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      const i = (y * w + x) * 4;
      const col = [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];
      // Sprite space: x right, y up, centred on the origin; row 0 is the top.
      const x0 = (x - w / 2) * px, x1 = x0 + px;
      const y1 = (h / 2 - y) * px, y0 = y1 - px;
      const z0 = -depth / 2, z1 = depth / 2;
      // Front / back faces always; the slab is only one pixel deep.
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col);
      quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col);
      if (!solid(x + 1, y)) quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col);
      if (!solid(x - 1, y)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col);
      if (!solid(x, y - 1)) quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col);
      if (!solid(x, y + 1)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col);
    }
  }
  return packVoxelGeometry(positions, normals, colors, indices);
}

/** A plain coloured box, centred on the origin (used for the bare-hand arm). */
export function buildBoxGeometry(sx, sy, sz, color) {
  const positions = [], normals = [], colors = [], indices = [];
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [1, 0, 0]],
    [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-1, 0, 0]],
    [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], [0, 1, 0]],
    [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0]],
    [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [0, 0, 1]],
    [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [0, 0, -1]],
  ];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let k = 0; k < 4; k++) {
      positions.push(f[k][0], f[k][1], f[k][2]);
      normals.push(f[4][0], f[4][1], f[4][2]);
      colors.push(color[0], color[1], color[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return packVoxelGeometry(positions, normals, colors, indices);
}

/**
 * Rewrite a block geometry's light attribute in place.
 *
 * The held item is lit by wherever the PLAYER is standing, so this is called
 * every frame with the voxel light at the camera — walk into a cave and the
 * block in your hand goes dark with the walls, exactly as the terrain does,
 * because both end up in the same shader with the same light curve.
 */
export function setBlockGeometryLight(geom, sky, block) {
  const attr = geom && geom.attributes && geom.attributes.aLight;
  if (!attr) return;
  const a = attr.array;
  // Skip the upload when nothing meaningfully changed — this runs per frame.
  if (Math.abs(a[0] - sky) < 0.002 && Math.abs(a[1] - block) < 0.002) return;
  for (let i = 0; i < a.length; i += 2) { a[i] = sky; a[i + 1] = block; }
  attr.needsUpdate = true;
}

export default buildBlockGeometry;
