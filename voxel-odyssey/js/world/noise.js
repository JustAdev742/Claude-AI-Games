/* =========================================================================
   noise.js — deterministic gradient noise for procedural world generation.

   Implements classic Ken-Perlin improved noise (perlin2 / perlin3) on top of a
   seed-shuffled permutation table, plus the usual fractal helpers built from it:
     - fbm2  / fbm3  : fractional Brownian motion (summed octaves)         ~[-1,1]
     - ridge2        : ridged multifractal, great for sharp mountain spines  [0,1]

   Design goals (matching ARCHITECTURE.md):
     - Pure & deterministic: the same seed ALWAYS yields the same field.
     - No Three.js, no DOM — importable and testable under plain Node.
     - Allocation-free in the hot path: perlin2/perlin3 allocate nothing, and the
       fractal helpers only read scalars. The permutation table is built once in
       the constructor.

   The only external dependency is the deterministic RNG / math from utils.
   ========================================================================= */

import { mulberry32, lerp, fract } from '../core/utils.js';

/* ---- fade & gradient helpers ------------------------------------------- */

// Perlin's 6t^5 - 15t^4 + 10t^3 ease curve (a.k.a. smootherstep on [0,1]).
// Gives C2 continuity so the noise has no visible grid creases.
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/* 3D gradient: dot the corner gradient vector (selected by the low 4 bits of the
   hash) with the distance vector (x,y,z). This is the standard improved-Perlin
   gradient table folded into a switch — branch-predictable and allocation-free. */
function grad3(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/* 2D gradient: project the 3D gradient set onto the plane (z component dropped).
   We reuse the same hash convention so 2D and 3D fields stay correlated where it
   matters and remain cheap. */
function grad2(hash, x, y) {
  const h = hash & 7;       // 8 gradient directions is plenty for 2D
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? 2 * v : -2 * v);
}

/* ========================================================================= */

export class Noise {
  /**
   * @param {number} seed integer seed; same seed → same noise field everywhere.
   */
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    // Doubled permutation table (512 entries) so we never have to wrap indices
    // with a modulo in the hot path — `perm[i + 1]` is always in range.
    this.perm = new Uint8Array(512);
    this._buildPermutation(this.seed);
  }

  /**
   * (Re)build the seed-shuffled permutation table. Starts with the identity
   * 0..255, then Fisher–Yates shuffles it using a mulberry32 stream derived from
   * the seed. Finally the 256 entries are duplicated into the upper half.
   * @param {number} seed
   */
  _buildPermutation(seed) {
    const perm = this.perm;
    // Identity permutation.
    for (let i = 0; i < 256; i++) perm[i] = i;

    // Deterministic shuffle. mulberry32 returns floats in [0,1).
    const rand = mulberry32(seed >>> 0);
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0; // unbiased enough for procedural use
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }

    // Duplicate so indices in [0,510] are valid without wrapping.
    for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  }

  /** Re-seed the field in place (reuses the existing table buffer). */
  reseed(seed) {
    this.seed = seed >>> 0;
    this._buildPermutation(this.seed);
    return this;
  }

  /* ---- core Perlin ----------------------------------------------------- */

  /**
   * 2D classic Perlin noise.
   * @returns {number} value in roughly [-1, 1] (theoretical bound ~±0.7,
   *          empirically scaled here to span close to the full [-1,1]).
   */
  perlin2(x, y) {
    const perm = this.perm;

    // Unit grid cell coordinates (low 8 bits for table lookup).
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    // Relative position inside the cell.
    x = fract(x);
    y = fract(y);

    // Fade curves for x and y.
    const u = fade(x);
    const v = fade(y);

    // Hash the four cell corners.
    const A = perm[X] + Y;
    const B = perm[X + 1] + Y;

    // Blend the four corner gradients.
    const x1 = lerp(grad2(perm[A], x, y), grad2(perm[B], x - 1, y), u);
    const x2 = lerp(grad2(perm[A + 1], x, y - 1), grad2(perm[B + 1], x - 1, y - 1), u);

    // Empirical normalization: raw blended 2D gradients peak around ±1.06 here;
    // scale slightly down and clamp so the result is guaranteed to stay in [-1,1].
    const r = lerp(x1, x2, v) * 0.92;
    return r < -1 ? -1 : r > 1 ? 1 : r;
  }

  /**
   * 3D classic Perlin noise.
   * @returns {number} value in roughly [-1, 1].
   */
  perlin3(x, y, z) {
    const perm = this.perm;

    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;

    x = fract(x);
    y = fract(y);
    z = fract(z);

    const u = fade(x);
    const v = fade(y);
    const w = fade(z);

    // Hash coordinates of the 8 cube corners.
    const A = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;

    // Trilinear blend of the 8 corner gradients.
    const x1 = lerp(grad3(perm[AA], x, y, z), grad3(perm[BA], x - 1, y, z), u);
    const x2 = lerp(grad3(perm[AB], x, y - 1, z), grad3(perm[BB], x - 1, y - 1, z), u);
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(grad3(perm[AA + 1], x, y, z - 1), grad3(perm[BA + 1], x - 1, y, z - 1), u);
    const x4 = lerp(grad3(perm[AB + 1], x, y - 1, z - 1), grad3(perm[BB + 1], x - 1, y - 1, z - 1), u);
    const y2 = lerp(x3, x4, v);

    // Raw improved-Perlin 3D peaks near ±0.82; scale up to better fill [-1,1]
    // and clamp for a hard guarantee on the documented range.
    const r = lerp(y1, y2, w) * 1.18;
    return r < -1 ? -1 : r > 1 ? 1 : r;
  }

  /* ---- fractal helpers ------------------------------------------------- */

  /**
   * 2D fractional Brownian motion: sum of octaves at increasing frequency and
   * decreasing amplitude. Normalized by total amplitude so the result stays in
   * approximately [-1, 1] regardless of octave count.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} octaves number of summed layers (>=1)
   * @param {number} freq    starting frequency multiplier
   * @param {number} lac     lacunarity — frequency growth per octave (typ. ~2.0)
   * @param {number} gain    amplitude falloff per octave (typ. ~0.5)
   * @returns {number} ~[-1, 1]
   */
  fbm2(x, y, octaves = 4, freq = 1, lac = 2.0, gain = 0.5) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let f = freq;
    const n = octaves | 0;
    for (let i = 0; i < n; i++) {
      sum += amp * this.perlin2(x * f, y * f);
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * 3D fractional Brownian motion. See {@link Noise#fbm2}.
   * @returns {number} ~[-1, 1]
   */
  fbm3(x, y, z, octaves = 4, freq = 1, lac = 2.0, gain = 0.5) {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let f = freq;
    const n = octaves | 0;
    for (let i = 0; i < n; i++) {
      sum += amp * this.perlin3(x * f, y * f, z * f);
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * 2D ridged multifractal noise — folds each octave with 1 - |perlin| to turn
   * the smooth valleys into sharp ridges, then squares for crisper crests. Ideal
   * for mountain ranges and eroded terrain spines.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} octaves
   * @param {number} freq
   * @returns {number} value in [0, 1]
   */
  ridge2(x, y, octaves = 4, freq = 1) {
    // Fixed lacunarity/gain tuned for nice ridges; weight emphasizes higher
    // octaves where previous octaves were already high (classic Musgrave trick).
    const lac = 2.0;
    const gain = 0.5;
    const offset = 1.0;

    let sum = 0;
    let norm = 0;
    let amp = 0.5;
    let f = freq;
    let prev = 1.0;
    const n = octaves | 0;

    for (let i = 0; i < n; i++) {
      // Ridge transform: peaks at perlin == 0, valleys toward ±1.
      let r = offset - Math.abs(this.perlin2(x * f, y * f));
      r *= r;            // sharpen the ridge
      r *= prev;         // weight by the previous octave (multifractal coupling)
      prev = r;

      sum += r * amp;
      norm += amp;

      amp *= gain;
      f *= lac;
    }

    // Normalize to a stable [0,1] range.
    const v = norm > 0 ? sum / norm : 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

export default Noise;
