/* =========================================================================
   worldgen.js — procedural terrain generation for Voxel Odyssey.

   Pure logic (no Three.js). Given a Chunk (with .cx, .cz and setLocal()),
   `generateChunk` fills it with deterministic terrain: biome-blended
   multi-octave heights, layered ground, oceans + beaches, 3D-noise caves,
   depth-banded ore veins, and surface decorations (trees, cacti, flowers,
   grass, mushrooms, the occasional pumpkin).

   Everything is derived from the world seed plus integer coordinates via
   `hashCombine` / per-chunk `RNG`, so the same seed always rebuilds the same
   world — `Math.random()` is never used.

   Coordinate convention (matches constants.js): a chunk covers world columns
     wx = cx * CHUNK_SX + lx ,  wz = cz * CHUNK_SZ + lz   for lx,lz in [0,16).
   +Y is up; the surface "height" is the y of the topmost solid ground block.
   ========================================================================= */

import { Noise } from './noise.js';
import { ID } from './blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, WATER_LEVEL, BEACH_LEVEL } from './constants.js';
import { RNG, hashCombine, clamp } from '../core/utils.js';
import { Climate, selectBiome } from './climate.js';

// ---- tuning constants ----------------------------------------------------

const SEA = WATER_LEVEL;                 // 28
const MAX_Y = CHUNK_SY - 1;              // 79
const BEDROCK_TOP = 2;                   // y 0..2 region is (mostly) bedrock

// Salts keep independent noise channels from correlating. Any distinct ints.
const SALT = {
  height: 1013,
  detail: 2027,
  temp: 3037,
  moist: 4051,
  ridge: 5077,
  cave: 6091,
  ore: 7109,
  decor: 8123,
  hill: 9137,
};

// Surface palette per biome. Height is NOT here any more — the old table
// carried a `base` elevation per biome, which meant biomes dictated terrain
// and every border was a step. Height now comes from the climate system's
// splines (see climate.js) and biomes only decide what the ground is MADE of.
const SURFACES = {
  deep_ocean: { surface: ID.GRAVEL, sub: ID.DIRT, beach: false },
  ocean: { surface: ID.SAND, sub: ID.DIRT, beach: false },
  frozen_ocean: { surface: ID.SAND, sub: ID.DIRT, beach: false, frozen: true },
  beach: { surface: ID.SAND, sub: ID.SAND, beach: false },
  snowy_beach: { surface: ID.SAND, sub: ID.SAND, beach: false, frozen: true },
  desert: { surface: ID.SAND, sub: ID.SANDSTONE, beach: false },
  badlands: { surface: ID.SANDSTONE, sub: ID.SANDSTONE, beach: false },
  savanna: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  plains: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  forest: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  birch_forest: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  swamp: { surface: ID.GRASS, sub: ID.DIRT, beach: false },
  jungle: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  taiga: { surface: ID.GRASS, sub: ID.DIRT, beach: true },
  snowy_plains: { surface: ID.SNOW, sub: ID.DIRT, beach: false, frozen: true },
  snowy_taiga: { surface: ID.SNOW, sub: ID.DIRT, beach: false, frozen: true },
  mountains: { surface: ID.GRASS, sub: ID.DIRT, beach: false, alpine: true },
  snowy_mountains: { surface: ID.SNOW, sub: ID.STONE, beach: false, alpine: true, frozen: true },
  stony_peaks: { surface: ID.STONE, sub: ID.STONE, beach: false, alpine: true },
};

// Cross / decoration blocks treated as "non-ground" when scanning columns.
function isDecoration(id) {
  return id === ID.TALL_GRASS || id === ID.FLOWER_RED || id === ID.FLOWER_YELLOW ||
    id === ID.MUSHROOM_RED || id === ID.TORCH;
}

export class WorldGen {
  constructor(game) {
    this.game = game;
    this.seed = (game && game.seed) | 0 || 1337;
    // Terrain shape + biome choice live in the Climate system; the only noise
    // owned here is the cave/ore field.
    this.climate = null;
    this.caveNoise = null;
    // Small memo so heightAt/biomeAt/columnInfo don't recompute repeatedly for
    // the same column during a single frame's queries (e.g. spawn searches).
    this._colCache = new Map();
    this._colCacheSeed = -1;
    this.setSeed(this.seed);
  }

  /* --- seeding ---------------------------------------------------------- */

  setSeed(seed) {
    this.seed = (seed | 0) >>> 0;
    this.climate = new Climate(this.seed);
    this.caveNoise = new Noise(hashCombine(this.seed, SALT.cave));
    this._colCache.clear();
    this._colCacheSeed = this.seed;
    return this;
  }

  init() {
    // Pick up a seed assigned to the game after construction, if any.
    if (this.game && this.game.seed != null && (this.game.seed | 0) >>> 0 !== this.seed) {
      this.setSeed(this.game.seed | 0);
    }
    return this;
  }

  /* --- public column queries -------------------------------------------- */

  // Biome name at a world column ('plains', 'snowy_taiga', ...). A string,
  // because the HUD prints it and the weather system matches on it.
  biomeAt(wx, wz) {
    return this._column(wx | 0, wz | 0).biome;
  }

  // Terrain surface height at a world column (top solid block's y).
  heightAt(wx, wz) {
    return this._column(wx | 0, wz | 0).height;
  }

  // Full descriptor for external callers (spawning, debug overlay).
  columnInfo(wx, wz) {
    return this._column(wx | 0, wz | 0);
  }

  /* --- per-column height computation ------------------------------------ */

  // Computes (and caches) the full column descriptor for a world column.
  _column(wx, wz) {
    if (this._colCacheSeed !== this.seed) { this._colCache.clear(); this._colCacheSeed = this.seed; }
    const key = wx * 92821 + wz;          // cheap composite key (collision-tolerant)
    const cached = this._colCache.get(key);
    if (cached !== undefined) return cached;

    // Terrain first, biome second: the climate system shapes the ground from
    // continentalness/erosion/peaks splines, and the biome is then chosen by
    // the climate AND that outcome. Nothing about the biome feeds back into
    // height, which is why biome borders leave no seam in the terrain.
    const c = this.climate.sample(wx, wz);
    const biome = selectBiome(c);
    // Normalised temperature (0..1) kept for the ice/decoration rules below.
    const temperature = clamp(0.5 + 0.62 * c.temp, 0, 1);
    const moisture = clamp(0.5 + 0.62 * c.humid, 0, 1);

    const info = {
      height: c.height, biome, temperature, moisture,
      continent: c.continent, erosion: c.erosion, river: c.river,
    };
    // Keep the cache from growing without bound across a long session.
    if (this._colCache.size > 8192) this._colCache.clear();
    this._colCache.set(key, info);
    return info;
  }

  // Blends the neighbouring-biome parameters using smooth climate weights so
  // terrain transitions between biomes without hard seams, then layers in the
  // shared rolling + ridge fields.
  /* Is open water within a few blocks? Used to gate beach sand so it only
     appears where land actually meets sea. Sampled sparsely on a ring rather
     than a full disc: a beach band is only a couple of blocks wide, so four
     probes at two radii are enough to catch a real shoreline while costing a
     fraction of a full neighbourhood scan. */
  _nearWater(wx, wz) {
    for (const r of [3, 6]) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        if (this.heightAt(wx + dx, wz + dz) < SEA) return true;
      }
    }
    return false;
  }

  /* --- chunk fill ------------------------------------------------------- */

  generateChunk(chunk) {
    if (!chunk || typeof chunk.setLocal !== 'function') return;
    const cx = chunk.cx | 0;
    const cz = chunk.cz | 0;
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    // Per-chunk deterministic RNG drives all "scattered" decisions (ores,
    // decorations) so a chunk regenerates identically every time.
    const chunkRng = new RNG(hashCombine(this.seed, cx, cz, SALT.decor));

    // First pass: solid terrain, water, beaches, caves, ores — column by
    // column. Cache the per-column descriptors for the decoration pass.
    const cols = new Array(CHUNK_SX * CHUNK_SZ);

    for (let lx = 0; lx < CHUNK_SX; lx++) {
      const wx = baseX + lx;
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        const wz = baseZ + lz;
        const info = this._column(wx, wz);
        cols[lx * CHUNK_SZ + lz] = info;
        this._fillColumn(chunk, lx, lz, wx, wz, info);
      }
    }

    // Second pass: surface decorations, over the chunk PLUS a margin.
    //
    // A tree's canopy spans up to 3 blocks around its trunk. Decorating only
    // the chunk's own columns clipped every tree rooted near a border —
    // setLocal drops out-of-range writes, so half the canopy simply never
    // existed, in whichever chunk generated first AND forever, because the
    // neighbour never revisited it.
    //
    // Decoration decisions are per-column and seeded from WORLD coordinates
    // (mulberryAt below), so both chunks adjacent to a border evaluate the
    // margin column identically: each writes the part of the tree that lands
    // inside itself, and together they produce one whole tree with no
    // cross-chunk coordination.
    const MARGIN = 3;
    for (let lx = -MARGIN; lx < CHUNK_SX + MARGIN; lx++) {
      const wx = baseX + lx;
      for (let lz = -MARGIN; lz < CHUNK_SZ + MARGIN; lz++) {
        const wz = baseZ + lz;
        const inChunk = lx >= 0 && lx < CHUNK_SX && lz >= 0 && lz < CHUNK_SZ;
        const info = inChunk ? cols[lx * CHUNK_SZ + lz] : this._column(wx, wz);
        this._decorate(chunk, lx, lz, wx, wz, info, chunkRng, inChunk);
      }
    }

    if ('generated' in chunk) chunk.generated = true;
  }

  // Fill a single column: bedrock → stone (with ores/caves) → dirt band →
  // surface block → water up to sea level.
  /* Resolve the surface/sub blocks for a column — shared by chunk fill,
     the margin decoration pass, and blockAt so they can never disagree. */
  _surfaceFor(info, wx, wz) {
    const b = SURFACES[info.biome] || SURFACES.plains;
    const surfaceY = info.height;

    let surfaceId = b.surface;
    let subId = b.sub;

    // Alpine biomes turn to bare stone above the treeline, so a mountain is
    // grass at its foot and rock at its shoulder — the surface follows the
    // height the splines produced rather than being one block everywhere.
    if (b.alpine && surfaceId !== ID.STONE && surfaceY > SEA + 18) {
      surfaceId = surfaceY > SEA + 26 ? ID.STONE : (b.frozen ? ID.SNOW : ID.STONE);
      subId = ID.STONE;
    }

    const isShore = b.beach && surfaceY >= SEA - 1 && surfaceY <= BEACH_LEVEL
      && this._nearWater(wx, wz);
    if (isShore) { surfaceId = ID.SAND; subId = ID.SAND; }

    if (surfaceY < SEA && surfaceId === ID.GRASS) surfaceId = ID.DIRT;
    if (surfaceY < SEA && surfaceId === ID.SNOW) surfaceId = ID.DIRT;
    return { surfaceId, subId, frozen: !!b.frozen };
  }

  /* The terrain block at one (wx,y,wz), given the column's resolved surface.
     This is THE single definition of what the ground is made of: chunk fill
     iterates it per y, and blockAt() answers a point query with it — so the
     multiplayer rollback path reconstructs exactly what generation produced. */
  _terrainBlockAt(info, surf, wx, y, wz) {
    const surfaceY = info.height;

    if (y > surfaceY) {
      if (y <= SEA) {
        if (y === SEA && (surf.frozen || info.temperature < 0.2)) return ID.ICE;
        return ID.WATER;
      }
      return ID.AIR;
    }

    if (y <= BEDROCK_TOP) {
      if (y === 0) return ID.BEDROCK;
      const r = hashCombine(this.seed, wx, wz, y * 131 + SALT.height) / 4294967296;
      return r < (1 - y / (BEDROCK_TOP + 1)) ? ID.BEDROCK : ID.STONE;
    }

    const subDepth = (surf.surfaceId === ID.SAND) ? 4 : 3;
    let id;
    if (y === surfaceY) id = surf.surfaceId;
    else if (y >= surfaceY - subDepth) id = surf.subId;
    else id = ID.STONE;

    if (id === ID.STONE && y > BEDROCK_TOP) {
      if (this._isCave(wx, y, wz, surfaceY)) return ID.AIR;
      id = this._oreFor(wx, y, wz, id);
    }
    return id;
  }

  /**
   * Pure point query: the block generation would place at (wx,y,wz), terrain
   * only (no trees/plants — decorations are cross-column and not needed by
   * the callers of this API). Used by the multiplayer client to reconstruct
   * the true block when the server rejects a predicted edit on an unedited
   * voxel.
   */
  blockAt(wx, wy, wz) {
    wx |= 0; wy |= 0; wz |= 0;
    if (wy < 0 || wy > MAX_Y) return ID.AIR;
    const info = this._column(wx, wz);
    const surf = this._surfaceFor(info, wx, wz);
    return this._terrainBlockAt(info, surf, wx, wy, wz);
  }

  _fillColumn(chunk, lx, lz, wx, wz, info) {
    const surfaceY = info.height;
    const surf = this._surfaceFor(info, wx, wz);

    for (let y = 0; y <= surfaceY; y++) {
      const id = this._terrainBlockAt(info, surf, wx, y, wz);
      if (id !== ID.AIR) chunk.setLocal(lx, y, lz, id);
    }
    if (surfaceY < SEA) {
      for (let y = surfaceY + 1; y <= SEA; y++) {
        chunk.setLocal(lx, y, lz, this._terrainBlockAt(info, surf, wx, y, wz));
      }
    }
  }

  /* --- caves ------------------------------------------------------------ */

  // 3D-noise cave test. Returns true where rock should be hollowed out.
  // Caves only form a few blocks below the surface and above the bedrock.
  _isCave(wx, y, wz, surfaceY) {
    if (y <= BEDROCK_TOP + 1) return false;       // protect bedrock floor
    if (y >= surfaceY - 3) return false;          // keep a solid surface crust

    // Two overlapping low-frequency fields; carve where both are near zero,
    // producing winding tunnels rather than spherical blobs.
    const n1 = this.caveNoise.perlin3(wx * 0.045, y * 0.07, wz * 0.045);
    const n2 = this.caveNoise.perlin3(wx * 0.03 + 100.5, y * 0.05 + 50.5, wz * 0.03 + 100.5);

    // Widen caves with depth a touch (more open space deep down).
    const depthBias = clamp((surfaceY - y) / 48, 0, 0.12);
    const threshold = 0.16 + depthBias;
    return Math.abs(n1) < threshold && Math.abs(n2) < threshold;
  }

  /* --- ores ------------------------------------------------------------- */

  // Deterministic ore placement. Depth bands gate which ores can appear; a
  // hashed roll + a small 3D-noise "vein" field clusters them into blobs.
  _oreFor(wx, y, wz, stoneId) {
    // Vein coherence: ore tends to appear where this field is high, so hits
    // cluster into small veins instead of scattering one block at a time.
    const vein = this.caveNoise.perlin3(wx * 0.12 + 7.3, y * 0.12 + 11.7, wz * 0.12 + 3.1);
    const veinBoost = vein > 0.45 ? 2.4 : (vein > 0.2 ? 1.4 : 1.0);

    const roll = hashCombine(this.seed, wx, y, wz ^ SALT.ore) / 4294967296;

    // Probabilities are per-block base rates, multiplied by veinBoost.
    // Bands (by absolute y, world height 0..79, sea ~28):
    //   coal:     y 5..70   common
    //   iron:     y 5..52   common-ish
    //   gold:     y 5..30   uncommon
    //   redstone: y 4..24   uncommon
    //   diamond:  y 3..16   rare
    //   emerald:  y 3..14   very rare (mountains favored, but global ok)
    const p = roll;

    if (y >= 3 && y <= 16 && p < 0.0016 * veinBoost) return ID.DIAMOND_ORE;
    if (y >= 3 && y <= 14 && p < 0.0010 * veinBoost) return ID.EMERALD_ORE;
    if (y >= 4 && y <= 24 && p < 0.0046 * veinBoost) return ID.REDSTONE_ORE;
    if (y >= 5 && y <= 30 && p < 0.0040 * veinBoost) return ID.GOLD_ORE;
    if (y >= 5 && y <= 52 && p < 0.0120 * veinBoost) return ID.IRON_ORE;
    if (y >= 5 && y <= 70 && p < 0.0150 * veinBoost) return ID.COAL_ORE;

    // Occasional gravel/dirt pockets in stone for visual variety.
    if (p > 0.992) return ID.GRAVEL;

    return stoneId;
  }

  /* --- decorations ------------------------------------------------------ */

  _decorate(chunk, lx, lz, wx, wz, info, rng, inChunk = true) {
    const biome = info.biome;
    const surfaceY = info.height;

    // No surface decoration underwater (except nothing) or on ice/oceans.
    if (surfaceY < SEA) return;
    if (surfaceY >= MAX_Y - 8) return;            // leave headroom for trees

    // The block we'd be standing on. Inside the chunk, read it back so we
    // don't plant on beach sand etc. For MARGIN columns the chunk holds no
    // data (getLocal would say AIR and veto everything), so derive the same
    // answer from the deterministic surface rules instead — both sides of a
    // border must reach identical decisions.
    let ground, above;
    if (inChunk) {
      ground = chunk.getLocal ? chunk.getLocal(lx, surfaceY, lz) : ID.AIR;
      above = chunk.getLocal ? chunk.getLocal(lx, surfaceY + 1, lz) : ID.AIR;
    } else {
      ground = this._surfaceFor(info, wx, wz).surfaceId;
      above = ID.AIR;
    }
    if (above !== ID.AIR) return;                 // already occupied (overhang)

    // Per-column random stream so each column decides independently yet
    // deterministically. Seeded from world coords for stability across chunks.
    const r = mulberryAt(this.seed, wx, wz);

    switch (biome) {
      case 'desert':
      case 'badlands':
        this._decorateDesert(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'forest':
      case 'jungle':                 // denser variant handled inside
        this._decorateForest(chunk, lx, lz, wx, wz, surfaceY, ground, r, biome);
        break;
      case 'birch_forest':
        this._decorateForest(chunk, lx, lz, wx, wz, surfaceY, ground, r, biome);
        break;
      case 'taiga':
      case 'snowy_taiga':
      case 'snowy_plains':
        this._decorateSnow(chunk, lx, lz, wx, wz, surfaceY, ground, r, biome);
        break;
      case 'mountains':
      case 'snowy_mountains':
      case 'stony_peaks':
        this._decorateMountains(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'plains':
      case 'savanna':
      case 'swamp':
        this._decoratePlains(chunk, lx, lz, wx, wz, surfaceY, ground, r, biome);
        break;
      case 'beach':
      case 'snowy_beach':
        this._decorateBeach(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      default:
        break;
    }
  }

  _decoratePlains(chunk, lx, lz, wx, wz, sy, ground, r, biome = 'plains') {
    if (ground !== ID.GRASS) return;
    const top = sy + 1;
    // Savanna: slightly more trees than plains; swamp: mushrooms over flowers.
    const treeP = biome === 'savanna' ? 0.02 : 0.012;
    if (biome === 'swamp' && r() < 0.03) {
      this._setCross(chunk, lx, top, lz, ID.MUSHROOM_RED);
      return;
    }
    if (r() < treeP) {                         // sparse oak trees
      this._tree(chunk, lx, lz, top, 'oak', r);
    } else if (r() < 0.10) {                    // tall grass
      this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
    } else if (r() < 0.022) {                   // flowers
      this._setCross(chunk, lx, top, lz, r() < 0.5 ? ID.FLOWER_RED : ID.FLOWER_YELLOW);
    } else if (r() < 0.004) {                   // rare pumpkin
      this._setSolidOnTop(chunk, lx, top, lz, ID.PUMPKIN);
    }
  }

  _decorateForest(chunk, lx, lz, wx, wz, sy, ground, r, biome = 'forest') {
    if (ground !== ID.GRASS) return;
    const top = sy + 1;
    const k = r();
    const density = biome === 'jungle' ? 0.13 : 0.085;
    const birchShare = biome === 'birch_forest' ? 0.85 : 0.35;
    if (k < density) {
      this._tree(chunk, lx, lz, top, r() < birchShare ? 'birch' : 'oak', r);
    } else if (k < 0.20) {
      this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
    } else if (k < 0.24) {
      this._setCross(chunk, lx, top, lz, r() < 0.5 ? ID.FLOWER_RED : ID.FLOWER_YELLOW);
    } else if (k < 0.255) {                     // mushrooms in the shade
      this._setCross(chunk, lx, top, lz, ID.MUSHROOM_RED);
    } else if (k < 0.258) {
      this._setSolidOnTop(chunk, lx, top, lz, ID.PUMPKIN);
    }
  }

  _decorateDesert(chunk, lx, lz, wx, wz, sy, ground, r) {
    if (ground !== ID.SAND) return;
    const top = sy + 1;
    if (r() < 0.018) {                          // cactus column (1..3 tall)
      const h = 1 + Math.floor(r() * 3);
      for (let i = 0; i < h; i++) {
        const y = top + i;
        if (y > MAX_Y) break;
        if (chunk.getLocal(lx, y, lz) !== ID.AIR) break;
        chunk.setLocal(lx, y, lz, ID.CACTUS);
      }
    } else if (r() < 0.006) {                    // dead-ish shrub as tall grass
      this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
    }
  }

  _decorateSnow(chunk, lx, lz, wx, wz, sy, ground, r, biome = 'snowy_plains') {
    const top = sy + 1;
    if (ground === ID.SNOW || ground === ID.GRASS || ground === ID.DIRT) {
      // Taigas are pine forests; snowy plains only get the odd stray tree.
      const treeP = biome.includes('taiga') ? 0.06 : 0.010;
      if (r() < treeP) {
        this._tree(chunk, lx, lz, top, 'pine', r);
      } else if (r() < 0.05) {
        this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
      }
    }
  }

  _decorateMountains(chunk, lx, lz, wx, wz, sy, ground, r) {
    const top = sy + 1;
    // Only the lower, non-snowcapped slopes get the odd pine + grass.
    if (ground === ID.GRASS || ground === ID.DIRT) {
      if (r() < 0.006) this._tree(chunk, lx, lz, top, 'pine', r);
      else if (r() < 0.03) this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
    } else if (ground === ID.STONE && r() < 0.02) {
      // sparse boulders: a single mossy cobble nub
      this._setSolidOnTop(chunk, lx, top, lz, ID.MOSSY_COBBLE);
    }
  }

  _decorateBeach(chunk, lx, lz, wx, wz, sy, ground, r) {
    if (ground !== ID.SAND) return;
    const top = sy + 1;
    if (r() < 0.004) this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
  }

  /* --- decoration primitives -------------------------------------------- */

  // Place a cross-type plant on top of a column if the cell is empty.
  _setCross(chunk, lx, y, lz, id) {
    if (y < 0 || y > MAX_Y) return;
    if (chunk.getLocal(lx, y, lz) !== ID.AIR) return;
    chunk.setLocal(lx, y, lz, id);
  }

  // Place a solid block (pumpkin/boulder) on top if the cell is empty.
  _setSolidOnTop(chunk, lx, y, lz, id) {
    if (y < 0 || y > MAX_Y) return;
    if (chunk.getLocal(lx, y, lz) !== ID.AIR) return;
    chunk.setLocal(lx, y, lz, id);
  }

  // Build a tree of the given kind. `baseY` is the y of the trunk's bottom
  // (i.e. the cell directly above the ground). Trunk/leaf blocks that would
  // fall outside this chunk's [0,16) x/z columns are clamped/skipped so a
  // chunk never tries to write a neighbour's voxels.
  _tree(chunk, lx, lz, baseY, kind, r) {
    let logId, leafId, trunkH, radius, shape;
    if (kind === 'birch') {
      logId = ID.BIRCH_LOG; leafId = ID.BIRCH_LEAVES;
      trunkH = 5 + Math.floor(r() * 2); radius = 2; shape = 'round';
    } else if (kind === 'pine') {
      logId = ID.PINE_LOG; leafId = ID.PINE_LEAVES;
      trunkH = 6 + Math.floor(r() * 3); radius = 2; shape = 'cone';
    } else { // oak
      logId = ID.LOG; leafId = ID.LEAVES;
      trunkH = 4 + Math.floor(r() * 2); radius = 2; shape = 'round';
    }

    const topY = baseY + trunkH - 1;
    if (topY + radius > MAX_Y) {
      // Not enough vertical room; abort rather than clip the canopy oddly.
      trunkH = Math.max(3, MAX_Y - radius - baseY);
      if (trunkH < 3) return;
    }

    // Trunk.
    for (let i = 0; i < trunkH; i++) {
      const y = baseY + i;
      if (y > MAX_Y) break;
      // Trunk is always inside this column, so no clamping needed here.
      if (this._canOverwrite(chunk.getLocal(lx, y, lz))) {
        chunk.setLocal(lx, y, lz, logId);
      }
    }

    // Canopy.
    if (shape === 'cone') {
      this._pineCanopy(chunk, lx, lz, baseY, trunkH, leafId);
    } else {
      this._roundCanopy(chunk, lx, lz, baseY + trunkH - 1, leafId);
    }
  }

  // Spherical-ish canopy centered near the trunk top for oak/birch.
  _roundCanopy(chunk, lx, lz, topLogY, leafId) {
    // Two main layers of radius 2, then a small cap.
    const layers = [
      { dy: -1, rad: 2 },
      { dy: 0, rad: 2 },
      { dy: 1, rad: 1 },
      { dy: 2, rad: 1 },
    ];
    for (const layer of layers) {
      const y = topLogY + layer.dy;
      if (y < 0 || y > MAX_Y) continue;
      const rad = layer.rad;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          // Skip the trunk cell on the trunk layers (let log show through).
          if (dx === 0 && dz === 0 && layer.dy <= 0) continue;
          // Round off the corners of the widest layers.
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
          this._placeLeaf(chunk, lx + dx, y, lz + dz, leafId);
        }
      }
    }
  }

  // Conical layered canopy for pines: wide at the bottom, narrowing upward.
  _pineCanopy(chunk, lx, lz, baseY, trunkH, leafId) {
    const startY = baseY + 1;                    // leaves start a bit up the trunk
    const top = baseY + trunkH - 1;
    let rad = 2;
    for (let y = startY; y <= top + 1; y++) {
      if (y < 0 || y > MAX_Y) continue;
      // Shrink radius as we climb; alternate full/narrow rings for a layered look.
      const ring = top + 1 - y;
      rad = ring >= 4 ? 2 : ring >= 2 ? 1 : 0;
      if (rad === 0) { this._placeLeaf(chunk, lx, y, lz, leafId); continue; }
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue; // chamfer
          if (dx === 0 && dz === 0 && y <= top) continue;             // keep trunk
          this._placeLeaf(chunk, lx + dx, y, lz + dz, leafId);
        }
      }
    }
  }

  // Place a leaf only if it stays within this chunk's columns and the target
  // cell is empty/overwritable. Overhang outside [0,16) is skipped (clamped).
  _placeLeaf(chunk, lx, y, lz, leafId) {
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return; // skip overhang
    if (y < 0 || y > MAX_Y) return;
    const cur = chunk.getLocal(lx, y, lz);
    if (cur === ID.AIR || isDecoration(cur)) {
      chunk.setLocal(lx, y, lz, leafId);
    }
  }

  // Trees may grow through tall grass/flowers but not solid ground.
  _canOverwrite(id) {
    return id === ID.AIR || isDecoration(id) || id === ID.LEAVES ||
      id === ID.BIRCH_LEAVES || id === ID.PINE_LEAVES;
  }
}

/* --- helpers -------------------------------------------------------------- */

// A tiny per-column RNG: returns a function producing a deterministic stream
// of floats in [0,1) seeded from (seed, wx, wz). Each call advances the stream
// so successive r() draws within one column are independent.
function mulberryAt(seed, wx, wz) {
  let a = hashCombine(seed, wx, wz, SALT.decor) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default WorldGen;
