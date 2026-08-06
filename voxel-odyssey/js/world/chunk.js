/* =========================================================================
   chunk.js — voxel storage + greedy-ish per-face mesher.

   This module is intentionally PURE: it imports no Three.js and uses only
   typed arrays and plain JS objects, so the whole thing can be imported and
   unit-tested under Node. `World` turns the plain-array geometry that
   `meshChunk` returns into actual THREE.BufferGeometry / THREE.Mesh objects.

   A `Chunk` is a full-height column of voxels (CHUNK_SX × CHUNK_SY × CHUNK_SZ)
   stored in a flat Uint8Array. The index layout is defined by `localIndex`
   in constants.js (x-major, then z, then y) which keeps a vertical column
   contiguous — convenient for height scans and the y-loops below.

   Face index convention (shared with blocks.js / FACES):
     0:+X (east)  1:-X (west)  2:+Y (top)  3:-Y (bottom)  4:+Z (south)  5:-Z (north)
   ========================================================================= */

import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOL, localIndex } from './constants.js';
import Blocks, { ID, FACES, FACE_SHADE } from './blocks.js';
import { tintVariation } from '../core/utils.js';

/* =========================================================================
   Chunk — pure voxel data container.
   ========================================================================= */
export class Chunk {
  constructor(cx, cz) {
    this.cx = cx | 0;
    this.cz = cz | 0;

    // Block ids. Uint8 is enough: < 256 ids.
    this.blocks = new Uint8Array(CHUNK_VOL);

    // Per-voxel light, two 4-bit channels packed into one byte (see
    // lighting.js): bits 7..4 skylight, bits 3..0 blocklight. Both 0..15.
    this.light = new Uint8Array(CHUNK_VOL);

    // Bookkeeping flags read by World.
    this.dirty = true;       // geometry needs (re)building
    this.generated = false;  // terrain has been written by WorldGen
    this.lit = false;        // LightEngine has done its initial flood fill
    this.empty = true;       // fast skip: true while only air has been written
  }

  /* -------- bounds helpers -------- */
  static inBounds(lx, y, lz) {
    return (
      lx >= 0 && lx < CHUNK_SX &&
      lz >= 0 && lz < CHUNK_SZ &&
      y >= 0 && y < CHUNK_SY
    );
  }

  /* -------- read/write a single voxel (chunk-local coords) -------- */

  // Returns the block id at a local coordinate, or AIR (0) when out of the
  // vertical range. Horizontal out-of-range also returns AIR defensively so
  // a mesher reading just past an edge never crashes (World supplies real
  // neighbour data through getBlock for borders).
  getLocal(lx, y, lz) {
    if (y < 0 || y >= CHUNK_SY) return ID.AIR;
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return ID.AIR;
    return this.blocks[localIndex(lx, y, lz)];
  }

  // Sets a voxel and marks the chunk dirty. No neighbour/light logic here —
  // World handles cross-chunk remesh queuing. Out-of-range writes are ignored.
  setLocal(lx, y, lz, id) {
    if (!Chunk.inBounds(lx, y, lz)) return;
    const idx = localIndex(lx, y, lz);
    const v = id & 0xff;
    if (this.blocks[idx] === v) return; // no-op: keep dirty flag honest
    this.blocks[idx] = v;
    if (v !== ID.AIR) this.empty = false;
    this.dirty = true;
  }

  // Raw packed light byte (sky << 4 | block); 0 if out of range.
  getLightByte(lx, y, lz) {
    if (!Chunk.inBounds(lx, y, lz)) return 0;
    return this.light[localIndex(lx, y, lz)];
  }

  // Skylight 0..15 — daylight reaching this voxel, scaled by time of day
  // at render time.
  getSkyLight(lx, y, lz) {
    if (!Chunk.inBounds(lx, y, lz)) return 0;
    return (this.light[localIndex(lx, y, lz)] >> 4) & 0x0f;
  }

  setSkyLight(lx, y, lz, value) {
    if (!Chunk.inBounds(lx, y, lz)) return;
    const i = localIndex(lx, y, lz);
    this.light[i] = (this.light[i] & 0x0f) | ((value & 0x0f) << 4);
  }

  // Blocklight 0..15 — torches and other emitters, independent of time of day.
  getBlockLight(lx, y, lz) {
    if (!Chunk.inBounds(lx, y, lz)) return 0;
    return this.light[localIndex(lx, y, lz)] & 0x0f;
  }

  setBlockLight(lx, y, lz, value) {
    if (!Chunk.inBounds(lx, y, lz)) return;
    const i = localIndex(lx, y, lz);
    this.light[i] = (this.light[i] & 0xf0) | (value & 0x0f);
  }

  // Inclusive vertical fill of one column with a single id. Clamps to range.
  fillColumn(lx, lz, fromY, toY, id) {
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
    let y0 = fromY, y1 = toY;
    if (y0 > y1) { const t = y0; y0 = y1; y1 = t; } // tolerate reversed args
    if (y0 < 0) y0 = 0;
    if (y1 > CHUNK_SY - 1) y1 = CHUNK_SY - 1;
    const v = id & 0xff;
    const base = (lx * CHUNK_SZ + lz) * CHUNK_SY; // column is contiguous (see localIndex)
    for (let y = y0; y <= y1; y++) this.blocks[base + y] = v;
    if (v !== ID.AIR && y1 >= y0) this.empty = false;
    this.dirty = true;
  }

  // Topmost non-air voxel in a local column, or -1 if the column is empty.
  highestSolid(lx, lz) {
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return -1;
    const base = (lx * CHUNK_SZ + lz) * CHUNK_SY;
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      if (this.blocks[base + y] !== ID.AIR) return y;
    }
    return -1;
  }

  // Wipe to all-air (used when regenerating in place).
  clear() {
    this.blocks.fill(ID.AIR);
    this.light.fill(0);
    this.empty = true;
    this.generated = false;
    this.lit = false;
    this.dirty = true;
  }
}

/* =========================================================================
   Meshing.

   `meshChunk(chunk, getBlock, opts)` walks every voxel and emits the visible
   faces into three buckets:
     - opaque : solid cubes + leaves (drawn FrontSide, Lambert)
     - water  : liquids (transparent pass, lowered top surface)
     - cross  : flowers / grass / mushrooms / torch (two crossed quads)

   Each bucket is a set of parallel arrays in chunk-LOCAL space; World offsets
   the whole mesh to the chunk origin and uploads them as vertex attributes:

     positions  vec3   geometry
     normals    vec3   geometry
     colors     vec3   base/biome tint  -> aColor
     light      vec2   (skylight, blocklight) each 0..1, smoothed per corner
     ao         float  ambient occlusion 0..1  -> aAO
     uv         vec2   atlas coordinates
     texIdx     float  atlas tile index, -1 when untextured
     indices    uint

   Light is emitted per-vertex but NOT combined with the time of day here —
   that happens in the shader (see render/material.js), so sunset doesn't
   require re-meshing the world.
   ========================================================================= */

// Ambient-occlusion vertex factor from three potential occluders around a
// corner. The classic formula: if both side neighbours are occluders the
// corner is fully dark regardless of the diagonal; otherwise it darkens by
// how many of the three are present. Result is clamped to a gentle range so
// AO reads as soft shadowing, not hard black.
const AO_LEVELS = [1.0, 0.78, 0.6, 0.45]; // 0,1,2,3 occluders
function vertexAO(side1, side2, corner) {
  if (side1 && side2) return AO_LEVELS[3];
  return AO_LEVELS[(side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)];
}

// Does block `id` occlude AO / act as a solid neighbour for shading? Full
// opaque cubes occlude; transparent things (glass, leaves, water, cross,
// air) do not, so AO doesn't bleed under foliage.
function isOccluder(id) {
  if (id === ID.AIR) return false;
  const d = Blocks.get(id);
  return d.solid && !d.transparent && d.render === 'cube';
}

// The four neighbour-offset triples used to compute AO for each of a face's
// four corners. For face f and corner c, AO depends on the two voxels
// adjacent along the face plane plus the diagonal voxel — all sampled in the
// layer one step out along the face normal. We derive these from the corner
// position relative to the face center so the data stays in one place.
//
// To keep this allocation-free and correct for the FACES corner ordering, we
// precompute, per face, per corner, the [side1, side2, diagonal] offset
// vectors (each relative to the *neighbour* voxel in front of the face).
const AO_OFFSETS = buildAOOffsets();

function buildAOOffsets() {
  // For each face we need a 2D basis (u, v) spanning the face plane. The two
  // in-plane axes are simply the axes that aren't the face normal axis.
  const table = [];
  for (let f = 0; f < FACES.length; f++) {
    const dir = FACES[f].dir;
    const nAxis = dir[0] !== 0 ? 0 : dir[1] !== 0 ? 1 : 2;
    // In-plane axes (the other two).
    const uAxis = (nAxis + 1) % 3;
    const vAxis = (nAxis + 2) % 3;

    const perCorner = [];
    for (let c = 0; c < 4; c++) {
      const corner = FACES[f].corners[c]; // [x,y,z] in 0/1
      // Sign of the corner offset from the cube center (-1 or +1) along each
      // in-plane axis tells us which diagonal neighbour matters.
      const su = corner[uAxis] === 1 ? 1 : -1;
      const sv = corner[vAxis] === 1 ? 1 : -1;

      const side1 = [0, 0, 0];
      const side2 = [0, 0, 0];
      const diag = [0, 0, 0];
      side1[uAxis] = su;
      side2[vAxis] = sv;
      diag[uAxis] = su;
      diag[vAxis] = sv;
      perCorner.push({ side1, side2, diag });
    }
    table.push(perCorner);
  }
  return table;
}

// Subtle per-voxel tint amount so large flat surfaces don't look dead-flat.
const TINT_AMOUNT = 0.045;
const TINT_SEED = 1337;

// Neutral albedo, used as the vertex colour for textured faces so the shader
// multiplies the texture by shading alone.
const WHITE = [1, 1, 1];

// UVs for a quad's four corners, in FACES corner order
// (top-left, bottom-left, bottom-right, top-right). Constant because a
// texture array gives every tile the full 0..1 range.
const FACE_UVS = [0, 1, 0, 0, 1, 0, 1, 1];

export function meshChunk(chunk, getBlock, opts) {
  opts = opts || {};
  const ao = opts.ao !== false; // default on
  const smooth = opts.smoothLighting !== false; // default on
  const atlas = opts.atlas || null;             // optional TextureAtlas
  const off = opts.worldOffset || { x: chunk ? chunk.cx * CHUNK_SX : 0, z: chunk ? chunk.cz * CHUNK_SZ : 0 };
  const ox = off.x | 0;
  const oz = off.z | 0;

  const opaque = newBucket();
  const water = newBucket();
  const cross = newBucket();

  // Empty / missing chunk → empty buckets (never throw in this path).
  if (!chunk || !chunk.blocks) return { opaque, water, cross };

  const blocks = chunk.blocks;
  const lightArr = chunk.light;

  // A world-voxel sampler that prefers the in-chunk array (fast path) and
  // falls back to the provided getBlock for anything outside this chunk.
  const sample = (wx, wy, wz) => {
    const lx = wx - ox;
    const lz = wz - oz;
    if (lx >= 0 && lx < CHUNK_SX && lz >= 0 && lz < CHUNK_SZ && wy >= 0 && wy < CHUNK_SY) {
      return blocks[localIndex(lx, wy, lz)];
    }
    if (typeof getBlock === 'function') {
      const id = getBlock(wx, wy, wz);
      return id === undefined || id === null ? ID.AIR : id;
    }
    return ID.AIR;
  };

  // Packed light byte at a world voxel. Above the build limit the sky is
  // fully open, which keeps faces on the top layer from going black.
  const getLightFn = opts.getLight;
  const sampleLight = (wx, wy, wz) => {
    if (wy >= CHUNK_SY) return 0xf0;   // sky 15, block 0
    if (wy < 0) return 0;
    const lx = wx - ox;
    const lz = wz - oz;
    if (lx >= 0 && lx < CHUNK_SX && lz >= 0 && lz < CHUNK_SZ) {
      return lightArr[localIndex(lx, wy, lz)];
    }
    if (typeof getLightFn === 'function') {
      const v = getLightFn(wx, wy, wz);
      return v === undefined || v === null ? 0 : v;
    }
    return 0;
  };

  const ctx = { sample, sampleLight, ao, smooth, atlas };

  for (let lx = 0; lx < CHUNK_SX; lx++) {
    const wx = ox + lx;
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const wz = oz + lz;
      const colBase = (lx * CHUNK_SZ + lz) * CHUNK_SY;
      for (let y = 0; y < CHUNK_SY; y++) {
        const id = blocks[colBase + y];
        if (id === ID.AIR) continue;

        const render = Blocks.renderType(id);
        if (render === 'cross') {
          emitCross(cross, ctx, id, wx, y, wz, lx, y, lz);
        } else if (render === 'liquid') {
          emitLiquid(water, ctx, id, wx, y, wz, lx, y, lz);
        } else {
          emitCube(opaque, ctx, id, wx, y, wz, lx, y, lz);
        }
      }
    }
  }

  return { opaque, water, cross };
}

function newBucket() {
  return {
    positions: [], normals: [], colors: [],
    light: [], ao: [], uv: [], texIdx: [],
    indices: [],
  };
}

/* -------- emit one opaque/leaf cube's visible faces -------- */
function emitCube(bucket, ctx, id, wx, wy_, wz, lx, ly, lz) {
  for (let f = 0; f < 6; f++) {
    const dir = FACES[f].dir;
    const nx = wx + dir[0];
    const ny = wy_ + dir[1];
    const nz = wz + dir[2];
    const neighbor = ctx.sample(nx, ny, nz);

    if (!Blocks.shouldRenderFace(id, neighbor)) continue;

    const shade = FACE_SHADE[f];
    const layer = ctx.atlas ? ctx.atlas.layerFor(id, f) : -1;

    // The shader computes base = texture * vColor. When a texture supplies the
    // albedo, vColor must carry ONLY shading and tint — passing the block's
    // base colour as well would square the albedo, which comes out dark and
    // oversaturated. Untextured blocks still need the colour, since it is the
    // only thing describing what they look like.
    const source = layer >= 0 ? WHITE : Blocks.faceColor(id, f);
    const tinted = tintVariation(source, wx, wy_, wz, TINT_SEED, TINT_AMOUNT);
    const r = tinted[0] * shade;
    const g = tinted[1] * shade;
    const b = tinted[2] * shade;

    const aoArr = ctx.ao ? aoForFace(ctx.sample, f, wx, wy_, wz) : null;
    const lit = lightForFace(ctx, f, wx, wy_, wz);

    pushFace(bucket, f, lx, ly, lz, r, g, b, 0, aoArr, lit, layer);
  }
}

/* -------- emit a liquid cell (water) -------- */
function emitLiquid(bucket, ctx, id, wx, wy_, wz, lx, ly, lz) {
  const aboveIsWater = Blocks.isLiquid(ctx.sample(wx, wy_ + 1, wz));
  // Surface is lowered when there's no water directly above (gives a top).
  const topY = aboveIsWater ? 1.0 : 0.88;

  for (let f = 0; f < 6; f++) {
    const dir = FACES[f].dir;
    const nx = wx + dir[0];
    const ny = wy_ + dir[1];
    const nz = wz + dir[2];
    const neighbor = ctx.sample(nx, ny, nz);

    // Cull water↔water shared faces, and faces hidden by opaque neighbours.
    if (Blocks.isLiquid(neighbor)) continue;
    if (!Blocks.shouldRenderFace(id, neighbor)) continue;

    const shade = FACE_SHADE[f];
    const layer = ctx.atlas ? ctx.atlas.layerFor(id, f) : -1;
    const base = layer >= 0 ? WHITE : Blocks.faceColor(id, f);
    const r = base[0] * shade;
    const g = base[1] * shade;
    const b = base[2] * shade;

    const lit = lightForFace(ctx, f, wx, wy_, wz);

    // The top face (and the upper edge of side faces) uses the lowered height
    // only when the surface is exposed.
    pushFace(bucket, f, lx, ly, lz, r, g, b, 1.0 - topY, null, lit, layer);
  }
}

/* -------- emit a cross-quad plant/torch -------- */
function emitCross(bucket, ctx, id, wx, wy_, wz, lx, ly, lz) {
  const layer = ctx.atlas ? ctx.atlas.layerFor(id, 2) : -1;
  // As in emitCube: with a texture the vertex colour is neutral so the albedo
  // isn't applied twice.
  const color = layer >= 0 ? WHITE : Blocks.faceColor(id, 2);

  // A cross-quad occupies the same cell it is lit by, so sample light at the
  // block itself rather than at a neighbour. An emissive cross (a torch) would
  // otherwise read its own dark neighbour and render unlit.
  const packed = ctx.sampleLight(wx, wy_, wz);
  const sky = ((packed >> 4) & 0x0f) / 15;
  const blk = (packed & 0x0f) / 15;
  const lit = [sky, blk, sky, blk, sky, blk, sky, blk];

  // Inset slightly so the X never lies exactly in the plane of an adjacent
  // block face — coplanar surfaces are the classic z-fighting trigger.
  const inset = 0.02;
  const x0 = lx + inset, x1 = lx + 1 - inset;
  const z0 = lz + inset, z1 = lz + 1 - inset;
  const y0 = ly, y1 = ly + 1;

  const r = color[0], g = color[1], b = color[2];
  // Normals point up so plants catch top-down lighting pleasantly.
  const n = [0, 1, 0];

  // Quad A: from (x0,z0) to (x1,z1) — a diagonal plane.
  addQuad(bucket, [x0, y1, z0], [x0, y0, z0], [x1, y0, z1], [x1, y1, z1], n, r, g, b, lit, layer);
  // Quad B: from (x0,z1) to (x1,z0) — the crossing diagonal plane.
  addQuad(bucket, [x0, y1, z1], [x0, y0, z1], [x1, y0, z0], [x1, y1, z0], n, r, g, b, lit, layer);
}

/* -------- AO computation for a cube face -------- */
// Returns a length-4 array of AO factors, one per corner (matching FACES
// corner order). Occluders are sampled in the neighbour layer in front of
// the face.
function aoForFace(sample, f, wx, wy_, wz) {
  const dir = FACES[f].dir;
  // The voxel layer immediately in front of this face.
  const bx = wx + dir[0];
  const by = wy_ + dir[1];
  const bz = wz + dir[2];

  const offs = AO_OFFSETS[f];
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const o = offs[c];
    const s1 = isOccluder(sample(bx + o.side1[0], by + o.side1[1], bz + o.side1[2]));
    const s2 = isOccluder(sample(bx + o.side2[0], by + o.side2[1], bz + o.side2[2]));
    const dg = isOccluder(sample(bx + o.diag[0], by + o.diag[1], bz + o.diag[2]));
    out[c] = vertexAO(s1, s2, dg);
  }
  return out;
}

/* -------- smooth per-corner lighting for a cube face --------
   Averages the light of the four voxels touching each corner in the layer in
   front of the face — the same neighbourhood AO uses. This is what turns the
   voxel light grid into a smooth gradient across a wall instead of a visible
   grid of flat-shaded squares.

   Only non-opaque samples contribute: solid blocks store no light, so
   including them would drag every corner adjacent to a wall towards black and
   produce dark rims around every opening. */
const _litScratch = new Array(8);
function lightForFace(ctx, f, wx, wy_, wz) {
  const dir = FACES[f].dir;
  const bx = wx + dir[0];
  const by = wy_ + dir[1];
  const bz = wz + dir[2];

  const basePacked = ctx.sampleLight(bx, by, bz);

  if (!ctx.smooth) {
    const s = ((basePacked >> 4) & 0x0f) / 15;
    const b = (basePacked & 0x0f) / 15;
    for (let i = 0; i < 8; i += 2) { _litScratch[i] = s; _litScratch[i + 1] = b; }
    return _litScratch.slice();
  }

  const offs = AO_OFFSETS[f];
  const out = new Array(8);

  for (let c = 0; c < 4; c++) {
    const o = offs[c];
    let skySum = 0, blkSum = 0, n = 0;

    // The four voxels meeting at this corner: the face neighbour plus the two
    // in-plane sides and the diagonal.
    const cand = [
      [bx, by, bz],
      [bx + o.side1[0], by + o.side1[1], bz + o.side1[2]],
      [bx + o.side2[0], by + o.side2[1], bz + o.side2[2]],
      [bx + o.diag[0], by + o.diag[1], bz + o.diag[2]],
    ];
    for (let i = 0; i < 4; i++) {
      const p = cand[i];
      if (isOccluder(ctx.sample(p[0], p[1], p[2]))) continue;
      const packed = ctx.sampleLight(p[0], p[1], p[2]);
      skySum += (packed >> 4) & 0x0f;
      blkSum += packed & 0x0f;
      n++;
    }

    if (n === 0) {
      // Fully enclosed corner — fall back to the face neighbour's own value.
      out[c * 2] = ((basePacked >> 4) & 0x0f) / 15;
      out[c * 2 + 1] = (basePacked & 0x0f) / 15;
    } else {
      out[c * 2] = skySum / n / 15;
      out[c * 2 + 1] = blkSum / n / 15;
    }
  }
  return out;
}

/* -------- low-level geometry writers -------- */

// Push a single cube face. `dropTop` (0..1) lowers any corner whose unit-cube
// y is 1 — used to give water a sunken surface. `aoArr` (or null) supplies the
// per-corner AO factor, `lit` the per-corner (sky, block) pairs, and `tile`
// the atlas rect (or null when untextured).
function pushFace(bucket, f, lx, ly, lz, r, g, b, dropTop, aoArr, lit, layer) {
  const face = FACES[f];
  const dir = face.dir;
  const corners = face.corners;
  const startVert = bucket.positions.length / 3;

  // Quad corner order is (top-left, bottom-left, bottom-right, top-right),
  // so UVs walk the tile rect in the same order.
  // Every texture owns a full array layer, so the UV rect is always the whole
  // tile. Corner order is (top-left, bottom-left, bottom-right, top-right).
  const uvs = FACE_UVS;
  const ti = layer;

  for (let c = 0; c < 4; c++) {
    const cor = corners[c];
    const px = lx + cor[0];
    let py = ly + cor[1];
    const pz = lz + cor[2];
    if (dropTop > 0 && cor[1] === 1) py -= dropTop;

    bucket.positions.push(px, py, pz);
    bucket.normals.push(dir[0], dir[1], dir[2]);
    bucket.colors.push(r, g, b);
    bucket.ao.push(aoArr ? aoArr[c] : 1.0);
    bucket.light.push(lit ? lit[c * 2] : 1.0, lit ? lit[c * 2 + 1] : 0.0);
    bucket.uv.push(uvs[c * 2], uvs[c * 2 + 1]);
    bucket.texIdx.push(ti);
  }

  // Two triangles per quad: 0,1,2, 0,2,3 — wound so the face is visible from
  // outside with FrontSide (FACES corners are CCW seen from outside).
  pushQuadIndices(bucket, startVert, aoArr, lit);
}

// Generic quad writer (used by cross planes) with explicit positions/normal.
function addQuad(bucket, p0, p1, p2, p3, n, r, g, b, lit, layer) {
  const startVert = bucket.positions.length / 3;
  bucket.positions.push(p0[0], p0[1], p0[2]);
  bucket.positions.push(p1[0], p1[1], p1[2]);
  bucket.positions.push(p2[0], p2[1], p2[2]);
  bucket.positions.push(p3[0], p3[1], p3[2]);

  const uvs = FACE_UVS;
  const ti = layer;

  for (let i = 0; i < 4; i++) {
    bucket.normals.push(n[0], n[1], n[2]);
    bucket.colors.push(r, g, b);
    bucket.ao.push(1.0);
    bucket.light.push(lit ? lit[i * 2] : 1.0, lit ? lit[i * 2 + 1] : 0.0);
    bucket.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
    bucket.texIdx.push(ti);
  }
  pushQuadIndices(bucket, startVert, null, null);
}

// Emit the two triangles for a quad starting at vertex `s`. When brightness
// varies across the quad we flip the triangulation diagonal to avoid the
// classic anisotropic seam (so the darker corners share an edge).
//
// The flip decision weighs AO *and* baked light together: with smooth
// lighting a quad straddling a torch's edge has a strong light gradient even
// where AO is uniform, and splitting it along the wrong diagonal leaves a
// visible crease down the middle of the face.
function pushQuadIndices(bucket, s, aoArr, lit) {
  let flip = false;
  if (aoArr || lit) {
    const w = (i) => {
      const a = aoArr ? aoArr[i] : 1;
      // Combine the two light channels into one brightness proxy.
      const l = lit ? Math.max(lit[i * 2], lit[i * 2 + 1]) : 1;
      return a * (0.35 + 0.65 * l);
    };
    if (w(0) + w(2) < w(1) + w(3)) flip = true;
  }
  if (flip) {
    bucket.indices.push(s + 1, s + 2, s + 3, s + 1, s + 3, s + 0);
  } else {
    bucket.indices.push(s + 0, s + 1, s + 2, s + 0, s + 2, s + 3);
  }
}

export default Chunk;
