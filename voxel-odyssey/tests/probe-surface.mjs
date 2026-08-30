/* Sample the surface block + biome over a wide area and report the mix.
   Diagnostic only: answers "is the ground actually sand, or does it just
   look sandy?" without needing to eyeball a screenshot. */
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { default: WorldGen } = await import('../js/world/worldgen.js');
const { default: Blocks } = await import('../js/world/blocks.js');

const game = { seed: 0 };
const wg = new WorldGen(game);
wg.setSeed ? wg.setSeed(0x9e3779b9) : (wg.seed = 0x9e3779b9);

const SEA = 28;
const allCounts = new Map();
const landCounts = new Map();
const landBiomes = new Map();
const allBiomes = new Map();
let R = Number(process.argv[2] || 220);
let step = Number(process.argv[3] || 4);
let land = 0, total = 0;

for (let x = -R; x <= R; x += step) {
  for (let z = -R; z <= R; z += step) {
    total++;
    const h = wg.heightAt(x, z);
    const b = wg.biomeAt ? wg.biomeAt(x, z) : '?';
    const id = wg.blockAt(x, h, z);
    const key = (Blocks.get(id) || {}).key || String(id);
    const bname = typeof b === 'string' ? b : (b && b.name) || '?';
    allCounts.set(key, (allCounts.get(key) || 0) + 1);
    allBiomes.set(bname, (allBiomes.get(bname) || 0) + 1);
    // Only DRY ground is what a player sees as "the ground". Seafloor sand is
    // both correct and invisible under water, so mixing the two hides whether
    // the land itself has a sand problem.
    if (h >= SEA) {
      land++;
      landCounts.set(key, (landCounts.get(key) || 0) + 1);
      landBiomes.set(bname, (landBiomes.get(bname) || 0) + 1);
    }
  }
}

const pctOf = (n, d) => ((n / d) * 100).toFixed(1) + '%';
const top = (m, d) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, v]) => `${k}: ${pctOf(v, d)}`);

console.log(JSON.stringify({
  samples: total,
  radius: R,
  landFraction: pctOf(land, total),
  landSurfaceBlocks: top(landCounts, land),
  landBiomes: top(landBiomes, land),
  allSurfaceBlocks: top(allCounts, total),
  allBiomes: top(allBiomes, total),
}, null, 2));
