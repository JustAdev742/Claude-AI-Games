/* Biome tint tests: the colour model, its integration into the mesher, and
   that worldgen records the climate the mesher needs. */
import { grassTint, foliageTint, waterTint, buildColumnTints } from '../js/world/biomeColor.js';
import { meshChunk, Chunk } from '../js/world/chunk.js';
import { WorldGen } from '../js/world/worldgen.js';
import { ID } from '../js/world/blocks.js';
import { CHUNK_SX, CHUNK_SZ, localIndex } from '../js/world/constants.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

/* ---- the colour model ---- */
{
  const plains = grassTint(0.5, 0.5);
  ok('model: temperate/middling is neutral', plains.every((v) => near(v, 1)), plains.join(','));

  const savanna = grassTint(1, 0), jungle = grassTint(1, 1), tundra = grassTint(0, 0.3);
  ok('model: hot+dry is warmer (more red vs green) than hot+wet', savanna[0] / savanna[1] > jungle[0] / jungle[1] + 0.3);
  ok('model: jungle is the greenest', jungle[1] / jungle[0] > 1.3);
  ok('model: cold is bluer than hot', tundra[2] / tundra[0] > savanna[2] / savanna[0]);

  // Colour must change smoothly across the climate field: no seams between
  // biomes, because there is no biome lookup in here.
  let worst = 0;
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let t = 0; t < 1; t += 0.01) for (let m = 0; m < 1; m += 0.01) {
    grassTint(t, m, a); grassTint(t + 0.01, m, b);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
    grassTint(t, m + 0.01, b);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
  }
  ok('model: continuous (largest step per 0.01 of climate)', worst < 0.05, worst.toFixed(4));

  // Out-of-range inputs clamp instead of extrapolating.
  const wild = grassTint(5, -3);
  ok('model: out-of-range climate is clamped', wild.every((v, k) => near(v, grassTint(1, 0)[k])));

  let bounded = true;
  for (let t = 0; t <= 1; t += 0.05) for (let m = 0; m <= 1; m += 0.05) {
    for (const f of [grassTint, foliageTint, waterTint]) if (f(t, m).some((v) => v < 0.4 || v > 1.7)) bounded = false;
  }
  ok('model: every tint stays in a sane range', bounded);

  const g = grassTint(1, 0), f = foliageTint(1, 0);
  ok('model: foliage varies less than grass', [0, 1, 2].every((k) => Math.abs(f[k] - 1) <= Math.abs(g[k] - 1) + 1e-9));

  const cw = waterTint(0.05, 0.5), hw = waterTint(0.9, 0.2), sw = waterTint(0.5, 0.95), nw = waterTint(0.5, 0.4);
  ok('water: temperate is untinted', nw.every((v) => near(v, 1)), nw.join(','));
  ok('water: warm seas are clearer/cyan (less red, more blue)', hw[0] < nw[0] && hw[2] > nw[2]);
  ok('water: swamps are murky green (blue drops)', sw[2] < nw[2] && sw[1] > sw[2]);
  ok('water: cold seas are icy blue', cw[2] > cw[0]);
}

/* ---- column tint tables ---- */
{
  const climate = new Float32Array([0.5, 0.5, 1, 0]);
  const t = buildColumnTints(climate, 2);
  ok('tables: one RGB triple per column per kind', t.grass.length === 6 && t.foliage.length === 6 && t.water.length === 6);
  ok('tables: column 0 neutral, column 1 warm', near(t.grass[0], 1) && t.grass[3] > 1.4);
}

/* ---- mesher integration ---- */
{
  const atlas = { layerFor: () => 3 };          // any non-negative layer = "textured"
  const make = (id) => {
    const c = new Chunk(0, 0);
    c.setLocal(5, 10, 5, id);                    // one block, all faces exposed
    return c;
  };
  const colourOfTop = (data) => {
    // Face 2 (+Y) is emitted third: vertices 8..11 of the bucket.
    const c = data.opaque.colors;
    return [c[8 * 3], c[8 * 3 + 1], c[8 * 3 + 2]];
  };
  const mesh = (chunk, climate) => meshChunk(chunk, () => 0, { atlas, climate });
  const fill = (t, m) => { const a = new Float32Array(CHUNK_SX * CHUNK_SZ * 2); for (let i = 0; i < a.length; i += 2) { a[i] = t; a[i + 1] = m; } return a; };

  const none = colourOfTop(mesh(make(ID.GRASS), null));
  const hot = colourOfTop(mesh(make(ID.GRASS), fill(1, 0)));
  const cold = colourOfTop(mesh(make(ID.GRASS), fill(0, 0.4)));
  ok('mesher: no climate -> neutral grass', none.every((v) => v > 0.9 && v <= 1.01), none.join(','));
  ok('mesher: hot dry grass is yellower than neutral', hot[0] / hot[1] > none[0] / none[1] + 0.3);
  ok('mesher: cold grass is bluer than hot grass', cold[2] / cold[0] > hot[2] / hot[0]);

  const stoneHot = colourOfTop(mesh(make(ID.STONE), fill(1, 0)));
  const stoneNone = colourOfTop(mesh(make(ID.STONE), null));
  ok('mesher: stone is never tinted', stoneHot.every((v, k) => near(v, stoneNone[k], 1e-6)));

  const leafHot = colourOfTop(mesh(make(ID.LEAVES), fill(1, 0)));
  const leafNone = colourOfTop(mesh(make(ID.LEAVES), null));
  ok('mesher: oak leaves take the tint', Math.abs(leafHot[0] - leafNone[0]) > 0.1);
  const pineHot = colourOfTop(mesh(make(ID.PINE_LEAVES), fill(1, 0)));
  const pineNone = colourOfTop(mesh(make(ID.PINE_LEAVES), null));
  ok('mesher: pine needles stay conifer green', pineHot.every((v, k) => near(v, pineNone[k], 1e-6)));

  // Grass sides are tinted at 60%: between neutral and the full top tint.
  const sideColour = (climate) => {
    const c = mesh(make(ID.GRASS), climate).opaque.colors;
    return [c[0], c[1], c[2]];                  // face 0 (+X), first vertex
  };
  const sNone = sideColour(null), sHot = sideColour(fill(1, 0));
  const topShift = hot[0] / none[0], sideShift = sHot[0] / sNone[0];
  ok('mesher: grass sides tint less than the top', sideShift > 1.05 && sideShift < topShift, `${sideShift.toFixed(2)} vs ${topShift.toFixed(2)}`);

  // Water takes the water tint.
  const water = (climate) => {
    const c = new Chunk(0, 0);
    c.setLocal(5, 10, 5, ID.WATER);
    const d = meshChunk(c, () => 0, { atlas, climate });
    const col = d.water.colors;
    return [col[0], col[1], col[2]];
  };
  const wN = water(null), wH = water(fill(0.9, 0.2));
  ok('mesher: tropical water is tinted', Math.abs(wH[0] - wN[0]) > 0.05, `${wN} vs ${wH}`);
}

/* ---- worldgen records the climate ---- */
{
  const wg = new WorldGen({ seed: 5 }); wg.setSeed(5);
  const lo = { t: 1, m: 1 }, hi = { t: 0, m: 0 };
  let ok01 = true, count = 0;
  for (let cx = -30; cx <= 30; cx += 6) for (let cz = -30; cz <= 30; cz += 6) {
    const c = new Chunk(cx, cz); wg.generateChunk(c);
    if (!c.climate || c.climate.length !== CHUNK_SX * CHUNK_SZ * 2) { ok01 = false; continue; }
    for (let i = 0; i < c.climate.length; i += 2) {
      const t = c.climate[i], m = c.climate[i + 1];
      if (!(t >= 0 && t <= 1 && m >= 0 && m <= 1)) ok01 = false;
      lo.t = Math.min(lo.t, t); hi.t = Math.max(hi.t, t); lo.m = Math.min(lo.m, m); hi.m = Math.max(hi.m, m);
    }
    count++;
  }
  ok('worldgen: every chunk records a 0..1 climate', ok01 && count > 50);
  ok('worldgen: climate varies across the world', hi.t - lo.t > 0.4 && hi.m - lo.m > 0.4, `t ${lo.t.toFixed(2)}..${hi.t.toFixed(2)} m ${lo.m.toFixed(2)}..${hi.m.toFixed(2)}`);
}

console.log(`\n==== biome colour: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
