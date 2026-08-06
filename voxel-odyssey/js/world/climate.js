/* =========================================================================
   climate.js — layered climate fields, spline terrain shaping, biome choice.

   WHY THE OLD GENERATOR PRODUCED ARTIFICIAL TERRAIN
   ------------------------------------------------
   It derived height FROM the biome: each biome carried a `base` elevation and
   the column height was `biome.base + noise`. That inverts cause and effect.
   A biome is a description of a *place* — its climate and its shape — so
   letting it dictate elevation means:

     - every biome border is a step in the ground, because two biomes have
       different `base` values and the classifier is a hard if/else cascade;
     - mountains only exist where the classifier said "mountains", so they
       appear as patches rather than as ranges with foothills and valleys;
     - smoothing can only ever paper over it (the old code averaged five
       samples at radius 6, which blurs a 1-block seam into a 6-block ramp).

   THIS MODULE INVERTS THAT
   ------------------------
   Terrain shape comes first, from three independent fields combined through
   splines; the biome is then *selected* by the climate at that point plus the
   terrain that resulted. Nothing about the biome feeds back into height, so a
   forest/desert border is invisible in the ground — only the surface blocks
   and vegetation change, which is exactly how it should read.

     continentalness  very large scale. Decides deep ocean -> shelf -> coast ->
                      inland -> far inland. Supplies the base OFFSET.
     erosion          large scale. Decides how much vertical variation the
                      landscape is allowed. High erosion flattens everything
                      into plains and plateaus even where the ridge field is
                      screaming; low erosion permits dramatic relief. This one
                      field is what produces both flat farmland and alpine
                      terrain from the same noise.
     peaks & valleys  derived from `weirdness` folded into a ridge shape.
                      Supplies the actual up/down variation, SCALED by erosion.

     height = offset(continentalness) + factor(erosion) * peaks

   Splines rather than multiplies: a spline can be flat over a range and steep
   over another, which is how you get a continental shelf that stays underwater
   across a wide band of continentalness and then rises quickly at the coast.
   A linear scale cannot express that.

   All fields are pure functions of (worldX, worldZ) and the seed, so two
   chunks meeting at a border compute identical values with no stitching.
   ========================================================================= */

import { Noise } from './noise.js';
import { clamp } from '../core/utils.js';

/* -------------------------------------------------------------------------
   Spline — piecewise-linear mapping with smooth (smoothstep) segments.

   Control points must be sorted by x. Sampling outside the range clamps to
   the end values rather than extrapolating, so an extreme noise excursion
   can never send terrain to absurd heights.
   ------------------------------------------------------------------------- */
export class Spline {
  constructor(points) {
    this.points = points;
  }

  at(x) {
    const p = this.points;
    if (x <= p[0][0]) return p[0][1];
    const last = p.length - 1;
    if (x >= p[last][0]) return p[last][1];

    for (let i = 0; i < last; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[i + 1];
      if (x > x1) continue;
      const span = x1 - x0;
      if (span <= 1e-9) return y1;
      const t = (x - x0) / span;
      // Smoothstep rather than linear: a linear join leaves a visible crease
      // in the terrain wherever two segments meet at different gradients.
      const s = t * t * (3 - 2 * t);
      return y0 + (y1 - y0) * s;
    }
    return p[last][1];
  }
}

/* Sea level and the vertical budget we have to work with. CHUNK_SY is 80,
   which is short compared to real Minecraft — the splines below are scaled
   for that rather than copied from a taller world. */
export const SEA_LEVEL = 28;

/* ---- terrain splines ----------------------------------------------------

   OFFSET: where the ground sits before any variation is added. The flat
   stretch from -1.0 to -0.45 is the abyssal plain; the steep climb from -0.2
   to 0.1 is the coastline, which is why beaches are narrow and shores are
   well defined instead of the ground drifting vaguely through sea level. */
const OFFSET_SPLINE = new Spline([
  [-1.00, SEA_LEVEL - 20],   // deep ocean
  [-0.60, SEA_LEVEL - 14],   // ocean floor
  [-0.45, SEA_LEVEL - 10],   // shelf
  [-0.20, SEA_LEVEL - 3],    // shallows
  [-0.05, SEA_LEVEL + 1],    // shoreline
  [0.10, SEA_LEVEL + 4],     // coastal plain
  [0.35, SEA_LEVEL + 8],     // lowland
  [0.65, SEA_LEVEL + 13],    // inland
  [1.00, SEA_LEVEL + 18],    // far inland plateau
]);

/* FACTOR: how much the peaks/valleys field is allowed to move the ground.
   Note it is NOT monotonic — the dip around 0.35 creates plateaus (a band of
   erosion values that flattens terrain mid-range), which is what stops the
   world from being uniformly lumpy. */
const FACTOR_SPLINE = new Spline([
  [-1.00, 34],   // barely eroded: alpine, dramatic relief
  [-0.70, 26],
  [-0.35, 16],   // hills
  [0.00, 9],     // gentle rolling
  [0.35, 3],     // plateau / flatland band
  [0.60, 7],     // some relief returns
  [1.00, 2],     // heavily eroded: flat
]);

/* How sharply peaks are pinched. Higher = more alpine, less rounded. */
const PEAK_SHARPNESS = 1.15;

/* -------------------------------------------------------------------------
   Climate sampler
   ------------------------------------------------------------------------- */

/* Independent salts so channels never correlate. Two fields sharing a seed
   produce terrain where (say) every mountain is also cold, which reads as
   obviously synthetic. */
const SALT = {
  continent: 101,
  erosion: 211,
  weird: 307,
  temp: 401,
  humid: 503,
  river: 601,
  detail: 709,
  cave: 811,
  cheese: 907,
  ore: 1009,
  decor: 1103,
};

export class Climate {
  constructor(seed = 0) {
    this.setSeed(seed);
    // Column cache. Generation asks for the same column repeatedly (fill,
    // decoration, surface rules, neighbour probing during tree placement), and
    // each sample is several fbm evaluations.
    this._cache = new Map();
    this._cacheLimit = 24000;
  }

  setSeed(seed) {
    this.seed = seed | 0;
    const n = (salt) => new Noise((this.seed ^ (salt * 2654435761)) >>> 0);
    this.nContinent = n(SALT.continent);
    this.nErosion = n(SALT.erosion);
    this.nWeird = n(SALT.weird);
    this.nTemp = n(SALT.temp);
    this.nHumid = n(SALT.humid);
    this.nRiver = n(SALT.river);
    this.nDetail = n(SALT.detail);
    this.nCave = n(SALT.cave);
    this.nCheese = n(SALT.cheese);
    this.nOre = n(SALT.ore);
    this.nDecor = n(SALT.decor);
    if (this._cache) this._cache.clear();
  }

  /* ---- raw fields, all in roughly [-1, 1] ---------------------------- */

  // Frequencies set the SCALE of the world. Continentalness at 0.0009 gives
  // landmasses on the order of a thousand blocks, which is what makes biomes
  // feel large; the old generator's 0.0028 produced features every ~250
  // blocks, so you crossed three biomes on a short walk.
  continentalness(x, z) { return this.nContinent.fbm2(x, z, 4, 0.0009, 2.0, 0.5); }
  erosion(x, z) { return this.nErosion.fbm2(x, z, 4, 0.0016, 2.0, 0.5); }
  weirdness(x, z) { return this.nWeird.fbm2(x, z, 4, 0.0035, 2.0, 0.5); }
  temperature(x, z) { return this.nTemp.fbm2(x, z, 3, 0.0011, 2.0, 0.5); }
  humidity(x, z) { return this.nHumid.fbm2(x, z, 3, 0.0014, 2.0, 0.5); }

  /* Peaks & valleys, derived from weirdness rather than being its own noise.
     Folding it this way means a region's "weird" character and its relief are
     linked — ridges land on the same features that drive biome variants, so
     mountain ranges line up with the terrain instead of cross-hatching it. */
  peaksValleys(weird) {
    // 1 - |3|w| - 2| maps w in [-1,1] to a folded ridge in [-1,1].
    const folded = 1 - Math.abs(3 * Math.abs(weird) - 2);
    return clamp(folded, -1, 1);
  }

  /* River field: 0 at the channel centre, 1 far away.
     Using 1-|noise| makes the zero-crossing of a smooth field into a
     continuous winding line, which is why rivers connect and meander instead
     of appearing as disconnected puddles. */
  riverStrength(x, z) {
    const n = this.nRiver.fbm2(x, z, 3, 0.0021, 2.0, 0.5);
    return Math.abs(n);
  }

  /* ---- combined column sample ---------------------------------------- */

  /**
   * Everything about a column, cached.
   * @returns {{continent,erosion,weird,peaks,temp,humid,river,height,biome}}
   */
  sample(x, z) {
    const key = `${x},${z}`;
    const hit = this._cache.get(key);
    if (hit) return hit;

    const continent = this.continentalness(x, z);
    const erosion = this.erosion(x, z);
    const weird = this.weirdness(x, z);
    const peaks = this.peaksValleys(weird);
    const temp = this.temperature(x, z);
    const humid = this.humidity(x, z);
    const river = this.riverStrength(x, z);

    const height = this._shapeHeight(x, z, continent, erosion, peaks, river);

    const out = {
      continent, erosion, weird, peaks, temp, humid, river, height,
      biome: null,   // filled by the caller's biome table
    };

    // Simple size cap rather than a true LRU: generation walks the world in
    // chunk-sized locality, so the useful working set is recent by nature and
    // a periodic wipe costs less than tracking access order.
    if (this._cache.size >= this._cacheLimit) this._cache.clear();
    this._cache.set(key, out);
    return out;
  }

  /* The spline combination described in the file header, plus rivers. */
  _shapeHeight(x, z, continent, erosion, peaks, river) {
    const offset = OFFSET_SPLINE.at(continent);
    const factor = FACTOR_SPLINE.at(erosion);

    // Sharpen peaks without touching valleys: raising |peaks| to a power >1
    // pinches ridges while leaving basins broad, which is the difference
    // between alpine ridges and rolling dunes.
    const sign = peaks < 0 ? -1 : 1;
    const shaped = sign * Math.pow(Math.abs(peaks), PEAK_SHARPNESS);

    let h = offset + shaped * factor;

    // Fine detail, scaled by how much relief this area allows so flat
    // plateaus stay flat instead of being sprinkled with noise.
    const detail = this.nDetail.fbm2(x, z, 3, 0.031, 2.2, 0.5);
    h += detail * Math.min(3.0, factor * 0.12);

    // --- rivers ---------------------------------------------------------
    // Carve only on land, and fade the carve out as the terrain rises so a
    // river doesn't slice a canyon through a mountain range it would never
    // have climbed in the first place.
    if (h > SEA_LEVEL - 2) {
      const RIVER_W = 0.055;
      if (river < RIVER_W) {
        const t = 1 - (river / RIVER_W);          // 0 at bank, 1 at centre
        const carve = t * t * (3 - 2 * t);        // smooth banks
        const altitudeFade = clamp(1 - (h - SEA_LEVEL) / 45, 0.15, 1);
        const target = SEA_LEVEL - 2;
        h = h + (target - h) * carve * altitudeFade;
      }
    }

    return clamp(Math.round(h), 1, 74);
  }

  clearCache() { this._cache.clear(); }
}

/* =========================================================================
   Biome table.

   Each entry declares the RANGE of climate parameters it occupies. Selection
   picks the entry whose ranges the sample sits inside (or nearest to), which
   has two properties a hard if/else cascade cannot give you:

     - impossible combinations cannot occur. There is no entry for hot +
       freezing, so a hot region can never resolve to snow no matter what the
       other fields do — the classifier does not have to enumerate exclusions.
     - unlisted combinations still resolve, to the nearest sensible neighbour,
       rather than falling through to a default that looks out of place.

   Ranges are in the raw [-1,1] noise space of each field.
   ========================================================================= */

export const BIOME_TABLE = [
  // --- oceanic -------------------------------------------------------
  { name: 'deep_ocean', continent: [-1.0, -0.55], temp: [-1, 1], humid: [-1, 1], erosion: [-1, 1] },
  { name: 'ocean', continent: [-0.55, -0.22], temp: [-1, 0.6], humid: [-1, 1], erosion: [-1, 1] },
  { name: 'frozen_ocean', continent: [-0.55, -0.22], temp: [-1, -0.55], humid: [-1, 1], erosion: [-1, 1] },
  { name: 'beach', continent: [-0.22, -0.02], temp: [-0.5, 1], humid: [-1, 1], erosion: [-1, 1] },
  { name: 'snowy_beach', continent: [-0.22, -0.02], temp: [-1, -0.5], humid: [-1, 1], erosion: [-1, 1] },

  // --- hot & dry -----------------------------------------------------
  { name: 'desert', continent: [-0.02, 1], temp: [0.45, 1], humid: [-1, -0.25], erosion: [-0.2, 1] },
  { name: 'savanna', continent: [-0.02, 1], temp: [0.3, 0.85], humid: [-0.25, 0.2], erosion: [0.0, 1] },
  { name: 'badlands', continent: [-0.02, 1], temp: [0.55, 1], humid: [-1, -0.4], erosion: [-1, -0.2] },

  // --- temperate -----------------------------------------------------
  { name: 'plains', continent: [-0.02, 1], temp: [-0.3, 0.45], humid: [-0.4, 0.25], erosion: [0.1, 1] },
  { name: 'forest', continent: [-0.02, 1], temp: [-0.25, 0.4], humid: [0.15, 0.7], erosion: [-0.4, 1] },
  { name: 'birch_forest', continent: [-0.02, 1], temp: [-0.1, 0.25], humid: [0.3, 0.7], erosion: [-0.2, 0.6] },
  { name: 'swamp', continent: [-0.02, 0.5], temp: [0.0, 0.5], humid: [0.6, 1], erosion: [0.4, 1] },
  { name: 'jungle', continent: [-0.02, 1], temp: [0.4, 0.9], humid: [0.55, 1], erosion: [-0.3, 0.8] },

  // --- cold ----------------------------------------------------------
  { name: 'taiga', continent: [-0.02, 1], temp: [-0.7, -0.2], humid: [0.0, 0.7], erosion: [-0.4, 1] },
  { name: 'snowy_plains', continent: [-0.02, 1], temp: [-1, -0.5], humid: [-1, 0.3], erosion: [0.0, 1] },
  { name: 'snowy_taiga', continent: [-0.02, 1], temp: [-1, -0.55], humid: [0.2, 1], erosion: [-0.4, 1] },

  // --- high relief (low erosion). These are reachable at any temperature,
  //     so a mountain range crosses climate zones as a real one does.
  { name: 'mountains', continent: [0.1, 1], temp: [-0.5, 0.6], humid: [-1, 1], erosion: [-1, -0.5] },
  { name: 'snowy_mountains', continent: [0.1, 1], temp: [-1, -0.35], humid: [-1, 1], erosion: [-1, -0.4] },
  { name: 'stony_peaks', continent: [0.3, 1], temp: [0.2, 1], humid: [-1, 1], erosion: [-1, -0.65] },
];

/**
 * Choose a biome by nearest match in parameter space.
 *
 * Distance is the squared sum of how far each parameter falls OUTSIDE its
 * range (zero when inside), so any entry containing the sample wins outright
 * and otherwise the closest one does. Cheap, total, and it degrades sensibly
 * at the edges of the space instead of falling off a cliff.
 */
export function selectBiome(sample) {
  const axes = [
    ['continent', sample.continent],
    ['temp', sample.temp],
    ['humid', sample.humid],
    ['erosion', sample.erosion],
  ];

  let best = null;
  let bestD = Infinity;

  for (const entry of BIOME_TABLE) {
    let d = 0;
    for (const [axis, value] of axes) {
      const range = entry[axis];
      if (!range) continue;
      if (value < range[0]) { const e = range[0] - value; d += e * e; }
      else if (value > range[1]) { const e = value - range[1]; d += e * e; }
    }
    if (d < bestD) { bestD = d; best = entry; }
    if (d === 0) break;   // exact containment: nothing can beat it
  }

  return best ? best.name : 'plains';
}

export default Climate;
