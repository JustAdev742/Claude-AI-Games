/* =========================================================================
   blocks.js — the block registry.

   Each block has a numeric id (stored in chunk arrays as a Uint8/Uint16) and
   a definition describing how it looks and behaves. Rendering uses per-face
   vertex colors (no texture atlas) plus shading + ambient occlusion in the
   mesher, which gives a clean low-poly look with zero external assets.

   Face index convention (shared with the chunk mesher):
     0:+X (east)  1:-X (west)  2:+Y (top)  3:-Y (bottom)  4:+Z (south)  5:-Z (north)

   Render types:
     'cube'   — full opaque/transparent cube (default)
     'liquid' — water-like, rendered in the transparent pass, slightly lowered top
     'cross'  — two crossed quads (flowers, tall grass, mushrooms, saplings)
   ========================================================================= */

import { rgb } from '../core/utils.js';

// Per-face brightness multiplier baked into vertex colors for cheap "lighting".
export const FACE_SHADE = [0.78, 0.78, 1.0, 0.5, 0.66, 0.66];

// Unit-cube face geometry, shared by the mesher. Each face: outward dir,
// four corner offsets (CCW seen from outside), and the two UV-ish tangent dirs.
export const FACES = [
  { dir: [1, 0, 0], corners: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] }, // +X
  { dir: [-1, 0, 0], corners: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] }, // -X
  { dir: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // +Y
  { dir: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] }, // -Y
  { dir: [0, 0, 1], corners: [[1, 1, 1], [0, 1, 1], [0, 0, 1], [1, 0, 1]] }, // +Z
  { dir: [0, 0, -1], corners: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] }, // -Z
];

/* Per-corner UVs for each face, DERIVED from the face geometry rather than
   assumed from corner order.

   The FACES corner lists below are not consistent about how they walk a quad:
   the +X/-X faces go (top, bottom, bottom, top) while +Z/-Z go
   (top, top, bottom, bottom). A single fixed UV array therefore fits the X
   faces and rotates the Z faces 90 degrees — which put the grass lip on the
   left or right edge of half the blocks in the world and read as textures
   being randomly upside down.

   Computing UVs from each corner's position in the face's own plane makes
   that class of bug impossible: v always follows world +Y on side faces, and
   u always runs left-to-right as seen from OUTSIDE the block, whatever order
   the corners happen to be listed in. */
function buildFaceUVs() {
  const table = [];
  for (const face of FACES) {
    const [dx, dy, dz] = face.dir;
    const uvs = [];
    for (const [cx, cy, cz] of face.corners) {
      let u, v;
      if (dy !== 0) {
        // Horizontal face: the plane is x/z. Mirror on the underside so the
        // texture isn't reversed when seen from below.
        u = cx;
        v = dy > 0 ? 1 - cz : cz;
      } else if (dx !== 0) {
        // Facing along X: v is height, u runs along Z (mirrored on +X so it
        // reads left-to-right from outside).
        v = cy;
        u = dx > 0 ? 1 - cz : cz;
      } else {
        // Facing along Z: v is height, u runs along X.
        v = cy;
        u = dz > 0 ? cx : 1 - cx;
      }
      uvs.push(u, v);
    }
    table.push(uvs);
  }
  return table;
}

// Per-face, per-corner UVs (8 floats per face: u,v for each of 4 corners).
export const FACE_UVS = buildFaceUVs();


// ---- numeric ids (also exported as a frozen object) ----------------------
export const ID = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  SAND: 4,
  WATER: 5,
  LOG: 6,
  LEAVES: 7,
  PLANKS: 8,
  COBBLESTONE: 9,
  BEDROCK: 10,
  GRAVEL: 11,
  SNOW: 12,
  ICE: 13,
  COAL_ORE: 14,
  IRON_ORE: 15,
  GOLD_ORE: 16,
  DIAMOND_ORE: 17,
  GLASS: 18,
  GLOWSTONE: 19,
  CACTUS: 20,
  PUMPKIN: 21,
  CRAFTING_TABLE: 22,
  FURNACE: 23,
  BRICKS: 24,
  MOSSY_COBBLE: 25,
  CLAY: 26,
  SANDSTONE: 27,
  BIRCH_LOG: 28,
  BIRCH_LEAVES: 29,
  PINE_LOG: 30,
  PINE_LEAVES: 31,
  FLOWER_RED: 32,
  FLOWER_YELLOW: 33,
  TALL_GRASS: 34,
  MUSHROOM_RED: 35,
  TORCH: 36,
  OBSIDIAN: 37,
  EMERALD_ORE: 38,
  REDSTONE_ORE: 39,
  LANTERN: 40,
  LAVA: 41,
};
Object.freeze(ID);

// Default definition fields; each entry below overrides what it needs.
function def(o) {
  return Object.assign({
    name: 'Block',
    solid: true,
    transparent: false,   // true => does not cull neighbouring faces
    liquid: false,
    light: 0,             // 0..15 emitted light
    opacity: 15,          // how much it dims light passing through (15 = opaque)
    hardness: 1.0,        // relative mining time
    render: 'cube',
    color: rgb(180, 180, 180),
    top: null, side: null, bottom: null, // optional per-face overrides
    drop: undefined,      // item key dropped (defaults to own key)
    tool: 'any',          // preferred tool category: 'pickaxe'|'axe'|'shovel'|'any'
    flammable: false,
    walkSound: 'stone',
  }, o);
}

// Registry table indexed by id.
const REG = [];
function register(id, key, definition) {
  const d = def(definition);
  d.id = id;
  d.key = key;
  if (d.drop === undefined) d.drop = key;
  REG[id] = d;
}

// ---- the blocks ----------------------------------------------------------
register(ID.AIR, 'air', {
  name: 'Air', solid: false, transparent: true, opacity: 0, render: 'air',
  color: rgb(0, 0, 0), drop: null,
});
register(ID.STONE, 'stone', {
  name: 'Stone', color: rgb(122, 122, 128), hardness: 2.5, tool: 'pickaxe',
  drop: 'cobblestone', walkSound: 'stone',
});
register(ID.DIRT, 'dirt', {
  name: 'Dirt', color: rgb(120, 85, 58), hardness: 0.6, tool: 'shovel', walkSound: 'grass',
});
register(ID.GRASS, 'grass', {
  name: 'Grass Block', color: rgb(120, 85, 58),
  top: rgb(96, 160, 74), side: rgb(110, 130, 70), bottom: rgb(120, 85, 58),
  hardness: 0.7, tool: 'shovel', drop: 'dirt', walkSound: 'grass',
});
register(ID.SAND, 'sand', {
  name: 'Sand', color: rgb(224, 210, 158), hardness: 0.5, tool: 'shovel', walkSound: 'sand',
});
register(ID.WATER, 'water', {
  name: 'Water', solid: false, transparent: true, liquid: true, opacity: 3,
  render: 'liquid', color: [0.16, 0.42, 0.74], hardness: 100, drop: null, tool: 'any',
});
register(ID.LOG, 'log', {
  name: 'Oak Log', color: rgb(102, 76, 48),
  top: rgb(160, 128, 86), bottom: rgb(160, 128, 86),
  hardness: 1.6, tool: 'axe', flammable: true, walkSound: 'wood',
});
register(ID.LEAVES, 'leaves', {
  name: 'Oak Leaves', color: rgb(64, 124, 56), transparent: true, opacity: 2,
  hardness: 0.3, tool: 'any', flammable: true, drop: 'sapling_oak', walkSound: 'grass',
});
register(ID.PLANKS, 'planks', {
  name: 'Oak Planks', color: rgb(176, 140, 86), hardness: 1.2, tool: 'axe',
  flammable: true, walkSound: 'wood',
});
register(ID.COBBLESTONE, 'cobblestone', {
  name: 'Cobblestone', color: rgb(110, 110, 114), hardness: 2.6, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.BEDROCK, 'bedrock', {
  name: 'Bedrock', color: rgb(40, 40, 46), hardness: Infinity, drop: null, tool: 'none',
});
register(ID.GRAVEL, 'gravel', {
  name: 'Gravel', color: rgb(130, 122, 118), hardness: 0.7, tool: 'shovel', walkSound: 'gravel',
});
register(ID.SNOW, 'snow', {
  name: 'Snow Block', color: rgb(238, 244, 252), hardness: 0.4, tool: 'shovel', walkSound: 'snow',
});
register(ID.ICE, 'ice', {
  name: 'Ice', color: [0.62, 0.78, 0.95], transparent: true, opacity: 3,
  hardness: 0.6, tool: 'pickaxe', drop: null, walkSound: 'stone',
});
register(ID.COAL_ORE, 'coal_ore', {
  name: 'Coal Ore', color: rgb(70, 70, 74), hardness: 3.0, tool: 'pickaxe', drop: 'coal', walkSound: 'stone',
});
register(ID.IRON_ORE, 'iron_ore', {
  name: 'Iron Ore', color: rgb(150, 132, 116), hardness: 3.2, tool: 'pickaxe', drop: 'raw_iron', walkSound: 'stone',
});
register(ID.GOLD_ORE, 'gold_ore', {
  name: 'Gold Ore', color: rgb(190, 168, 96), hardness: 3.2, tool: 'pickaxe', drop: 'raw_gold', walkSound: 'stone',
});
register(ID.DIAMOND_ORE, 'diamond_ore', {
  name: 'Diamond Ore', color: rgb(110, 200, 210), hardness: 3.6, tool: 'pickaxe', drop: 'diamond', walkSound: 'stone',
});
register(ID.GLASS, 'glass', {
  name: 'Glass', color: [0.82, 0.92, 0.98], transparent: true, opacity: 1,
  hardness: 0.4, tool: 'any', drop: null, walkSound: 'stone',
});
register(ID.GLOWSTONE, 'glowstone', {
  name: 'Glowstone', color: rgb(238, 214, 120), light: 14, hardness: 0.5, tool: 'any', walkSound: 'stone',
});
register(ID.CACTUS, 'cactus', {
  name: 'Cactus', color: rgb(72, 134, 64), transparent: true, opacity: 4,
  hardness: 0.5, tool: 'any', walkSound: 'grass',
});
register(ID.PUMPKIN, 'pumpkin', {
  name: 'Pumpkin', color: rgb(214, 130, 40), top: rgb(150, 120, 60),
  hardness: 0.9, tool: 'axe', walkSound: 'wood',
});
register(ID.CRAFTING_TABLE, 'crafting_table', {
  name: 'Crafting Table', color: rgb(150, 110, 64), top: rgb(120, 90, 56),
  hardness: 1.2, tool: 'axe', flammable: true, walkSound: 'wood',
});
register(ID.FURNACE, 'furnace', {
  name: 'Furnace', color: rgb(96, 96, 100), top: rgb(80, 80, 84),
  hardness: 2.6, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.BRICKS, 'bricks', {
  name: 'Bricks', color: rgb(150, 78, 64), hardness: 2.4, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.MOSSY_COBBLE, 'mossy_cobble', {
  name: 'Mossy Cobblestone', color: rgb(92, 108, 84), hardness: 2.6, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.CLAY, 'clay', {
  name: 'Clay', color: rgb(160, 164, 176), hardness: 0.7, tool: 'shovel', drop: 'clay_ball', walkSound: 'gravel',
});
register(ID.SANDSTONE, 'sandstone', {
  name: 'Sandstone', color: rgb(214, 198, 146), top: rgb(224, 208, 156),
  hardness: 1.4, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.BIRCH_LOG, 'birch_log', {
  name: 'Birch Log', color: rgb(214, 210, 198), top: rgb(180, 168, 132), bottom: rgb(180, 168, 132),
  hardness: 1.6, tool: 'axe', flammable: true, walkSound: 'wood',
});
register(ID.BIRCH_LEAVES, 'birch_leaves', {
  name: 'Birch Leaves', color: rgb(120, 158, 86), transparent: true, opacity: 2,
  hardness: 0.3, tool: 'any', flammable: true, drop: 'sapling_birch', walkSound: 'grass',
});
register(ID.PINE_LOG, 'pine_log', {
  name: 'Pine Log', color: rgb(82, 60, 40), top: rgb(120, 96, 64), bottom: rgb(120, 96, 64),
  hardness: 1.6, tool: 'axe', flammable: true, walkSound: 'wood',
});
register(ID.PINE_LEAVES, 'pine_leaves', {
  name: 'Pine Needles', color: rgb(40, 92, 64), transparent: true, opacity: 2,
  hardness: 0.3, tool: 'any', flammable: true, drop: 'sapling_pine', walkSound: 'grass',
});
register(ID.FLOWER_RED, 'flower_red', {
  name: 'Poppy', solid: false, transparent: true, opacity: 0, render: 'cross',
  color: rgb(214, 60, 60), hardness: 0, tool: 'any', walkSound: 'grass',
});
register(ID.FLOWER_YELLOW, 'flower_yellow', {
  name: 'Dandelion', solid: false, transparent: true, opacity: 0, render: 'cross',
  color: rgb(230, 206, 70), hardness: 0, tool: 'any', walkSound: 'grass',
});
register(ID.TALL_GRASS, 'tall_grass', {
  name: 'Tall Grass', solid: false, transparent: true, opacity: 0, render: 'cross',
  color: rgb(96, 156, 72), hardness: 0, tool: 'any', drop: null, walkSound: 'grass',
});
register(ID.MUSHROOM_RED, 'mushroom_red', {
  name: 'Red Mushroom', solid: false, transparent: true, opacity: 0, render: 'cross',
  color: rgb(206, 70, 64), hardness: 0, tool: 'any', walkSound: 'grass',
});
register(ID.TORCH, 'torch', {
  name: 'Torch', solid: false, transparent: true, opacity: 0, render: 'cross',
  color: rgb(248, 214, 120), light: 13, hardness: 0, tool: 'any', walkSound: 'wood',
});
register(ID.OBSIDIAN, 'obsidian', {
  name: 'Obsidian', color: rgb(28, 24, 40), hardness: 8.0, tool: 'pickaxe', walkSound: 'stone',
});
register(ID.EMERALD_ORE, 'emerald_ore', {
  name: 'Emerald Ore', color: rgb(70, 180, 110), hardness: 3.4, tool: 'pickaxe', drop: 'emerald', walkSound: 'stone',
});
register(ID.REDSTONE_ORE, 'redstone_ore', {
  name: 'Redstone Ore', color: rgb(150, 60, 60), light: 4, hardness: 3.2, tool: 'pickaxe', drop: 'redstone', walkSound: 'stone',
});
register(ID.LAVA, 'lava', {
  // A liquid that lights its surroundings: the flood-fill picks the emission
  // up automatically, so pools glow with no dedicated light-source code.
  name: 'Lava', solid: false, transparent: true, liquid: true, opacity: 15,
  light: 13, render: 'liquid', color: [0.86, 0.32, 0.06], hardness: 100,
  drop: null, tool: 'any', walkSound: 'stone',
});
register(ID.LANTERN, 'lantern', {
  name: 'Lantern', color: rgb(240, 220, 150), light: 15, transparent: true, opacity: 2,
  hardness: 0.5, tool: 'any', walkSound: 'stone',
});

// ---- name → def lookup ---------------------------------------------------
const BY_KEY = new Map();
for (const d of REG) if (d) BY_KEY.set(d.key, d);

// ---- public API ----------------------------------------------------------
export const Blocks = {
  ID,
  FACES,
  FACE_SHADE,
  count: REG.length,

  get(id) { return REG[id] || REG[ID.AIR]; },
  byKey(key) { return BY_KEY.get(key) || null; },
  all() { return REG.filter(Boolean); },

  isSolid(id) { return REG[id] ? REG[id].solid : false; },
  isTransparent(id) { return REG[id] ? REG[id].transparent : true; },
  isLiquid(id) { return REG[id] ? REG[id].liquid : false; },
  isAir(id) { return id === ID.AIR; },
  light(id) { return REG[id] ? REG[id].light : 0; },
  opacity(id) { return REG[id] ? REG[id].opacity : 0; },
  renderType(id) { return REG[id] ? REG[id].render : 'air'; },
  hardness(id) { return REG[id] ? REG[id].hardness : 1; },

  // Which face color to use. face is 0..5 per the convention above.
  faceColor(id, face) {
    const d = REG[id];
    if (!d) return [1, 0, 1];
    if (face === 2) return d.top || d.color;       // +Y
    if (face === 3) return d.bottom || d.color;    // -Y
    return d.side || d.color;                       // sides
  },

  // A representative color for UI (item icons, particles).
  iconColor(id) {
    const d = REG[id];
    if (!d) return [1, 0, 1];
    return d.top || d.color;
  },

  // Should a face between block `id` (the one being drawn) and neighbour
  // `neighborId` be rendered? We cull a face when the neighbour is an opaque
  // cube, and also when two identical transparent cubes meet (e.g. glass↔glass,
  // water↔water) so we don't draw internal surfaces.
  shouldRenderFace(id, neighborId) {
    if (neighborId === ID.AIR) return true;
    const nd = REG[neighborId];
    if (!nd) return true;
    if (!nd.transparent && nd.render === 'cube') return false; // opaque neighbour hides us
    if (nd.render === 'cross' || nd.render === 'air') return true;
    // Two identical transparent blocks: hide the shared face.
    if (id === neighborId) return false;
    return true;
  },
};

export default Blocks;
