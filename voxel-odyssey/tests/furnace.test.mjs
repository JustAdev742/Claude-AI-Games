/* Smelting and tool-wear tests (pure logic, no browser). */
import Items from '../js/items/items.js';
import { ID } from '../js/world/blocks.js';
import { Inventory, cloneStack } from '../js/items/inventory.js';
import { Furnaces, SMELTING, FUEL, smeltRecipe, fuelTime } from '../js/items/furnace.js';
import { EventBus } from '../js/core/events.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};
const run = (f, st, seconds, step = 0.1) => { for (let t = 0; t < seconds - 1e-9; t += step) f.tickState(st, step); };

/* ---- the tables only reference real items ---- */
{
  const missing = [];
  for (const [k, r] of Object.entries(SMELTING)) {
    if (!Items.has(k)) missing.push(k);
    if (!Items.has(r.out)) missing.push(r.out);
  }
  for (const k of Object.keys(FUEL)) if (!Items.has(k)) missing.push(k);
  ok('tables: every smelting/fuel item exists', missing.length === 0, missing.join(','));
  ok('tables: lookups', smeltRecipe('raw_iron').out === 'iron_ingot' && fuelTime('coal') === 80 && smeltRecipe('dirt') === null && fuelTime('dirt') === 0);
  ok('tables: ingots are obtainable (iron tools need them)', Object.values(SMELTING).some((r) => r.out === 'iron_ingot')
    && Object.values(SMELTING).some((r) => r.out === 'gold_ingot'));
}

/* ---- basic smelting ---- */
{
  const f = new Furnaces(null);
  const st = f.ensure(1, 2, 3);
  st.input = { id: 'raw_iron', count: 3 };
  st.fuel = { id: 'coal', count: 1 };
  run(f, st, 9.5);
  ok('smelt: nothing finished before the cook time', !st.output && st.input.count === 3);
  ok('smelt: fuel is lit and consumed once', st.fuel === null && st.burn > 0);
  run(f, st, 1);
  ok('smelt: first ingot after ~10s', st.output && st.output.id === 'iron_ingot' && st.output.count === 1 && st.input.count === 2,
    JSON.stringify(st));
  run(f, st, 20);
  ok('smelt: all three done', st.output.count === 3 && st.input === null, JSON.stringify(st));
  ok('smelt: coal outlasts three ingots (80s)', st.burn > 40, `burn ${st.burn}`);
  run(f, st, 60);
  ok('smelt: fire burns out with nothing to cook', st.burn === 0);
}

/* ---- fuel is not wasted ---- */
{
  const f = new Furnaces(null);
  const st = f.ensure(0, 0, 0);
  st.fuel = { id: 'coal', count: 2 };
  run(f, st, 5);
  ok('fuel: not lit without anything to cook', st.fuel.count === 2 && st.burn === 0);
  st.input = { id: 'sand', count: 1 };
  run(f, st, 10.5);
  ok('fuel: lit once work arrives; sand becomes glass', st.output && st.output.id === 'glass' && st.fuel.count === 1);
}

/* ---- no fuel, no progress ---- */
{
  const f = new Furnaces(null);
  const st = f.ensure(0, 0, 0);
  st.input = { id: 'raw_meat', count: 2 };
  run(f, st, 30);
  ok('nofuel: raw meat stays raw', !st.output && st.cook === 0);
  st.fuel = { id: 'planks', count: 1 };
  run(f, st, 8.5);
  ok('nofuel: planks cook one piece of meat', st.output && st.output.id === 'cooked_meat' && st.output.count === 1);
}

/* ---- output slot rules ---- */
{
  const f = new Furnaces(null);
  const st = f.ensure(0, 0, 0);
  st.input = { id: 'raw_iron', count: 1 };
  st.fuel = { id: 'coal', count: 1 };
  st.output = { id: 'brick', count: 3 };
  run(f, st, 30);
  ok('output: blocked by a different item', st.output.id === 'brick' && st.input.count === 1 && st.fuel.count === 1 && st.burn === 0);
  st.output = { id: 'iron_ingot', count: Items.stackSize('iron_ingot') };
  run(f, st, 30);
  ok('output: blocked by a full stack', st.input.count === 1 && st.burn === 0);
}

/* ---- the block follows the fire ---- */
{
  const cells = new Map([['1,2,3', ID.FURNACE]]);
  const sets = [];
  const world = {
    getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? ID.AIR,
    setBlock: (x, y, z, id, opts) => { cells.set(`${x},${y},${z}`, id); sets.push({ id, cause: opts && opts.cause }); return true; },
  };
  const f = new Furnaces({ world });
  const st = f.ensure(1, 2, 3);
  st.input = { id: 'cobblestone', count: 1 };
  st.fuel = { id: 'stick', count: 3 };
  f.update(0.5);
  ok('block: lights up while burning', cells.get('1,2,3') === ID.FURNACE_LIT);
  ok('block: swap is local-only (not echoed to the server)', sets.every((s) => s.cause === 'network'));
  for (let i = 0; i < 400; i++) f.update(0.1);
  ok('block: goes dark when the fuel runs out', cells.get('1,2,3') === ID.FURNACE && st.output && st.output.id === 'stone');
  // An unloaded chunk reads as air: the furnace must not write into it.
  cells.set('1,2,3', ID.AIR); sets.length = 0;
  st.input = { id: 'sand', count: 1 }; st.fuel = { id: 'coal', count: 1 };
  f.update(0.5);
  ok('block: leaves unloaded space alone', sets.length === 0);
}

/* ---- breaking a furnace spills its contents ---- */
{
  const drops = [];
  const events = new EventBus();
  const f = new Furnaces({ events, entities: { dropItem: (x, y, z, id, n) => drops.push({ id, n }) } });
  f.init();
  const st = f.ensure(5, 5, 5);
  st.input = { id: 'raw_gold', count: 4 }; st.fuel = { id: 'coal', count: 2 }; st.output = { id: 'gold_ingot', count: 1 };
  events.emit('block:break', { x: 5, y: 5, z: 5, blockId: ID.FURNACE_LIT });
  ok('break: all three slots dropped', drops.length === 3 && drops.reduce((a, d) => a + d.n, 0) === 7, JSON.stringify(drops));
  ok('break: state removed', f.get(5, 5, 5) === null);
  events.emit('block:break', { x: 9, y: 9, z: 9, blockId: ID.STONE });
  ok('break: other blocks ignored', drops.length === 3);
}

/* ---- persistence ---- */
{
  const f = new Furnaces(null);
  const st = f.ensure(7, 8, 9);
  st.input = { id: 'raw_iron', count: 2 }; st.fuel = { id: 'coal', count: 1 };
  run(f, st, 4);
  f.ensure(1, 1, 1);                                      // empty furnace: not worth saving
  const saved = JSON.parse(JSON.stringify(f.serialize()));
  ok('save: only furnaces with something in them', saved.length === 1);
  const g = new Furnaces(null);
  g.load(saved);
  const back = g.get(7, 8, 9);
  ok('save: round trip keeps slots and timers', back && back.input.count === 2 && Math.abs(back.cook - st.cook) < 1e-9 && Math.abs(back.burn - st.burn) < 1e-9);
  g.load([{ k: '0,0,0', input: { id: 'not_an_item', count: 3 } }, null, 7]);
  ok('save: junk entries are dropped safely', g.get(0, 0, 0).input === null);
}

/* ---- tool wear ---- */
{
  const events = new EventBus();
  let broke = null;
  events.on('tool:break', (e) => { broke = e; });
  const inv = new Inventory({ events });
  inv.init();
  inv.add('stone_pickaxe', 1);
  const dur = Items.durability('stone_pickaxe');
  ok('wear: stone pickaxe has durability', dur > 50, `${dur}`);
  inv.slots[1] = { id: 'cobblestone', count: 5 };
  inv.selected = 1;
  ok('wear: non-tools never wear', Items.durability('cobblestone') === 0 && inv.wearSelected(1) === false && inv.slots[1].wear === undefined);
  inv.selected = 0;
  inv.slots[0] = { id: 'stone_pickaxe', count: 1 };
  inv.wearSelected(10);
  ok('wear: uses accumulate', inv.slots[0].wear === 10);
  ok('wear: fraction', Math.abs(Items.wearFraction(inv.slots[0]) - (1 - 10 / dur)) < 1e-9);
  ok('wear: fresh tools show no bar', Items.wearFraction({ id: 'stone_pickaxe', count: 1 }) === null);

  // survives copy, save/load and moving between slots
  const copy = cloneStack(inv.slots[0]);
  ok('wear: cloneStack keeps wear', copy.wear === 10 && copy !== inv.slots[0]);
  const saved = JSON.parse(JSON.stringify(inv.serialize()));
  const inv2 = new Inventory({ events });
  inv2.init(); inv2.load(saved);
  ok('wear: survives save/load', inv2.slots[0].wear === 10);
  inv2.swap(0, 12);
  ok('wear: survives a slot swap', inv2.slots[12].wear === 10);
  const left = inv2.addStack({ id: 'stone_pickaxe', count: 1, wear: 33 });
  ok('wear: addStack keeps wear', left === 0 && inv2.slots.some((s) => s && s.wear === 33));
  inv2.load({ slots: [{ id: 'stone_pickaxe', count: 1, wear: 99999 }] });
  ok('wear: loaded wear is clamped below breaking', inv2.slots[0].wear === dur - 1);

  // breaking
  inv.wearSelected(dur - 11);
  ok('wear: one use left, not yet broken', inv.slots[0] && inv.slots[0].wear === dur - 1 && broke === null);
  const didBreak = inv.wearSelected(1);
  ok('wear: breaks when used up', didBreak && inv.slots[0] === null && broke && broke.id === 'stone_pickaxe');
}

console.log(`\n==== furnace & wear: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
