/* Node unit tests for the pure-logic modules (no Three.js, no browser).
   Run with: node tests/run.js  (from the project root). */

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; /* console.log('  ok  ' + name); */ }
  else { failed++; fails.push(name + (extra ? ' — ' + extra : '')); console.error('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
async function section(name, fn) {
  console.log('\n# ' + name);
  try { await fn(); } catch (e) { failed++; fails.push(name + ' threw: ' + e.message); console.error('  THREW', e); }
}

const G = () => ({ events: { emit() {}, on() {}, off() {} }, state: { settings: {}, get() {}, set() {} } });

await section('utils', async () => {
  const u = await import('../js/core/utils.js');
  ok('clamp', u.clamp(5, 0, 3) === 3);
  ok('lerp', Math.abs(u.lerp(0, 10, 0.5) - 5) < 1e-9);
  const r1 = new u.RNG(42), r2 = new u.RNG(42);
  ok('RNG deterministic', r1.next() === r2.next());
  ok('hashString stable', u.hashString('abc') === u.hashString('abc'));
});

await section('blocks', async () => {
  const { default: Blocks, ID } = await import('../js/world/blocks.js');
  ok('air id 0', ID.AIR === 0);
  ok('grass solid', Blocks.isSolid(ID.GRASS));
  ok('air not solid', !Blocks.isSolid(ID.AIR));
  ok('water liquid', Blocks.isLiquid(ID.WATER));
  ok('faceColor top grass differs from side', JSON.stringify(Blocks.faceColor(ID.GRASS, 2)) !== JSON.stringify(Blocks.faceColor(ID.GRASS, 0)));
  ok('cull face vs opaque', Blocks.shouldRenderFace(ID.STONE, ID.STONE) === false);
  ok('render face vs air', Blocks.shouldRenderFace(ID.STONE, ID.AIR) === true);
});

await section('items', async () => {
  const { default: Items } = await import('../js/items/items.js');
  ok('cobblestone exists', !!Items.get('cobblestone'));
  ok('wood_pickaxe is tool', Items.isTool('wood_pickaxe'));
  ok('diamond_sword is tool', Items.isTool('diamond_sword'));
  ok('dirt placeable', Items.isPlaceable('dirt'));
  ok('stack size default', Items.stackSize('cobblestone') === 64);
  ok('dropFor stone = cobblestone', Items.dropFor(1) === 'cobblestone');
});

await section('noise', async () => {
  const { Noise } = await import('../js/world/noise.js');
  const n1 = new Noise(123), n2 = new Noise(123), n3 = new Noise(456);
  const a = n1.perlin2(1.5, 2.5), b = n2.perlin2(1.5, 2.5);
  ok('perlin2 deterministic', a === b);
  ok('perlin2 in range', a >= -1.001 && a <= 1.001, 'val=' + a);
  ok('different seed differs', n3.perlin2(1.5, 2.5) !== a);
  const f = n1.fbm2(3.1, 4.2, 4, 1, 2, 0.5);
  ok('fbm2 finite', Number.isFinite(f), 'val=' + f);
  if (n1.perlin3) ok('perlin3 in range', Math.abs(n1.perlin3(0.3, 0.7, 0.9)) <= 1.001);
  if (n1.ridge2) { const r = n1.ridge2(0.5, 0.5, 4, 1); ok('ridge2 in [0,1]', r >= -0.001 && r <= 1.001, 'val=' + r); }
});

await section('chunk + meshing', async () => {
  const { Chunk, meshChunk } = await import('../js/world/chunk.js');
  const { CHUNK_SX, CHUNK_SY, CHUNK_SZ } = await import('../js/world/constants.js');
  const { ID } = await import('../js/world/blocks.js');
  const c = new Chunk(0, 0);
  ok('chunk getLocal default air', c.getLocal(0, 5, 0) === ID.AIR);
  c.setLocal(2, 10, 3, ID.STONE);
  ok('chunk setLocal/getLocal', c.getLocal(2, 10, 3) === ID.STONE);
  ok('chunk out-of-range air', c.getLocal(0, CHUNK_SY + 5, 0) === ID.AIR);
  // fill a floor
  for (let x = 0; x < CHUNK_SX; x++) for (let z = 0; z < CHUNK_SZ; z++) c.setLocal(x, 0, z, ID.GRASS);
  const getBlock = (wx, wy, wz) => {
    if (wx < 0 || wz < 0 || wx >= CHUNK_SX || wz >= CHUNK_SZ || wy < 0 || wy >= CHUNK_SY) return ID.AIR;
    return c.getLocal(wx, wy, wz);
  };
  const mesh = meshChunk(c, getBlock, { ao: true, worldOffset: { x: 0, z: 0 } });
  ok('mesh has buckets', mesh && mesh.opaque && mesh.water && mesh.cross);
  ok('mesh opaque has geometry', mesh.opaque.positions.length > 0, 'len=' + (mesh.opaque.positions.length));
  ok('mesh positions multiple of 3', mesh.opaque.positions.length % 3 === 0);
  ok('mesh indices present', mesh.opaque.indices.length > 0);
  ok('colors match positions', mesh.opaque.colors.length === mesh.opaque.positions.length);
});

await section('worldgen', async () => {
  const { WorldGen } = await import('../js/world/worldgen.js');
  const { Chunk } = await import('../js/world/chunk.js');
  const { ID } = await import('../js/world/blocks.js');
  const { CHUNK_SY } = await import('../js/world/constants.js');
  const wg = new WorldGen(G());
  wg.setSeed(2024);
  if (wg.init) await wg.init();
  const c1 = new Chunk(0, 0), c2 = new Chunk(0, 0);
  wg.generateChunk(c1); wg.generateChunk(c2);
  let nonAir = 0, sameAsC2 = true;
  for (let i = 0; i < c1.blocks.length; i++) { if (c1.blocks[i] !== ID.AIR) nonAir++; if (c1.blocks[i] !== c2.blocks[i]) sameAsC2 = false; }
  ok('worldgen fills blocks', nonAir > 500, 'nonAir=' + nonAir);
  ok('worldgen deterministic', sameAsC2);
  ok('bedrock at y=0 somewhere', c1.getLocal(8, 0, 8) === ID.BEDROCK, 'got ' + c1.getLocal(8, 0, 8));
  const h = wg.heightAt(8, 8);
  ok('heightAt sane', h > 0 && h < CHUNK_SY, 'h=' + h);
  ok('biomeAt returns string', typeof wg.biomeAt(0, 0) === 'string');
});

await section('inventory', async () => {
  const { Inventory } = await import('../js/items/inventory.js');
  const inv = new Inventory(G());
  if (inv.init) inv.init();
  ok('size 36', inv.size === 36 || inv.slots.length === 36);
  const rem = inv.add('cobblestone', 10);
  ok('add returns 0 remaining', rem === 0, 'rem=' + rem);
  ok('count 10', inv.count('cobblestone') === 10);
  inv.add('cobblestone', 60); // exceed a stack
  ok('stacks correctly', inv.count('cobblestone') === 70);
  ok('has works', inv.has('cobblestone', 70));
  const consumed = inv.consume('cobblestone', 5);
  ok('consume returns true', consumed === true);
  ok('count after consume', inv.count('cobblestone') === 65);
  inv.setSelected(2);
  ok('selected 2', inv.selected === 2);
  inv.scrollSelected(1);
  ok('scroll wraps 0..8', inv.selected >= 0 && inv.selected <= 8);
  const s = inv.serialize();
  const inv2 = new Inventory(G());
  inv2.load(s);
  ok('serialize/load roundtrip', inv2.count('cobblestone') === 65);
});

await section('crafting', async () => {
  const { Crafting } = await import('../js/items/crafting.js');
  const { Inventory } = await import('../js/items/inventory.js');
  const inv = new Inventory(G());
  const game = G(); game.inventory = inv;
  const crafting = new Crafting(game);
  if (crafting.init) crafting.init();
  // planks from a single log, anywhere in the 3x3 grid (shapeless)
  const grid = [null, null, null, null, 'log', null, null, null, null];
  const m = crafting.match(grid);
  ok('match log->planks', m && m.output && m.output.id === 'planks', JSON.stringify(m && m.output));
  ok('planks count 4', m && m.output && m.output.count === 4);
  const list = crafting.list();
  ok('recipe list non-empty', Array.isArray(list) && list.length > 5, 'len=' + (list && list.length));
});

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
