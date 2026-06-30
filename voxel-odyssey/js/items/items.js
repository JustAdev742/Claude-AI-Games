/* =========================================================================
   items.js — the item registry + a shared canvas icon renderer.

   An ItemStack stored in the inventory is the small shape: { id, count }
   where `id` is an item key string (e.g. 'cobblestone', 'iron_pickaxe').

   Item definition fields:
     key        unique string id
     name       display name
     stack      max stack size (default 64; tools = 1)
     category   'block' | 'material' | 'tool' | 'food'
     blockId    if placeable, the block id this item places (else undefined)
     tool       { type:'pickaxe'|'axe'|'shovel'|'sword', tier:1..4, power, durability }
     attack     melee damage in HP when held (default 1)
     food       HP restored when eaten (food items)
     desc       short tooltip description
     icon       { kind:'block', id } | { kind:'shape', shape, color, color2 }
   ========================================================================= */

import Blocks, { ID } from '../world/blocks.js';
import { rgb, clamp01 } from '../core/utils.js';

const REG = new Map();   // key -> def
const ORDER = [];        // creative-menu ordering

function add(key, d) {
  const def = Object.assign({
    key, name: key, stack: 64, category: 'material',
    blockId: undefined, tool: null, attack: 1, food: 0, desc: '',
    icon: null,
  }, d);
  if (!def.icon) {
    def.icon = def.blockId !== undefined
      ? { kind: 'block', id: def.blockId }
      : { kind: 'shape', shape: 'lump', color: rgb(180, 180, 180) };
  }
  REG.set(key, def);
  ORDER.push(key);
  return def;
}

// Register a placeable block item that mirrors a block definition.
function addBlockItem(blockId, extra = {}) {
  const b = Blocks.get(blockId);
  add(b.key, Object.assign({
    name: b.name, category: 'block', blockId, stack: 64,
    icon: { kind: 'block', id: blockId },
  }, extra));
}

// ---- placeable block items ----------------------------------------------
[
  ID.STONE, ID.DIRT, ID.GRASS, ID.SAND, ID.COBBLESTONE, ID.GRAVEL, ID.SNOW,
  ID.GLASS, ID.GLOWSTONE, ID.CACTUS, ID.PUMPKIN, ID.CRAFTING_TABLE, ID.FURNACE,
  ID.BRICKS, ID.MOSSY_COBBLE, ID.SANDSTONE, ID.OBSIDIAN, ID.LANTERN, ID.ICE,
  ID.LOG, ID.PLANKS, ID.LEAVES, ID.BIRCH_LOG, ID.BIRCH_LEAVES, ID.PINE_LOG, ID.PINE_LEAVES,
  ID.FLOWER_RED, ID.FLOWER_YELLOW, ID.TALL_GRASS, ID.MUSHROOM_RED, ID.TORCH, ID.CLAY,
].forEach((id) => addBlockItem(id));

// ---- raw materials -------------------------------------------------------
add('coal', { name: 'Coal', desc: 'Fuel and torches.', icon: { kind: 'shape', shape: 'coal', color: rgb(40, 40, 44) } });
add('charcoal', { name: 'Charcoal', desc: 'Smelted wood fuel.', icon: { kind: 'shape', shape: 'coal', color: rgb(54, 50, 46) } });
add('raw_iron', { name: 'Raw Iron', desc: 'Smelt into an iron ingot.', icon: { kind: 'shape', shape: 'lump', color: rgb(196, 170, 150) } });
add('raw_gold', { name: 'Raw Gold', desc: 'Smelt into a gold ingot.', icon: { kind: 'shape', shape: 'lump', color: rgb(206, 180, 110) } });
add('iron_ingot', { name: 'Iron Ingot', desc: 'A sturdy crafting metal.', icon: { kind: 'shape', shape: 'ingot', color: rgb(214, 214, 220) } });
add('gold_ingot', { name: 'Gold Ingot', desc: 'Shiny but soft.', icon: { kind: 'shape', shape: 'ingot', color: rgb(238, 206, 110) } });
add('diamond', { name: 'Diamond', desc: 'For the finest tools.', icon: { kind: 'shape', shape: 'gem', color: rgb(120, 224, 232) } });
add('emerald', { name: 'Emerald', desc: 'A villager would love this.', icon: { kind: 'shape', shape: 'gem', color: rgb(80, 200, 120) } });
add('redstone', { name: 'Redstone Dust', desc: 'Faintly glowing dust.', icon: { kind: 'shape', shape: 'dust', color: rgb(200, 50, 50) } });
add('clay_ball', { name: 'Clay Ball', desc: 'Smelt into brick.', icon: { kind: 'shape', shape: 'lump', color: rgb(170, 174, 186) } });
add('brick', { name: 'Brick', desc: 'Four make a brick block.', icon: { kind: 'shape', shape: 'ingot', color: rgb(170, 92, 76) } });
add('stick', { name: 'Stick', desc: 'Handles for every tool.', icon: { kind: 'shape', shape: 'stick', color: rgb(150, 112, 64) } });
add('string', { name: 'String', desc: 'Dropped by spiders.', icon: { kind: 'shape', shape: 'dust', color: rgb(220, 220, 220) } });
add('bone', { name: 'Bone', desc: 'Rattles when shaken.', icon: { kind: 'shape', shape: 'stick', color: rgb(232, 230, 214) } });
add('leather', { name: 'Leather', desc: 'Tough animal hide.', icon: { kind: 'shape', shape: 'lump', color: rgb(150, 100, 60) } });
add('feather', { name: 'Feather', desc: 'Light as air.', icon: { kind: 'shape', shape: 'stick', color: rgb(240, 240, 245) } });
add('gunpowder', { name: 'Gunpowder', desc: 'Goes boom.', icon: { kind: 'shape', shape: 'dust', color: rgb(90, 90, 96) } });
add('sapling_oak', { name: 'Oak Sapling', category: 'material', desc: 'A tiny tree.', icon: { kind: 'shape', shape: 'sapling', color: rgb(72, 140, 60) } });
add('sapling_birch', { name: 'Birch Sapling', category: 'material', desc: 'A tiny tree.', icon: { kind: 'shape', shape: 'sapling', color: rgb(120, 160, 90) } });
add('sapling_pine', { name: 'Pine Sapling', category: 'material', desc: 'A tiny tree.', icon: { kind: 'shape', shape: 'sapling', color: rgb(48, 100, 70) } });

// ---- food ----------------------------------------------------------------
add('apple', { name: 'Apple', category: 'food', food: 4, desc: 'Restores 4 HP.', icon: { kind: 'shape', shape: 'apple', color: rgb(210, 50, 50) } });
add('bread', { name: 'Bread', category: 'food', food: 6, desc: 'Restores 6 HP.', icon: { kind: 'shape', shape: 'bread', color: rgb(196, 150, 80) } });
add('wheat', { name: 'Wheat', category: 'material', desc: 'Bake into bread.', icon: { kind: 'shape', shape: 'stick', color: rgb(214, 190, 90) } });
add('raw_meat', { name: 'Raw Meat', category: 'food', food: 3, desc: 'Better cooked.', icon: { kind: 'shape', shape: 'meat', color: rgb(214, 120, 120) } });
add('cooked_meat', { name: 'Cooked Meat', category: 'food', food: 8, desc: 'Restores 8 HP.', icon: { kind: 'shape', shape: 'meat', color: rgb(150, 96, 60) } });
add('mushroom_stew', { name: 'Mushroom Stew', category: 'food', food: 8, stack: 1, desc: 'Hearty bowl.', icon: { kind: 'shape', shape: 'bowl', color: rgb(150, 90, 60) } });

// ---- tools ---------------------------------------------------------------
const TIERS = {
  wood: { tier: 1, power: 2, dur: 60, mat: 'planks', color: rgb(160, 120, 72) },
  stone: { tier: 2, power: 4, dur: 132, mat: 'cobblestone', color: rgb(130, 130, 134) },
  iron: { tier: 3, power: 6, dur: 250, mat: 'iron_ingot', color: rgb(214, 214, 220) },
  gold: { tier: 3, power: 5, dur: 90, mat: 'gold_ingot', color: rgb(238, 206, 110) },
  diamond: { tier: 4, power: 9, dur: 1561, mat: 'diamond', color: rgb(120, 224, 232) },
};
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword'];
const TOOL_LABEL = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword' };

for (const matName of Object.keys(TIERS)) {
  const t = TIERS[matName];
  for (const kind of TOOL_KINDS) {
    const key = `${matName}_${kind}`;
    const attack = kind === 'sword' ? 2 + t.tier + 1 : 1 + Math.floor(t.tier / 2);
    add(key, {
      name: `${cap(matName)} ${TOOL_LABEL[kind]}`,
      category: 'tool', stack: 1,
      tool: { type: kind, tier: t.tier, power: t.power, durability: t.dur },
      attack,
      desc: kind === 'sword' ? `Deals ${attack} damage.` : `Mines faster (power ${t.power}).`,
      icon: { kind: 'shape', shape: kind, color: t.color, color2: rgb(150, 112, 64) },
    });
  }
}

// Misc craftables / utilities
add('bucket', { name: 'Bucket', stack: 16, desc: 'Carries water.', icon: { kind: 'shape', shape: 'bucket', color: rgb(190, 190, 196) } });
add('water_bucket', { name: 'Water Bucket', stack: 1, desc: 'Place to make water.', blockId: ID.WATER, icon: { kind: 'shape', shape: 'bucket', color: rgb(60, 120, 200) } });
add('bowl', { name: 'Bowl', stack: 16, desc: 'For stew.', icon: { kind: 'shape', shape: 'bowl', color: rgb(150, 110, 64) } });

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- public API ----------------------------------------------------------
export const Items = {
  get(key) { return REG.get(key) || null; },
  has(key) { return REG.has(key); },
  all() { return ORDER.map((k) => REG.get(k)); },
  keys() { return ORDER.slice(); },
  stackSize(key) { const d = REG.get(key); return d ? d.stack : 64; },
  isPlaceable(key) { const d = REG.get(key); return !!d && d.blockId !== undefined; },
  isTool(key) { const d = REG.get(key); return !!d && d.category === 'tool'; },
  isFood(key) { const d = REG.get(key); return !!d && d.category === 'food'; },
  blockId(key) { const d = REG.get(key); return d ? d.blockId : undefined; },
  name(key) { const d = REG.get(key); return d ? d.name : key; },
  attack(key) { const d = REG.get(key); return d ? d.attack : 1; },

  // The drop produced by mining a block, as an item key (or null).
  dropFor(blockId) {
    const b = Blocks.get(blockId);
    return b.drop || null;
  },

  drawIcon,
};

/* =========================================================================
   Shared icon renderer — draws an item into a 2D canvas context.
   Block items render as a chunky isometric cube; tools/materials use simple
   vector shapes. Every UI surface uses this so icons look identical.
   ========================================================================= */
export function drawIcon(ctx, itemKey, size) {
  const def = REG.get(itemKey);
  ctx.clearRect(0, 0, size, size);
  if (!def) { drawMissing(ctx, size); return; }
  if (def.icon.kind === 'block') drawBlockIcon(ctx, def.icon.id, size);
  else drawShapeIcon(ctx, def.icon, size);
}

function css(c, a = 1) {
  return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
}
function shade(c, s) { return [clamp01(c[0] * s), clamp01(c[1] * s), clamp01(c[2] * s)]; }

function drawMissing(ctx, size) {
  ctx.fillStyle = '#f0f'; ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  ctx.fillStyle = '#000'; ctx.fillRect(size / 2, 0, size / 2, size / 2);
  ctx.fillRect(0, size / 2, size / 2, size / 2);
}

function drawBlockIcon(ctx, blockId, size) {
  const b = Blocks.get(blockId);
  // Flat sprite for cross-type blocks (flowers, torch, grass tuft).
  if (b.render === 'cross' || b.render === 'air') {
    drawCrossSprite(ctx, b, size);
    return;
  }
  const top = b.top || b.color;
  const side = b.side || b.color;
  const s = size, cx = s * 0.5;
  const w = s * 0.42;            // half-width of the cube
  const h = s * 0.24;            // iso vertical offset
  const topY = s * 0.16;
  // top face (rhombus)
  ctx.fillStyle = css(top);
  ctx.beginPath();
  ctx.moveTo(cx, topY);
  ctx.lineTo(cx + w, topY + h);
  ctx.lineTo(cx, topY + 2 * h);
  ctx.lineTo(cx - w, topY + h);
  ctx.closePath(); ctx.fill();
  // left face
  ctx.fillStyle = css(shade(side, 0.7));
  ctx.beginPath();
  ctx.moveTo(cx - w, topY + h);
  ctx.lineTo(cx, topY + 2 * h);
  ctx.lineTo(cx, topY + 2 * h + s * 0.34);
  ctx.lineTo(cx - w, topY + h + s * 0.34);
  ctx.closePath(); ctx.fill();
  // right face
  ctx.fillStyle = css(shade(side, 0.5));
  ctx.beginPath();
  ctx.moveTo(cx + w, topY + h);
  ctx.lineTo(cx, topY + 2 * h);
  ctx.lineTo(cx, topY + 2 * h + s * 0.34);
  ctx.lineTo(cx + w, topY + h + s * 0.34);
  ctx.closePath(); ctx.fill();
  // subtle outline
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.stroke();
}

function drawCrossSprite(ctx, b, size) {
  const c = b.color;
  const s = size;
  ctx.fillStyle = css(shade(c, 0.6));
  // stem
  ctx.fillRect(s * 0.46, s * 0.45, s * 0.08, s * 0.4);
  // bloom
  ctx.fillStyle = css(c);
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.38, s * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawShapeIcon(ctx, icon, size) {
  const s = size;
  const c = icon.color, c2 = icon.color2 || shade(c, 0.6);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (icon.shape) {
    case 'pickaxe': drawTool(ctx, s, c, 'pickaxe'); break;
    case 'axe': drawTool(ctx, s, c, 'axe'); break;
    case 'shovel': drawTool(ctx, s, c, 'shovel'); break;
    case 'sword': drawSword(ctx, s, c); break;
    case 'ingot': drawIngot(ctx, s, c); break;
    case 'gem': drawGem(ctx, s, c); break;
    case 'dust': drawDust(ctx, s, c); break;
    case 'coal': drawCoal(ctx, s, c); break;
    case 'lump': drawLump(ctx, s, c); break;
    case 'stick': drawStick(ctx, s, c); break;
    case 'apple': drawApple(ctx, s, c); break;
    case 'bread': drawBread(ctx, s, c); break;
    case 'meat': drawMeat(ctx, s, c); break;
    case 'bowl': drawBowl(ctx, s, c); break;
    case 'bucket': drawBucket(ctx, s, c); break;
    case 'sapling': drawSapling(ctx, s, c); break;
    default: drawLump(ctx, s, c);
  }
}

function handle(ctx, s) {
  ctx.strokeStyle = css(rgb(150, 112, 64));
  ctx.lineWidth = s * 0.09;
  ctx.beginPath();
  ctx.moveTo(s * 0.3, s * 0.78);
  ctx.lineTo(s * 0.62, s * 0.32);
  ctx.stroke();
}
function drawTool(ctx, s, c, kind) {
  handle(ctx, s);
  ctx.fillStyle = css(c);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = Math.max(1, s * 0.02);
  if (kind === 'pickaxe') {
    ctx.beginPath();
    ctx.moveTo(s * 0.3, s * 0.26);
    ctx.quadraticCurveTo(s * 0.62, s * 0.18, s * 0.84, s * 0.32);
    ctx.lineTo(s * 0.78, s * 0.4);
    ctx.quadraticCurveTo(s * 0.6, s * 0.3, s * 0.36, s * 0.36);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (kind === 'axe') {
    ctx.beginPath();
    ctx.moveTo(s * 0.58, s * 0.2);
    ctx.quadraticCurveTo(s * 0.86, s * 0.26, s * 0.8, s * 0.46);
    ctx.lineTo(s * 0.6, s * 0.4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else { // shovel
    ctx.beginPath();
    ctx.moveTo(s * 0.62, s * 0.22);
    ctx.lineTo(s * 0.8, s * 0.34);
    ctx.lineTo(s * 0.7, s * 0.5);
    ctx.lineTo(s * 0.52, s * 0.38);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
function drawSword(ctx, s, c) {
  ctx.strokeStyle = css(rgb(150, 112, 64));
  ctx.lineWidth = s * 0.12;
  ctx.beginPath(); ctx.moveTo(s * 0.3, s * 0.72); ctx.lineTo(s * 0.4, s * 0.62); ctx.stroke();
  ctx.strokeStyle = css(rgb(110, 90, 60));
  ctx.lineWidth = s * 0.07;
  ctx.beginPath(); ctx.moveTo(s * 0.28, s * 0.56); ctx.lineTo(s * 0.46, s * 0.74); ctx.stroke();
  ctx.fillStyle = css(c);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.beginPath();
  ctx.moveTo(s * 0.4, s * 0.62);
  ctx.lineTo(s * 0.74, s * 0.22);
  ctx.lineTo(s * 0.82, s * 0.3);
  ctx.lineTo(s * 0.48, s * 0.7);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}
function drawIngot(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.beginPath();
  ctx.moveTo(s * 0.26, s * 0.6); ctx.lineTo(s * 0.34, s * 0.42);
  ctx.lineTo(s * 0.74, s * 0.42); ctx.lineTo(s * 0.8, s * 0.6);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = css(shade(c, 1.25), 0.6);
  ctx.fillRect(s * 0.36, s * 0.45, s * 0.3, s * 0.05);
}
function drawGem(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.22); ctx.lineTo(s * 0.74, s * 0.42);
  ctx.lineTo(s * 0.5, s * 0.78); ctx.lineTo(s * 0.26, s * 0.42);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.22); ctx.lineTo(s * 0.6, s * 0.42); ctx.lineTo(s * 0.4, s * 0.42); ctx.closePath(); ctx.fill();
}
function drawDust(ctx, s, c) {
  ctx.fillStyle = css(c);
  for (let i = 0; i < 7; i++) {
    const a = i * 1.3, r = s * 0.16;
    const x = s * 0.5 + Math.cos(a) * r, y = s * 0.55 + Math.sin(a) * r * 0.8;
    ctx.beginPath(); ctx.arc(x, y, s * 0.06, 0, Math.PI * 2); ctx.fill();
  }
}
function drawCoal(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath();
  ctx.moveTo(s * 0.3, s * 0.4); ctx.lineTo(s * 0.5, s * 0.3); ctx.lineTo(s * 0.72, s * 0.42);
  ctx.lineTo(s * 0.66, s * 0.68); ctx.lineTo(s * 0.38, s * 0.7);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(s * 0.42, s * 0.44, s * 0.08, s * 0.08);
}
function drawLump(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.54, s * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.arc(s * 0.43, s * 0.46, s * 0.06, 0, Math.PI * 2); ctx.fill();
}
function drawStick(ctx, s, c) {
  ctx.strokeStyle = css(c); ctx.lineWidth = s * 0.1;
  ctx.beginPath(); ctx.moveTo(s * 0.34, s * 0.76); ctx.lineTo(s * 0.66, s * 0.26); ctx.stroke();
}
function drawApple(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath(); ctx.arc(s * 0.42, s * 0.54, s * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(s * 0.58, s * 0.54, s * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = css(rgb(110, 70, 40)); ctx.lineWidth = s * 0.04;
  ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.4); ctx.lineTo(s * 0.54, s * 0.3); ctx.stroke();
  ctx.fillStyle = css(rgb(80, 160, 70));
  ctx.beginPath(); ctx.ellipse(s * 0.6, s * 0.32, s * 0.06, s * 0.03, -0.6, 0, Math.PI * 2); ctx.fill();
}
function drawBread(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.55, s * 0.26, s * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css(shade(c, 0.7)); ctx.lineWidth = s * 0.03;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath(); ctx.moveTo(s * 0.5 + i * s * 0.12, s * 0.44); ctx.lineTo(s * 0.5 + i * s * 0.12, s * 0.66); ctx.stroke();
  }
}
function drawMeat(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath(); ctx.ellipse(s * 0.52, s * 0.55, s * 0.22, s * 0.16, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = css(rgb(240, 240, 240));
  ctx.beginPath(); ctx.arc(s * 0.3, s * 0.72, s * 0.06, 0, Math.PI * 2); ctx.fill();
}
function drawBowl(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.52, s * 0.26, 0, Math.PI); ctx.fill();
  ctx.fillStyle = css(rgb(190, 120, 70));
  ctx.beginPath(); ctx.ellipse(s * 0.5, s * 0.52, s * 0.24, s * 0.07, 0, 0, Math.PI * 2); ctx.fill();
}
function drawBucket(ctx, s, c) {
  ctx.fillStyle = css(c);
  ctx.beginPath();
  ctx.moveTo(s * 0.32, s * 0.4); ctx.lineTo(s * 0.68, s * 0.4);
  ctx.lineTo(s * 0.6, s * 0.74); ctx.lineTo(s * 0.4, s * 0.74);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = css(shade(c, 0.7)); ctx.lineWidth = s * 0.04;
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.4, s * 0.16, Math.PI, 0); ctx.stroke();
}
function drawSapling(ctx, s, c) {
  ctx.strokeStyle = css(rgb(120, 90, 56)); ctx.lineWidth = s * 0.06;
  ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.78); ctx.lineTo(s * 0.5, s * 0.5); ctx.stroke();
  ctx.fillStyle = css(c);
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.42, s * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(s * 0.38, s * 0.5, s * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(s * 0.62, s * 0.5, s * 0.1, 0, Math.PI * 2); ctx.fill();
}

export default Items;
