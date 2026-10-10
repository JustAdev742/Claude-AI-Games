/* =========================================================================
   biomeColor.js — biome-dependent colour tints for grass, foliage and water.

   The terrain textures are authored for a temperate "plains" climate, so a
   tint is a per-channel MULTIPLIER on that texture: (1,1,1) leaves it alone.
   Tints come from a small 3x3 table over (temperature, moisture), blended
   bilinearly, so colour changes smoothly across a climate gradient — there is
   no visible seam where one biome ends and the next begins, because there is
   no biome lookup here at all, only the continuous climate values.

   Pure functions with no Three.js dependency, so the mesher worker and the
   Node tests can both import it.
   ========================================================================= */

// GRASS[tempBand][moistBand] -> [r, g, b] multiplier.
//   temperature bands: cold (0), temperate (0.5), hot (1)
//   moisture bands:    dry (0),  middling (0.5),  wet (1)
const GRASS = [
  [[0.88, 1.06, 1.00], [0.74, 1.04, 0.97], [0.66, 1.00, 0.93]],   // cold: cool blue-green
  [[1.30, 1.04, 0.70], [1.00, 1.00, 1.00], [0.86, 1.06, 0.90]],   // temperate: plains is neutral
  [[1.70, 1.02, 0.50], [1.50, 1.05, 0.55], [0.78, 1.22, 0.58]],   // hot: dry savanna gold -> lush jungle
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Bilinear lookup in a 3x3 grid. t and m are 0..1.
function sample(grid, t, m, out) {
  const ft = clamp01(t) * 2, fm = clamp01(m) * 2;
  const i = Math.min(1, Math.floor(ft)), j = Math.min(1, Math.floor(fm));
  const u = ft - i, v = fm - j;
  const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j], d = grid[i + 1][j + 1];
  for (let k = 0; k < 3; k++) {
    const top = a[k] + (b[k] - a[k]) * v;
    const bot = c[k] + (d[k] - c[k]) * v;
    out[k] = top + (bot - top) * u;
  }
  return out;
}

// Worldgen's temperature/moisture rarely stray outside roughly 0.15..0.85 and
// 0.2..0.8, so feeding them straight into the table would never reach its
// colourful corners. Stretch the occupied range across the whole table; the
// centre (0.5, 0.5) maps to the centre, so plains stays neutral.
const stretchT = (t) => (t - 0.15) / 0.7;
const stretchM = (m) => (m - 0.2) / 0.6;

export function grassTint(t, m, out = [1, 1, 1]) { return sample(GRASS, stretchT(t), stretchM(m), out); }

// Leaves follow the same climate but vary less than grass does.
export function foliageTint(t, m, out = [1, 1, 1]) {
  grassTint(t, m, out);
  for (let k = 0; k < 3; k++) out[k] = 1 + (out[k] - 1) * 0.8;
  return out;
}

// Water: icy blue when cold, clear cyan when hot, murky green in wet,
// temperate wetlands (swamps).
export function waterTint(t, m, out = [1, 1, 1]) {
  const cold = clamp01((0.3 - t) / 0.3);
  const hot = clamp01((t - 0.6) / 0.3);
  const murk = clamp01((m - 0.7) / 0.25) * (1 - cold) * (1 - hot);
  out[0] = 1 - 0.18 * cold - 0.25 * hot - 0.22 * murk;
  out[1] = 1 - 0.05 * cold + 0.12 * hot - 0.02 * murk;
  out[2] = 1 + 0.10 * cold + 0.18 * hot - 0.22 * murk;
  return out;
}

/* Precompute the three tints for every column of a chunk from its climate
   array (temperature, moisture interleaved, indexed (lx * 16 + lz) * 2).
   Returns { grass, foliage, water }: Float32Array(columns * 3) each. */
export function buildColumnTints(climate, columns) {
  const grass = new Float32Array(columns * 3);
  const foliage = new Float32Array(columns * 3);
  const water = new Float32Array(columns * 3);
  const tmp = [1, 1, 1];
  for (let i = 0; i < columns; i++) {
    const t = climate[i * 2], m = climate[i * 2 + 1];
    grassTint(t, m, tmp); grass[i * 3] = tmp[0]; grass[i * 3 + 1] = tmp[1]; grass[i * 3 + 2] = tmp[2];
    foliageTint(t, m, tmp); foliage[i * 3] = tmp[0]; foliage[i * 3 + 1] = tmp[1]; foliage[i * 3 + 2] = tmp[2];
    waterTint(t, m, tmp); water[i * 3] = tmp[0]; water[i * 3 + 1] = tmp[1]; water[i * 3 + 2] = tmp[2];
  }
  return { grass, foliage, water };
}
