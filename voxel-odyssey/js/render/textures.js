/* =========================================================================
   textures.js — the built-in procedural block texture set.

   The game shipped with flat per-face colours, which read as clean low-poly
   but nothing like Minecraft. Rather than bundle someone else's texture pack
   (a licensing problem, and a download the game doesn't otherwise need) we
   synthesize a complete 16x16 set at startup. Everything here is original
   pixel art expressed as code: a base colour from the block registry, plus a
   procedural pattern chosen to read correctly at block scale.

   Anything generated here can be overridden per-texture by a resource pack —
   see resourcepack.js. The pack only has to supply the textures it wants to
   change; the rest fall back to these.

   All generators are deterministic (seeded per texture name), so the same
   world looks identical across sessions and machines.
   ========================================================================= */

import Blocks from '../world/blocks.js';
import { makeCanvas, BLOCK_TEXTURES } from './atlas.js';

/* Small deterministic PRNG (mulberry32) — same family the worldgen uses. */
function rngFor(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Registry colour for a block key, as 0..255 RGB. */
function baseColor(key, fallback = [128, 128, 128]) {
  const d = Blocks.byKey(key);
  if (!d || !d.color) return fallback;
  return [
    Math.round(d.color[0] * 255),
    Math.round(d.color[1] * 255),
    Math.round(d.color[2] * 255),
  ];
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/* A drawing surface: an RGBA buffer plus helpers, converted to a canvas at
   the end. Working on raw bytes keeps the generators simple and exact —
   canvas fill calls would antialias and blur the pixel art. */
class Tile {
  constructor(size, seed) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
    this.rand = rngFor(seed);
  }

  set(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    this.data[i] = clamp255(r);
    this.data[i + 1] = clamp255(g);
    this.data[i + 2] = clamp255(b);
    this.data[i + 3] = clamp255(a);
  }

  get(x, y) {
    const i = (y * this.size + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  fill(r, g, b, a = 255) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, r, g, b, a);
  }

  /* Per-pixel brightness jitter — the workhorse that turns a flat colour into
     something that reads as a material at block scale. */
  mottle(rgb, amount, alpha = 255) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = (this.rand() - 0.5) * 2 * amount;
        this.set(x, y, rgb[0] + rgb[0] * d, rgb[1] + rgb[1] * d, rgb[2] + rgb[2] * d, alpha);
      }
    }
  }

  /* Scattered darker/lighter clumps, used for gravel, ore matrix, dirt. */
  speckle(count, rgb, spread, sizeRange = [1, 2]) {
    for (let i = 0; i < count; i++) {
      const cx = (this.rand() * this.size) | 0;
      const cy = (this.rand() * this.size) | 0;
      const r = sizeRange[0] + ((this.rand() * (sizeRange[1] - sizeRange[0] + 1)) | 0);
      const d = (this.rand() - 0.5) * 2 * spread;
      for (let y = cy; y < cy + r; y++) {
        for (let x = cx; x < cx + r; x++) {
          const px = ((x % this.size) + this.size) % this.size;
          const py = ((y % this.size) + this.size) % this.size;
          this.set(px, py, rgb[0] * (1 + d), rgb[1] * (1 + d), rgb[2] * (1 + d));
        }
      }
    }
  }

  /* Horizontal band, used for grass overhang and snow edges. */
  band(y0, y1, rgb, jitter = 0.1) {
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = (this.rand() - 0.5) * 2 * jitter;
        this.set(x, y, rgb[0] * (1 + d), rgb[1] * (1 + d), rgb[2] * (1 + d));
      }
    }
  }

  outline(rgb, alpha = 255) {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(i, 0, rgb[0], rgb[1], rgb[2], alpha);
      this.set(i, s - 1, rgb[0], rgb[1], rgb[2], alpha);
      this.set(0, i, rgb[0], rgb[1], rgb[2], alpha);
      this.set(s - 1, i, rgb[0], rgb[1], rgb[2], alpha);
    }
  }

  toCanvas() {
    const c = makeCanvas(this.size, this.size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.size, this.size);
    img.data.set(this.data);
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

/* ---- individual texture recipes ----------------------------------------
   Each returns a Tile. Sizes are relative to `s` so a higher-resolution
   built-in set is a one-line change. */

const RECIPES = {
  stone: (t) => { t.mottle(baseColor('stone'), 0.10); t.speckle(10, baseColor('stone'), 0.14); },

  cobblestone: (t) => {
    const c = baseColor('cobblestone');
    t.mottle(c, 0.06);
    // Irregular stones separated by darker mortar lines.
    const s = t.size, cell = Math.max(3, (s / 4) | 0);
    for (let by = 0; by < s; by += cell) {
      for (let bx = 0; bx < s; bx += cell) {
        const off = ((by / cell) | 0) % 2 ? (cell / 2) | 0 : 0;
        const x0 = bx + off, y0 = by;
        const d = (t.rand() - 0.5) * 0.3;
        for (let y = y0 + 1; y < y0 + cell - 1; y++) {
          for (let x = x0 + 1; x < x0 + cell - 1; x++) {
            t.set(x % s, y % s, c[0] * (1 + d), c[1] * (1 + d), c[2] * (1 + d));
          }
        }
      }
    }
  },

  mossy_cobble: (t) => {
    RECIPES.cobblestone(t);
    // Moss has to actually dominate, or the block is indistinguishable from
    // plain cobblestone at play distance — which matters, since they are
    // different crafting ingredients.
    const moss = [78, 116, 54];
    const s = t.size;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        // Clumped rather than uniform: moss grows in patches, and a uniform
        // green wash just reads as "green stone".
        const clump = Math.sin(x * 1.1) * Math.cos(y * 0.9) + t.rand() * 0.8;
        if (clump < 0.15) continue;
        const p = t.get(x, y);
        const d = (t.rand() - 0.5) * 0.3;
        t.set(x, y,
          p[0] * 0.35 + moss[0] * 0.75 * (1 + d),
          p[1] * 0.35 + moss[1] * 0.85 * (1 + d),
          p[2] * 0.35 + moss[2] * 0.75 * (1 + d));
      }
    }
  },

  dirt: (t) => { t.mottle(baseColor('dirt'), 0.16); t.speckle(14, baseColor('dirt'), 0.3); },

  grass_top: (t) => {
    const g = baseColor('grass');
    const top = Blocks.byKey('grass') && Blocks.byKey('grass').top;
    const c = top ? [top[0] * 255, top[1] * 255, top[2] * 255] : g;
    t.mottle(c, 0.17);
    t.speckle(12, c, 0.22, [1, 1]);
  },

  grass_side: (t) => {
    const s = t.size;
    RECIPES.dirt(t);
    // Grass creeping down over the dirt, with a ragged edge so the seam
    // between the green cap and the soil doesn't read as a straight line.
    const top = Blocks.byKey('grass') && Blocks.byKey('grass').top;
    const green = top ? [top[0] * 255, top[1] * 255, top[2] * 255] : [106, 170, 80];
    const lip = Math.max(2, (s * 0.22) | 0);
    for (let x = 0; x < s; x++) {
      const drop = lip + ((t.rand() * 3) | 0);
      for (let y = 0; y < drop; y++) {
        const d = (t.rand() - 0.5) * 0.24;
        t.set(x, y, green[0] * (1 + d), green[1] * (1 + d), green[2] * (1 + d));
      }
    }
  },

  sand: (t) => { t.mottle(baseColor('sand'), 0.09); t.speckle(18, baseColor('sand'), 0.12, [1, 1]); },

  gravel: (t) => { t.mottle(baseColor('gravel'), 0.14); t.speckle(22, baseColor('gravel'), 0.34, [1, 3]); },

  clay: (t) => t.mottle(baseColor('clay'), 0.08),

  bedrock: (t) => { t.mottle([60, 60, 64], 0.35); t.speckle(20, [45, 45, 50], 0.5, [1, 3]); },

  obsidian: (t) => {
    t.mottle(baseColor('obsidian', [24, 16, 38]), 0.28);
    // A few brighter facets so it reads as glassy rather than a black hole.
    t.speckle(6, [70, 50, 110], 0.4, [1, 2]);
  },

  snow: (t) => t.mottle([245, 248, 252], 0.05),

  snow_side: (t) => {
    RECIPES.dirt(t);
    t.band(0, Math.max(2, (t.size * 0.28) | 0), [245, 248, 252], 0.05);
  },

  ice: (t) => {
    t.mottle(baseColor('ice'), 0.09, 200);
    // Faint fracture lines.
    const s = t.size;
    for (let i = 0; i < 3; i++) {
      let x = (t.rand() * s) | 0;
      for (let y = 0; y < s; y++) {
        t.set(x, y, 235, 245, 255, 210);
        x += (t.rand() * 3 | 0) - 1;
      }
    }
  },

  water: (t) => {
    const c = baseColor('water');
    t.mottle(c, 0.07, 255);
    // Broad horizontal ripples — subtle, since water also moves in the shader.
    const s = t.size;
    for (let y = 0; y < s; y++) {
      const w = Math.sin((y / s) * Math.PI * 3) * 0.08;
      for (let x = 0; x < s; x++) {
        const p = t.get(x, y);
        t.set(x, y, p[0] * (1 + w), p[1] * (1 + w), p[2] * (1 + w), 255);
      }
    }
  },

  log_side: (t) => makeBark(t, baseColor('log', [104, 78, 48])),
  birch_log_side: (t) => makeBark(t, [216, 214, 206], [90, 90, 84]),
  pine_log_side: (t) => makeBark(t, [86, 62, 42]),

  log_top: (t) => makeRings(t, baseColor('log', [104, 78, 48])),
  birch_log_top: (t) => makeRings(t, [216, 214, 206]),

  planks: (t) => {
    const c = baseColor('planks', [162, 130, 78]);
    t.mottle(c, 0.08);
    const s = t.size, rows = 4, h = s / rows;
    for (let r = 0; r < rows; r++) {
      const y = Math.round(r * h);
      // Seam between planks.
      for (let x = 0; x < s; x++) t.set(x, y, c[0] * 0.62, c[1] * 0.62, c[2] * 0.62);
      // A nail/knot detail, offset per row so rows don't line up.
      const kx = ((r * 5 + 2) % s);
      t.set(kx, y + 2, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7);
    }
  },

  bricks: (t) => {
    const c = baseColor('bricks', [150, 82, 62]);
    const mortar = [188, 182, 176];
    t.fill(mortar[0], mortar[1], mortar[2]);
    const s = t.size, bh = Math.max(3, (s / 4) | 0), bw = Math.max(6, (s / 2) | 0);
    for (let row = 0, y = 0; y < s; row++, y += bh) {
      const off = row % 2 ? -((bw / 2) | 0) : 0;
      for (let x = off; x < s; x += bw) {
        const d = (t.rand() - 0.5) * 0.16;
        for (let yy = y; yy < y + bh - 1 && yy < s; yy++) {
          for (let xx = x; xx < x + bw - 1; xx++) {
            if (xx < 0 || xx >= s) continue;
            t.set(xx, yy, c[0] * (1 + d), c[1] * (1 + d), c[2] * (1 + d));
          }
        }
      }
    }
  },

  sandstone_top: (t) => t.mottle(baseColor('sandstone', [220, 208, 160]), 0.06),
  sandstone_side: (t) => {
    const c = baseColor('sandstone', [220, 208, 160]);
    t.mottle(c, 0.06);
    // Sedimentary banding.
    const s = t.size;
    for (let y = 0; y < s; y++) {
      const d = Math.sin(y * 1.7) * 0.07;
      for (let x = 0; x < s; x++) {
        const p = t.get(x, y);
        t.set(x, y, p[0] * (1 + d), p[1] * (1 + d), p[2] * (1 + d));
      }
    }
    for (let x = 0; x < s; x++) t.set(x, 1, c[0] * 0.85, c[1] * 0.85, c[2] * 0.85);
  },

  glass: (t) => {
    // Mostly empty with a frame and a highlight streak, so you can see through
    // it but the pane still reads as solid geometry.
    t.fill(255, 255, 255, 0);
    const c = [200, 230, 245];
    t.outline(c, 190);
    const s = t.size;
    for (let i = 2; i < s / 2; i++) t.set(i, i, 255, 255, 255, 130);
    for (let i = 2; i < s / 3; i++) t.set(i + 2, i, 255, 255, 255, 70);
  },

  leaves: (t) => makeLeaves(t, baseColor('leaves', [64, 124, 56])),
  birch_leaves: (t) => makeLeaves(t, baseColor('birch_leaves', [120, 158, 86])),
  pine_leaves: (t) => makeLeaves(t, baseColor('pine_leaves', [40, 92, 64])),

  glowstone: (t) => {
    const c = baseColor('glowstone', [238, 214, 120]);
    t.mottle([c[0] * 0.72, c[1] * 0.66, c[2] * 0.44], 0.12);
    // Bright nodules — these carry the "this thing emits light" read.
    t.speckle(14, c, 0.18, [1, 3]);
  },

  lantern: (t) => {
    const c = baseColor('lantern', [240, 220, 150]);
    t.fill(70, 62, 48);
    const s = t.size;
    for (let y = 3; y < s - 3; y++) for (let x = 3; x < s - 3; x++) {
      const d = (t.rand() - 0.5) * 0.2;
      t.set(x, y, c[0] * (1 + d), c[1] * (1 + d), c[2] * (1 + d));
    }
    t.outline([52, 46, 36]);
  },

  torch: (t) => {
    t.fill(0, 0, 0, 0);
    const s = t.size;
    const cx0 = ((s / 2) | 0) - 1;
    // Stick.
    for (let y = (s / 2) | 0; y < s; y++) {
      t.set(cx0, y, 118, 86, 52); t.set(cx0 + 1, y, 96, 68, 40);
    }
    // Flame head.
    for (let y = ((s / 2) | 0) - 3; y < (s / 2) | 0; y++) {
      t.set(cx0, y, 255, 214, 120); t.set(cx0 + 1, y, 255, 178, 70);
    }
    t.set(cx0, ((s / 2) | 0) - 4, 255, 240, 190);
  },

  cactus_top: (t) => { t.mottle([84, 140, 72], 0.10); t.outline([58, 104, 52]); },
  cactus_side: (t) => {
    t.mottle([76, 130, 66], 0.10);
    const s = t.size;
    for (let y = 0; y < s; y += 4) for (let x = 1; x < s; x += 5) t.set(x, y, 220, 225, 200);
    for (let y = 0; y < s; y++) { t.set(0, y, 52, 96, 48); t.set(s - 1, y, 52, 96, 48); }
  },

  pumpkin_top: (t) => { t.mottle([196, 120, 34], 0.10); t.outline([140, 84, 24]); },
  pumpkin_side: (t) => {
    t.mottle([206, 126, 36], 0.09);
    const s = t.size;
    for (let x = 2; x < s; x += 4) for (let y = 0; y < s; y++) t.set(x, y, 168, 98, 26);
  },

  crafting_table_top: (t) => {
    RECIPES.planks(t);
    const s = t.size;
    // A 3x3 grid, the one detail that makes the block instantly readable.
    for (let i = 0; i <= 3; i++) {
      const p = Math.round((i * (s - 2)) / 3) + 1;
      for (let k = 1; k < s - 1; k++) { t.set(p, k, 74, 56, 34); t.set(k, p, 74, 56, 34); }
    }
  },
  crafting_table_side: (t) => {
    RECIPES.planks(t);
    const s = t.size;
    for (let y = (s / 2) | 0; y < s; y++) for (let x = 0; x < s; x++) {
      const p = t.get(x, y);
      t.set(x, y, p[0] * 0.78, p[1] * 0.74, p[2] * 0.7);
    }
  },

  furnace_top: (t) => { t.mottle(baseColor('cobblestone'), 0.09); t.outline([92, 92, 96]); },
  furnace_side: (t) => {
    t.mottle(baseColor('cobblestone'), 0.09);
    const s = t.size;
    // Dark opening with a hint of fire at the bottom.
    for (let y = (s * 0.35) | 0; y < s - 2; y++) {
      for (let x = 3; x < s - 3; x++) t.set(x, y, 42, 40, 42);
    }
    for (let x = 4; x < s - 4; x++) t.set(x, s - 3, 196, 108, 40);
  },

  flower_red: (t) => makeFlower(t, [198, 62, 58]),
  flower_yellow: (t) => makeFlower(t, [226, 200, 62]),
  mushroom_red: (t) => {
    t.fill(0, 0, 0, 0);
    const s = t.size, cx = (s / 2) | 0;
    for (let y = s - 6; y < s - 2; y++) { t.set(cx, y, 226, 220, 206); t.set(cx - 1, y, 200, 194, 182); }
    for (let y = s - 10; y < s - 6; y++) {
      for (let x = cx - 3; x <= cx + 2; x++) t.set(x, y, 190, 52, 46);
    }
    t.set(cx - 2, s - 9, 240, 236, 228);
    t.set(cx + 1, s - 8, 240, 236, 228);
  },
  tall_grass: (t) => {
    t.fill(0, 0, 0, 0);
    const s = t.size;
    const g = baseColor('tall_grass', [96, 152, 72]);
    for (let blade = 0; blade < 7; blade++) {
      let x = 1 + ((t.rand() * (s - 2)) | 0);
      const h = 5 + ((t.rand() * (s / 2)) | 0);
      for (let k = 0; k < h; k++) {
        const y = s - 1 - k;
        const d = (t.rand() - 0.5) * 0.3;
        t.set(x, y, g[0] * (1 + d), g[1] * (1 + d), g[2] * (1 + d));
        if (t.rand() > 0.7) x += t.rand() > 0.5 ? 1 : -1;
      }
    }
  },
};

/* ---- shared sub-recipes ---- */

function makeBark(t, c, streak) {
  t.mottle(c, 0.13);
  const s = t.size;
  const dark = streak || [c[0] * 0.62, c[1] * 0.62, c[2] * 0.62];
  // Vertical grain: the single cue that says "this is a trunk, not a plank".
  for (let i = 0; i < 5; i++) {
    let x = (t.rand() * s) | 0;
    for (let y = 0; y < s; y++) {
      t.set(x, y, dark[0], dark[1], dark[2]);
      if (t.rand() > 0.82) x = (x + (t.rand() > 0.5 ? 1 : s - 1)) % s;
    }
  }
}

function makeRings(t, c) {
  t.mottle(c, 0.08);
  const s = t.size, cx = (s - 1) / 2, cy = (s - 1) / 2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = Math.sin(d * 2.1) * 0.16;
      const p = t.get(x, y);
      t.set(x, y, p[0] * (1 + ring), p[1] * (1 + ring), p[2] * (1 + ring));
    }
  }
}

function makeLeaves(t, c) {
  t.mottle(c, 0.20);
  // A few gaps so canopy silhouettes read as foliage rather than solid cubes.
  // Kept sparse on purpose: leaves are drawn by the alpha-tested material, so
  // every transparent texel is a real hole you can see sky through, and a high
  // hole rate turns a tree into visible swiss cheese.
  const s = t.size;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Holes only on the outermost ring, where they soften the cube
      // silhouette. Faces between adjacent leaf blocks are culled, so what you
      // see is the canopy's outer shell — a hole anywhere on it shows raw sky,
      // and scattering them across the face interior reads as damage rather
      // than foliage.
      const edge = Math.min(x, y, s - 1 - x, s - 1 - y) === 0;
      if (edge && t.rand() > 0.88) t.set(x, y, 0, 0, 0, 0);
    }
  }
  // Darker veins give the canopy some internal structure at close range.
  for (let i = 0; i < 6; i++) {
    const x = (t.rand() * s) | 0, y = (t.rand() * s) | 0;
    const p = t.get(x, y);
    if (p[3] > 0) t.set(x, y, p[0] * 0.72, p[1] * 0.72, p[2] * 0.72, p[3]);
  }
}

function makeFlower(t, petal) {
  t.fill(0, 0, 0, 0);
  const s = t.size, cx = (s / 2) | 0;
  const stem = [72, 122, 58];
  for (let y = (s / 2) | 0; y < s - 1; y++) t.set(cx, y, stem[0], stem[1], stem[2]);
  t.set(cx - 1, (s * 0.66) | 0, stem[0], stem[1], stem[2]);
  const top = ((s / 2) | 0) - 2;
  for (let y = top - 2; y <= top + 1; y++) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      if (Math.abs(x - cx) + Math.abs(y - (top - 0.5)) > 3) continue;
      t.set(x, y, petal[0], petal[1], petal[2]);
    }
  }
  t.set(cx, top - 1, 245, 226, 140); // pollen centre
}

/* Ores: the stone matrix with coloured inclusions. Generated from a table so
   adding an ore is one line rather than another near-identical recipe. */
const ORES = {
  coal_ore: [38, 38, 40],
  iron_ore: [196, 148, 112],
  gold_ore: [238, 200, 84],
  diamond_ore: [96, 226, 224],
  emerald_ore: [70, 190, 118],
  redstone_ore: [186, 54, 54],
};
for (const [name, colour] of Object.entries(ORES)) {
  RECIPES[name] = (t) => {
    RECIPES.stone(t);
    // A handful of blobs, not scattered pixels — clumping is what makes an
    // ore vein legible from a distance in a dark cave.
    for (let i = 0; i < 5; i++) {
      const cx = 2 + ((t.rand() * (t.size - 4)) | 0);
      const cy = 2 + ((t.rand() * (t.size - 4)) | 0);
      const r = 1 + ((t.rand() * 2) | 0);
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (Math.hypot(x - cx, y - cy) > r) continue;
          const d = (t.rand() - 0.5) * 0.25;
          t.set(x, y, colour[0] * (1 + d), colour[1] * (1 + d), colour[2] * (1 + d));
        }
      }
    }
  };
}

/* Every texture name any block references. Derived from the mapping table so
   a new block can't silently end up untextured. */
export function requiredTextureNames() {
  const names = new Set();
  for (const spec of Object.values(BLOCK_TEXTURES)) {
    if (typeof spec === 'string') names.add(spec);
    else for (const v of Object.values(spec)) if (v) names.add(v);
  }
  return [...names];
}

/**
 * Generate the full built-in texture set.
 * @returns {object} textureName -> canvas
 */
/* Water animates. Four phase-shifted frames stacked vertically — exactly the
   sheet format Minecraft resource packs use, so the atlas's existing
   animation path (built for packs) drives the built-in water too. The bands
   scroll by a quarter tile per frame, making the 4-frame cycle seamless. */
function buildWaterStrip(s) {
  const strip = makeCanvas(s, s * 4);
  const ctx = strip.getContext('2d');
  for (let f = 0; f < 4; f++) {
    const t = new Tile(s, 'water#' + f);
    const c = baseColor('water');
    t.mottle(c, 0.06, 255);
    const shift = (f / 4) * s;
    for (let y = 0; y < s; y++) {
      const w = Math.sin(((y + shift) / s) * Math.PI * 4) * 0.10;
      for (let x = 0; x < s; x++) {
        const p2 = t.get(x, y);
        const sparkle = Math.sin(((x * 1.7 + y + shift * 2) / s) * Math.PI * 2) > 0.86 ? 0.12 : 0;
        t.set(x, y, p2[0] * (1 + w + sparkle), p2[1] * (1 + w + sparkle), p2[2] * (1 + w + sparkle * 2), 255);
      }
    }
    const img = ctx.createImageData(s, s);
    img.data.set(t.data);
    ctx.putImageData(img, 0, f * s);
  }
  return strip;
}

export function generateDefaultTextures(tileSize = 16) {
  const out = {};
  for (const name of requiredTextureNames()) {
    const t = new Tile(tileSize, name);
    const recipe = RECIPES[name];
    if (recipe) {
      recipe(t);
    } else {
      // No recipe: fall back to a mottled version of whatever registry colour
      // uses this texture, so a new block still looks like a material.
      t.mottle(colourForTextureName(name), 0.12);
    }
    out[name] = t.toCanvas();
  }
  // Frame-animated overrides (same {image, frames, meta} shape a pack yields).
  out.water = { image: buildWaterStrip(tileSize), frames: 4, meta: { frametime: 10 } };
  return out;
}

/* Find a sensible base colour for a texture with no explicit recipe by
   looking up whichever block references it. */
function colourForTextureName(name) {
  for (const [key, spec] of Object.entries(BLOCK_TEXTURES)) {
    const hit = typeof spec === 'string' ? spec === name : Object.values(spec).includes(name);
    if (hit) return baseColor(key);
  }
  return [140, 140, 140];
}

export default generateDefaultTextures;
