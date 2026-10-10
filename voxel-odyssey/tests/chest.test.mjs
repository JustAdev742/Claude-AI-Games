/* Chest storage tests (pure logic). */
import Items from '../js/items/items.js';
import Crafting from '../js/items/crafting.js';
import { ID } from '../js/world/blocks.js';
import { Chests, CHEST_SLOTS, moveInto } from '../js/items/chest.js';
import { EventBus } from '../js/core/events.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

/* ---- the item and its recipe exist ---- */
{
  ok('item: chest is a placeable block item', Items.isPlaceable('chest') && Items.blockId('chest') === ID.CHEST);
  const crafting = new Crafting({});
  crafting.init && crafting.init();
  const ring = ['planks', 'planks', 'planks', 'planks', null, 'planks', 'planks', 'planks', 'planks'];
  const m = crafting.match(ring);
  ok('recipe: eight planks around an empty centre make a chest', m && m.output.id === 'chest' && m.output.count === 1, JSON.stringify(m));
  const full = crafting.match(['planks', 'planks', 'planks', 'planks', 'planks', 'planks', 'planks', 'planks', 'planks']);
  ok('recipe: a full 3x3 of planks does not', !full || full.output.id !== 'chest');
}

/* ---- moving stacks into slots ---- */
{
  const slots = new Array(5).fill(null);
  slots[0] = { id: 'cobblestone', count: 60 };
  let left = moveInto(slots, { id: 'cobblestone', count: 10 });
  ok('move: tops up the matching stack first', left === 0 && slots[0].count === 64 && slots[1] && slots[1].count === 6);
  left = moveInto(slots, { id: 'dirt', count: 64 });
  ok('move: then fills empty slots', left === 0 && slots[2].id === 'dirt' && slots[2].count === 64);
  const tiny = [{ id: 'dirt', count: 64 }];
  ok('move: reports what did not fit', moveInto(tiny, { id: 'dirt', count: 5 }) === 5);
  const src = { id: 'coal', count: 3 };
  moveInto(new Array(2).fill(null), src);
  ok('move: leaves the source untouched', src.count === 3);

  const worn = [{ id: 'stone_pickaxe', count: 1, wear: 20 }, null];
  moveInto(worn, { id: 'stone_pickaxe', count: 1, wear: 5 });
  ok('move: worn tools never merge, and keep their own wear', worn[0].wear === 20 && worn[1] && worn[1].wear === 5);
  ok('move: empty / junk stacks are ignored', moveInto(new Array(2).fill(null), null) === 0 && moveInto(new Array(2).fill(null), { id: 'dirt', count: 0 }) === 0);
}

/* ---- state, spilling, persistence ---- */
{
  const drops = [];
  const events = new EventBus();
  const chests = new Chests({ events, entities: { dropItem: (x, y, z, id, n) => drops.push({ id, n, at: [x, y, z] }) } });
  chests.init();
  const st = chests.ensure(4, 5, 6);
  ok('state: a chest has 27 empty slots', st.slots.length === CHEST_SLOTS && st.slots.every((s) => s === null));
  ok('state: ensure returns the same chest', chests.ensure(4, 5, 6) === st && chests.get(4, 5, 6) === st && chests.get(0, 0, 0) === null);

  st.slots[0] = { id: 'iron_ingot', count: 12 };
  st.slots[26] = { id: 'stone_pickaxe', count: 1, wear: 40 };
  chests.ensure(9, 9, 9);                                  // an empty one
  const saved = JSON.parse(JSON.stringify(chests.serialize()));
  ok('save: only chests with something in them', saved.length === 1 && saved[0].k === '4,5,6');
  const back = new Chests(null);
  back.load(saved);
  const b = back.get(4, 5, 6);
  ok('save: round trip keeps stacks and tool wear', b && b.slots[0].count === 12 && b.slots[26].wear === 40 && b.slots[1] === null);
  back.load([{ k: '1,1,1', slots: [{ id: 'not_an_item', count: 3 }, { id: 'dirt', count: 9999 }, { id: 'stone_pickaxe', count: 1, wear: 99999 }] }, null, 4, { k: 5 }]);
  const j = back.get(1, 1, 1);
  ok('save: junk is dropped, counts and wear are clamped', j && j.slots[0] === null && j.slots[1].count === 64 && j.slots[2].wear === Items.durability('stone_pickaxe') - 1);

  events.emit('block:break', { x: 9, y: 9, z: 9, blockId: ID.STONE });
  ok('break: other blocks are ignored', chests.get(4, 5, 6) !== null && drops.length === 0);
  events.emit('block:break', { x: 4, y: 5, z: 6, blockId: ID.CHEST });
  ok('break: the contents spill and the state is gone', drops.length === 2 && chests.get(4, 5, 6) === null && drops.some((d) => d.id === 'iron_ingot' && d.n === 12), JSON.stringify(drops));
}

console.log(`\n==== chests: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
