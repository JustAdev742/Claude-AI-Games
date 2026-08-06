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

   FACES and FACE_SHADE are imported rather than duplicated, so face
   orientation, winding and UV order have exactly one definition shared with
   the mesher. If the mesher's conventions change, this follows automatically.

   Also usable for dropped items and inventory previews.
   ========================================================================= */

import * as THREE from 'three';
import Blocks, { FACES, FACE_SHADE } from '../world/blocks.js';

// Same corner order as the mesher: (top-left, bottom-left, bottom-right,
// top-right) of each face.
const FACE_UVS = [0, 1, 0, 0, 1, 0, 1, 1];

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
    const shade = FACE_SHADE[f];
    const layer = atlas ? atlas.layerFor(blockId, f) : -1;

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
      uv.push(FACE_UVS[c * 2], FACE_UVS[c * 2 + 1]);
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
