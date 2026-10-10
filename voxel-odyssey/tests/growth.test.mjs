/* Tree shapes and sapling growth (pure logic, mock world). */
import { treeBlocks, kindOfSapling, treeSpecies } from '../js/world/trees.js';
import { Growth } from '../js/world/growth.js';
import { ID } from '../js/world/blocks.js';
import Blocks from '../js/world/blocks.js';
import Items from '../js/items/items.js';
import { EventBus } from '../js/core/events.js';
import { mulberry32 } from '../js/core/utils.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

/* ---- shapes ---- */
{
  for (const kind of ['oak', 'birch', 'pine']) {
    const sp = treeSpecies(kind);
    const t = treeBlocks(kind, mulberry32(7));
    const logs = t.blocks.filter((b) => !b.leaf), leaves = t.blocks.filter((b) => b.leaf);
    ok(`${kind}: trunk is a straight column from the base`, logs.every((b, i) => b.dx === 0 && b.dz === 0 && b.dy === i) && logs.length === t.trunkH);
    ok(`${kind}: logs and leaves use the species blocks`, logs.every((b) => b.id === sp.log) && leaves.every((b) => b.id === sp.leaf));
    ok(`${kind}: canopy stays within radius 2 and above the ground`, leaves.length > 8 && leaves.every((b) => Math.abs(b.dx) <= 2 && Math.abs(b.dz) <= 2 && b.dy >= 0));
    ok(`${kind}: no leaf overlaps a trunk cell`, !leaves.some((b) => b.dx === 0 && b.dz === 0 && b.dy < t.trunkH));
    const again = treeBlocks(kind, mulberry32(7));
    ok(`${kind}: same random stream, same tree`, JSON.stringify(again) === JSON.stringify(t));
  }
  const heights = new Set();
  for (let s = 0; s < 40; s++) heights.add(treeBlocks('oak', mulberry32(s)).trunkH);
  ok('oak: trunk heights vary 4..5', [...heights].every((h) => h === 4 || h === 5) && heights.size === 2, [...heights].join(','));
  ok('headroom: a tree is shortened to fit', treeBlocks('oak', mulberry32(1), 5).trunkH <= 3);
  ok('headroom: never shorter than a 3-block trunk', treeBlocks('oak', mulberry32(1), 3).trunkH === 3);
  ok('saplings map to species', kindOfSapling(ID.SAPLING_OAK) === 'oak' && kindOfSapling(ID.SAPLING_BIRCH) === 'birch'
    && kindOfSapling(ID.SAPLING_PINE) === 'pine' && kindOfSapling(ID.STONE) === null);
}

/* ---- items and drops ---- */
{
  ok('saplings are placeable items', ['sapling_oak', 'sapling_birch', 'sapling_pine'].every((k) => Items.isPlaceable(k)));
  ok('sapling items place sapling blocks', Items.blockId('sapling_oak') === ID.SAPLING_OAK && Items.blockId('sapling_pine') === ID.SAPLING_PINE);
  ok('sapling blocks are non-solid plants that drop themselves',
    !Blocks.isSolid(ID.SAPLING_OAK) && Blocks.renderType(ID.SAPLING_OAK) === 'cross' && Items.dropFor(ID.SAPLING_OAK) === 'sapling_oak');
  const c = Items.dropChance(ID.LEAVES);
  ok('leaves drop saplings only sometimes', c > 0 && c < 0.5, `${c}`);
  ok('ordinary blocks always drop', Items.dropChance(ID.STONE) === 1);
}

/* ---- a mock world ---- */
function makeWorld() {
  const cells = new Map();
  const events = new EventBus();
  const w = {
    cells, events, edits: new Map(), sky: 15, loaded: true, causes: [],
    getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? (y <= 0 ? ID.STONE : ID.AIR),
    setBlock(x, y, z, id, opts) {
      const prev = w.getBlock(x, y, z);
      if (prev === id) return false;
      w.causes.push(opts && opts.cause);
      cells.set(`${x},${y},${z}`, id);
      w.edits.set(`${x},${y},${z}`, id);
      events.emit('block:update', { x, y, z });
      if (opts && opts.cause === 'place') events.emit('block:place', { x, y, z, blockId: id });
      return true;
    },
    getSkyLight: () => w.sky,
    getChunk: () => (w.loaded ? {} : null),
  };
  return w;
}
function makeGame() {
  const world = makeWorld();
  const game = { world, events: world.events, seed: 123, net: { connected: false } };
  const growth = new Growth(game); growth.init();
  // floor of grass at y=10
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) world.cells.set(`${x},10,${z}`, ID.GRASS);
  return { game, world, growth };
}
const plant = (world, id = ID.SAPLING_OAK, x = 0, y = 11, z = 0) => world.setBlock(x, y, z, id, { cause: 'place' });
const run = (growth, seconds, step = 1) => { for (let t = 0; t < seconds; t += step) growth.update(step); };

/* ---- growing ---- */
{
  const { world, growth, game } = makeGame();
  let grown = null;
  game.events.on('tree:grown', (e) => { grown = e; });
  plant(world);
  world.causes.length = 0;                     // only the growth writes from here on
  ok('growth: planting registers a sapling', growth.saplings.size === 1);
  run(growth, 30);
  ok('growth: not before the minimum delay', world.getBlock(0, 11, 0) === ID.SAPLING_OAK);
  run(growth, 130);
  ok('growth: becomes an oak trunk', world.getBlock(0, 11, 0) === ID.LOG && world.getBlock(0, 14, 0) === ID.LOG);
  let leaves = 0;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 11; y <= 18; y++) if (world.getBlock(x, y, z) === ID.LEAVES) leaves++;
  ok('growth: has a leafy canopy', leaves >= 12, `${leaves}`);
  ok('growth: the soil under the trunk becomes dirt', world.getBlock(0, 10, 0) === ID.DIRT);
  ok('growth: reports tree:grown and stops tracking', grown && grown.kind === 'oak' && growth.saplings.size === 0);
  ok('growth: its writes are local-only (cause network, never echoed to a server)', world.causes.length > 10 && world.causes.every((c) => c === 'network'));
}
{
  const { world, growth } = makeGame();
  plant(world, ID.SAPLING_BIRCH, 2, 11, 2);
  plant(world, ID.SAPLING_PINE, -3, 11, -3);
  run(growth, 200);
  ok('species: birch sapling grows birch', world.getBlock(2, 11, 2) === ID.BIRCH_LOG);
  ok('species: pine sapling grows pine', world.getBlock(-3, 11, -3) === ID.PINE_LOG);
}
{
  // The same sapling position always grows the same tree.
  const shape = () => {
    const { world, growth } = makeGame(); plant(world); run(growth, 200);
    return JSON.stringify([...world.cells.entries()].filter(([, id]) => id === ID.LEAVES || id === ID.LOG).sort());
  };
  ok('growth: a given sapling grows a repeatable tree', shape() === shape());
}

/* ---- things that stop it ---- */
{
  const { world, growth } = makeGame();
  plant(world);
  world.cells.set('0,13,0', ID.STONE);                     // a ceiling in the trunk's way
  run(growth, 400);
  ok('blocked: a stone in the trunk column stops it', world.getBlock(0, 11, 0) === ID.SAPLING_OAK && world.getBlock(0, 12, 0) === ID.AIR);
  ok('blocked: it gives up retrying eventually', growth.saplings.size === 0);
}
{
  const { world, growth } = makeGame();
  world.sky = 2;
  plant(world);
  run(growth, 100);
  ok('dark: no growth without light', world.getBlock(0, 11, 0) === ID.SAPLING_OAK);
  world.sky = 15;
  growth.saplings.get('0,11,0').timer = 0;
  run(growth, 2);
  ok('dark: and it grows once lit', world.getBlock(0, 11, 0) === ID.LOG);
}
{
  const { world, growth } = makeGame();
  world.cells.set('0,10,0', ID.SAND);
  plant(world);
  run(growth, 200);
  ok('soil: a sapling on sand never grows', world.getBlock(0, 11, 0) === ID.SAPLING_OAK && growth.saplings.size === 0);
}
{
  const { world, growth } = makeGame();
  plant(world);
  world.loaded = false;
  run(growth, 300);
  ok('chunks: growth pauses while the chunk is unloaded', world.getBlock(0, 11, 0) === ID.SAPLING_OAK && growth.saplings.size === 1);
  world.loaded = true;
  run(growth, 130);
  ok('chunks: and resumes when it returns', world.getBlock(0, 11, 0) === ID.LOG);
}
{
  const { world, growth, game } = makeGame();
  game.net.connected = true;
  plant(world);
  run(growth, 300);
  ok('multiplayer: saplings do not grow (the server owns the world)', world.getBlock(0, 11, 0) === ID.SAPLING_OAK);
}
{
  const { world, growth } = makeGame();
  plant(world);
  world.setBlock(0, 11, 0, ID.AIR, { cause: 'break' });
  ok('breaking a sapling forgets it', growth.saplings.size === 0);
  run(growth, 200);
  ok('...and nothing grows from an empty cell', world.getBlock(0, 11, 0) === ID.AIR);
}
{
  const { world, growth } = makeGame();
  world.edits.set('3,11,3', ID.SAPLING_OAK);
  world.cells.set('3,11,3', ID.SAPLING_OAK);
  world.edits.set('4,11,4', ID.STONE);
  growth.scanEdits();
  ok('save: saplings recorded in the edits are picked up on load', growth.saplings.size === 1 && growth.saplings.has('3,11,3'));
}

console.log(`\n==== trees & growth: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
