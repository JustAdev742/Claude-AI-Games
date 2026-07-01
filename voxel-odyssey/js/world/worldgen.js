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

// Each biome describes its surface palette and how the shared continental
// height field is scaled/biased into that biome's local terrain.
//   base   — the y the biome settles around at "neutral" elevation noise
//   amp    — vertical amplitude of rolling terrain
//   ridged — extra height contributed by the ridge field (mountains/snow)
//   rough  — weight of the high-frequency detail octave
const BIOMES = {
  ocean: { base: SEA - 7, amp: 4, ridged: 0, rough: 0.4, surface: ID.SAND, sub: ID.DIRT, beach: false },
  beach: { base: SEA + 1, amp: 2, ridged: 0, rough: 0.3, surface: ID.SAND, sub: ID.SAND, beach: true },
  plains: { base: SEA + 4, amp: 5, ridged: 0, rough: 0.5, surface: ID.GRASS, sub: ID.DIRT, beach: true },
  forest: { base: SEA + 5, amp: 7, ridged: 0.15, rough: 0.7, surface: ID.GRASS, sub: ID.DIRT, beach: true },
  desert: { base: SEA + 3, amp: 6, ridged: 0.05, rough: 0.6, surface: ID.SAND, sub: ID.SANDSTONE, beach: false },
  mountains: { base: SEA + 12, amp: 10, ridged: 1.0, rough: 1.0, surface: ID.STONE, sub: ID.STONE, beach: false },
  snow: { base: SEA + 14, amp: 9, ridged: 0.85, rough: 0.9, surface: ID.SNOW, sub: ID.DIRT, beach: false },
};

const RIDGE_HEIGHT = 26;   // peak height the normalized ridge field can add

// Cross / decoration blocks treated as "non-ground" when scanning columns.
function isDecoration(id) {
  return id === ID.TALL_GRASS || id === ID.FLOWER_RED || id === ID.FLOWER_YELLOW ||
    id === ID.MUSHROOM_RED || id === ID.TORCH;
}

export class WorldGen {
  constructor(game) {
    this.game = game;
    this.seed = (game && game.seed) | 0 || 1337;
    // Noise instances are created in setSeed/init so reseeding is trivial.
    this.heightNoise = null;
    this.detailNoise = null;
    this.tempNoise = null;
    this.moistNoise = null;
    this.ridgeNoise = null;
    this.caveNoise = null;
    this.hillNoise = null;
    // Small memo so heightAt/biomeAt/columnInfo don't recompute repeatedly for
    // the same column during a single frame's queries (e.g. spawn searches).
    this._colCache = new Map();
    this._colCacheSeed = -1;
    this.setSeed(this.seed);
  }

  /* --- seeding ---------------------------------------------------------- */

  setSeed(seed) {
    this.seed = (seed | 0) >>> 0;
    // Derive a distinct integer seed per noise channel so they decorrelate.
    this.heightNoise = new Noise(hashCombine(this.seed, SALT.height));
    this.detailNoise = new Noise(hashCombine(this.seed, SALT.detail));
    this.tempNoise = new Noise(hashCombine(this.seed, SALT.temp));
    this.moistNoise = new Noise(hashCombine(this.seed, SALT.moist));
    this.ridgeNoise = new Noise(hashCombine(this.seed, SALT.ridge));
    this.caveNoise = new Noise(hashCombine(this.seed, SALT.cave));
    this.hillNoise = new Noise(hashCombine(this.seed, SALT.hill));
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

  /* --- climate + biome selection --------------------------------------- */

  // Temperature/moisture fields, both in [0,1]. Large features so biomes form
  // coherent regions rather than per-block noise.
  _temperature(wx, wz) {
    const t = this.tempNoise.fbm2(wx, wz, 3, 0.0042, 2.0, 0.5);
    return clamp(0.5 + 0.5 * t, 0, 1);
  }
  _moisture(wx, wz) {
    const m = this.moistNoise.fbm2(wx, wz, 3, 0.0051, 2.0, 0.5);
    return clamp(0.5 + 0.5 * m, 0, 1);
  }

  // A separate low-frequency "continent" field decides land vs. ocean so that
  // oceans appear as large basins instead of wherever height happens to dip.
  _continent(wx, wz) {
    return this.heightNoise.fbm2(wx, wz, 4, 0.0028, 2.0, 0.5); // ~[-1,1]
  }

  // Choose a biome string from climate + elevation signal.
  _classify(temperature, moisture, continent) {
    if (continent < -0.34) return 'ocean';
    // High elevation signal → mountains/snow regardless of moisture.
    if (continent > 0.42) {
      return temperature < 0.32 ? 'snow' : 'mountains';
    }
    // Near sea level with low continent → beaches handled later by height,
    // but classify low-lying very-near-shore as beach when slightly positive.
    if (continent < -0.24) return 'beach';
    if (temperature > 0.66 && moisture < 0.38) return 'desert';
    if (temperature < 0.26) return 'snow';
    if (moisture > 0.58) return 'forest';
    return 'plains';
  }

  biomeAt(wx, wz) {
    return this._column(wx | 0, wz | 0).biome;
  }

  heightAt(wx, wz) {
    return this._column(wx | 0, wz | 0).height;
  }

  columnInfo(wx, wz) {
    const c = this._column(wx | 0, wz | 0);
    return { height: c.height, biome: c.biome, temperature: c.temperature, moisture: c.moisture };
  }

  /* --- per-column height computation ------------------------------------ */

  // Computes (and caches) the full column descriptor for a world column.
  _column(wx, wz) {
    if (this._colCacheSeed !== this.seed) { this._colCache.clear(); this._colCacheSeed = this.seed; }
    const key = wx * 92821 + wz;          // cheap composite key (collision-tolerant)
    const cached = this._colCache.get(key);
    if (cached !== undefined) return cached;

    const temperature = this._temperature(wx, wz);
    const moisture = this._moisture(wx, wz);
    const continent = this._continent(wx, wz);
    const biome = this._classify(temperature, moisture, continent);
    const height = this._computeHeight(wx, wz, biome, continent, temperature, moisture);

    const info = { height, biome, temperature, moisture, continent };
    // Keep the cache from growing without bound across a long session.
    if (this._colCache.size > 8192) this._colCache.clear();
    this._colCache.set(key, info);
    return info;
  }

  // Blends the neighbouring-biome parameters using smooth climate weights so
  // terrain transitions between biomes without hard seams, then layers in the
  // shared rolling + ridge fields.
  _computeHeight(wx, wz, biome, continent, temperature, moisture) {
    // Blend the height parameters with those of nearby columns so terrain
    // transitions smoothly across biome borders instead of forming a hard step.
    const b = this._blendedParams(wx, wz, biome);

    // Rolling hills: medium-frequency fbm, ~[-1,1].
    const roll = this.hillNoise.fbm2(wx, wz, 4, 0.012, 2.0, 0.5);
    // Fine detail: high-frequency, small amplitude.
    const detail = this.detailNoise.fbm2(wx, wz, 3, 0.06, 2.2, 0.5);
    // Ridge field for mountainous biomes, [0,1].
    const ridge = this.ridgeNoise.ridge2(wx, wz, 4, 0.0075);

    // Continent gently lifts/lowers the whole column so biomes inherit the
    // large-scale landmass shape (positive = inland highland).
    const continentLift = continent * 6;

    let h = b.base + continentLift;
    h += roll * b.amp;
    h += detail * b.amp * 0.35 * b.rough;
    if (b.ridged > 0) {
      // Square the ridge to sharpen peaks, scale by blended ridge weight.
      h += ridge * ridge * RIDGE_HEIGHT * b.ridged;
    }

    // Oceans should never poke above the waterline from detail noise.
    if (biome === 'ocean') h = Math.min(h, SEA - 1);

    return clamp(Math.round(h), 1, MAX_Y - 6);
  }

  // Average the height parameters (base/amp/ridged/rough) of the biome here and
  // at four nearby sample points, so the values change gradually across a biome
  // border rather than snapping. Deterministic (pure climate noise).
  _blendedParams(wx, wz, primaryBiome) {
    const R = 6;
    const offs = [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]];
    let base = 0, amp = 0, ridged = 0, rough = 0;
    for (let i = 0; i < offs.length; i++) {
      const ox = offs[i][0], oz = offs[i][1];
      let bio;
      if (ox === 0 && oz === 0) {
        bio = primaryBiome;
      } else {
        const t = this._temperature(wx + ox, wz + oz);
        const m = this._moisture(wx + ox, wz + oz);
        const c = this._continent(wx + ox, wz + oz);
        bio = this._classify(t, m, c);
      }
      const bb = BIOMES[bio] || BIOMES.plains;
      base += bb.base; amp += bb.amp; ridged += bb.ridged; rough += bb.rough;
    }
    const n = offs.length;
    return { base: base / n, amp: amp / n, ridged: ridged / n, rough: rough / n };
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

    // Second pass: surface decorations. Done after terrain so trees can read
    // back the freshly written surface and sit on solid ground.
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      const wx = baseX + lx;
      for (let lz = 0; lz < CHUNK_SZ; lz++) {
        const wz = baseZ + lz;
        const info = cols[lx * CHUNK_SZ + lz];
        this._decorate(chunk, lx, lz, wx, wz, info, chunkRng);
      }
    }

    if ('generated' in chunk) chunk.generated = true;
  }

  // Fill a single column: bedrock → stone (with ores/caves) → dirt band →
  // surface block → water up to sea level.
  _fillColumn(chunk, lx, lz, wx, wz, info) {
    const surfaceY = info.height;
    const biome = info.biome;
    const b = BIOMES[biome] || BIOMES.plains;

    // Is this surface a "beach"? Sand replaces grass/dirt right around the
    // waterline on biomes that allow beaches.
    const isShore = b.beach && surfaceY >= SEA - 1 && surfaceY <= BEACH_LEVEL;

    // Determine the surface + subsurface block ids for this column.
    let surfaceId = b.surface;
    let subId = b.sub;
    if (isShore) { surfaceId = ID.SAND; subId = ID.SAND; }
    // Submerged ground (ocean floor / underwater): use dirt/sand, never grass.
    const submerged = surfaceY < SEA;
    if (submerged && surfaceId === ID.GRASS) { surfaceId = ID.DIRT; }

    // The dirt/sub band thickness just under the surface.
    const subDepth = (surfaceId === ID.SAND) ? 4 : 3;

    for (let y = 0; y <= surfaceY; y++) {
      let id;

      if (y <= BEDROCK_TOP) {
        // Jagged bedrock floor: y=0 always bedrock; 1..2 sometimes bedrock.
        if (y === 0) id = ID.BEDROCK;
        else {
          const r = hashCombine(this.seed, wx, wz, y * 131 + SALT.height) / 4294967296;
          id = r < (1 - y / (BEDROCK_TOP + 1)) ? ID.BEDROCK : ID.STONE;
        }
      } else if (y >= surfaceY - subDepth && y < surfaceY) {
        id = subId;
      } else if (y === surfaceY) {
        id = surfaceId;
      } else {
        id = ID.STONE;
      }

      // Stone region: carve caves and seed ores (never touch bedrock).
      if (id === ID.STONE && y > BEDROCK_TOP) {
        if (this._isCave(wx, y, wz, surfaceY)) {
          // Air below sea level inside terrain could be water-filled, but we
          // keep caves dry for explorability; just skip placing a block.
          continue;
        }
        id = this._oreFor(wx, y, wz, id);
      }

      chunk.setLocal(lx, y, lz, id);
    }

    // Snowy peaks: cap exposed high stone with a thin snow layer for flavor.
    if (biome === 'snow' && surfaceY > SEA && surfaceId === ID.SNOW) {
      // already snow; nothing extra
    }

    // Fill water from the surface up to sea level for submerged columns.
    if (surfaceY < SEA) {
      for (let y = surfaceY + 1; y <= SEA; y++) {
        // Freeze the very top of ocean water in cold biomes into ice.
        if (y === SEA && (biome === 'snow' || info.temperature < 0.22)) {
          chunk.setLocal(lx, y, lz, ID.ICE);
        } else {
          chunk.setLocal(lx, y, lz, ID.WATER);
        }
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

  _decorate(chunk, lx, lz, wx, wz, info, rng) {
    const biome = info.biome;
    const surfaceY = info.height;

    // No surface decoration underwater (except nothing) or on ice/oceans.
    if (surfaceY < SEA) return;
    if (surfaceY >= MAX_Y - 8) return;            // leave headroom for trees

    // The block we'd be standing on. Read it back so we don't plant on sand
    // where a beach overrode the biome surface, etc.
    const ground = chunk.getLocal ? chunk.getLocal(lx, surfaceY, lz) : ID.AIR;
    const above = chunk.getLocal ? chunk.getLocal(lx, surfaceY + 1, lz) : ID.AIR;
    if (above !== ID.AIR) return;                 // already occupied (overhang)

    // Per-column random stream so each column decides independently yet
    // deterministically. Seeded from world coords for stability across chunks.
    const r = mulberryAt(this.seed, wx, wz);

    switch (biome) {
      case 'desert':
        this._decorateDesert(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'forest':
        this._decorateForest(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'snow':
        this._decorateSnow(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'mountains':
        this._decorateMountains(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'plains':
        this._decoratePlains(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      case 'beach':
        this._decorateBeach(chunk, lx, lz, wx, wz, surfaceY, ground, r);
        break;
      default:
        break;
    }
  }

  _decoratePlains(chunk, lx, lz, wx, wz, sy, ground, r) {
    if (ground !== ID.GRASS) return;
    const top = sy + 1;
    if (r() < 0.012) {                         // sparse oak trees
      this._tree(chunk, lx, lz, top, 'oak', r);
    } else if (r() < 0.10) {                    // tall grass
      this._setCross(chunk, lx, top, lz, ID.TALL_GRASS);
    } else if (r() < 0.022) {                   // flowers
      this._setCross(chunk, lx, top, lz, r() < 0.5 ? ID.FLOWER_RED : ID.FLOWER_YELLOW);
    } else if (r() < 0.004) {                   // rare pumpkin
      this._setSolidOnTop(chunk, lx, top, lz, ID.PUMPKIN);
    }
  }

  _decorateForest(chunk, lx, lz, wx, wz, sy, ground, r) {
    if (ground !== ID.GRASS) return;
    const top = sy + 1;
    const k = r();
    if (k < 0.085) {                            // dense trees (oak + birch)
      this._tree(chunk, lx, lz, top, r() < 0.35 ? 'birch' : 'oak', r);
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

  _decorateSnow(chunk, lx, lz, wx, wz, sy, ground, r) {
    const top = sy + 1;
    if (ground === ID.SNOW || ground === ID.GRASS || ground === ID.DIRT) {
      if (r() < 0.010) {                        // hardy pine trees
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
