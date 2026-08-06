/* Pathfinder tests against hand-built voxel scenes.

   Navigation bugs are hard to spot by watching — a mob that takes a silly
   route still looks like it is walking. So each scene here has a known
   correct answer: a wall must be walked around, a stair must be climbed, a
   cliff must not be jumped off, a sealed room must report failure rather
   than hanging. */

import { Pathfinder } from '../js/entities/pathfinder.js';
import { ID } from '../js/world/blocks.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

/* A tiny world backed by a Map, exposing only getBlock. */
function makeWorld(groundY = 10) {
  const blocks = new Map();
  const k = (x, y, z) => `${x},${y},${z}`;
  return {
    groundY,
    set(x, y, z, id) { blocks.set(k(x, y, z), id); },
    fill(x0, y0, z0, x1, y1, z1, id) {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        blocks.set(k(x, y, z), id);
      }
    },
    getBlock(x, y, z) {
      const v = blocks.get(k(x, y, z));
      if (v !== undefined) return v;
      // Default terrain: solid up to groundY, air above.
      return y <= groundY ? ID.STONE : ID.AIR;
    },
  };
}

const pathClear = (path, world, height = 2) => path.every((p) => {
  const x = Math.floor(p.x), z = Math.floor(p.z);
  for (let i = 0; i < height; i++) if (world.getBlock(x, p.y + i, z) !== ID.AIR) return false;
  return true;
});

/* ---- 1. flat ground: a direct path ---- */
{
  const w = makeWorld(10);
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });
  ok('flat: path found', r.complete, JSON.stringify(r).slice(0, 120));
  ok('flat: reaches the goal', r.path.length > 0 && Math.floor(r.path[r.path.length - 1].x) === 8);
  ok('flat: stays on the surface', r.path.every((p) => p.y === 11), r.path.map((p) => p.y).join(','));
  // 8 blocks in a straight line should not wander.
  ok('flat: route is direct', r.path.length <= 10, `${r.path.length} steps`);
}

/* ---- 2. a wall must be walked around, not through ---- */
{
  const w = makeWorld(10);
  // A wall across z=-3..3 at x=4, three blocks tall, with a gap at z=3.
  w.fill(4, 11, -3, 4, 13, 2, ID.STONE);
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });

  ok('wall: path found', r.complete, `complete=${r.complete} len=${r.path.length}`);
  ok('wall: never enters solid blocks', pathClear(r.path, w), 'path passes through the wall');
  // Step count is a useless proxy for "detoured": with 8-way movement a
  // diagonal detour costs the SAME number of steps as the straight line.
  // What actually matters is that the route left the straight line at all,
  // and crossed x=4 only where the wall has a gap (z <= -4 or z >= 3).
  ok('wall: left the straight line', r.path.some((p) => Math.abs(p.z - 0.5) > 1),
    r.path.map((p) => p.z).join(','));
  const crossing = r.path.find((p) => Math.floor(p.x) === 4);
  ok('wall: crossed only at a gap', crossing && (crossing.z >= 3 || crossing.z <= -3),
    crossing ? `crossed at z=${crossing.z}` : 'never crossed x=4');
}

/* ---- 3. a sealed room is reported unreachable, not searched forever ---- */
{
  const w = makeWorld(10);
  // Box the goal in completely.
  w.fill(7, 11, -1, 9, 13, 1, ID.STONE);
  w.fill(8, 11, 0, 8, 12, 0, ID.AIR);      // hollow interior
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });

  ok('sealed: not reported complete', !r.complete);
  ok('sealed: search stayed bounded', r.nodes <= pf.limits.maxNodes, `${r.nodes} nodes`);
  ok('sealed: returned a partial approach', r.path.length > 0, 'no partial path offered');
  ok('sealed: partial path is walkable', pathClear(r.path, w));
}

/* ---- 4. a single step up is climbed ---- */
{
  const w = makeWorld(10);
  w.fill(4, 11, -4, 12, 11, 4, ID.STONE);   // raised plateau from x=4
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 12, z: 0.5 }, { height: 2 });
  ok('step up: path found', r.complete, `complete=${r.complete}`);
  ok('step up: ends on the plateau', r.path.length && r.path[r.path.length - 1].y === 12,
    r.path.length ? r.path[r.path.length - 1].y : 'empty');
  ok('step up: never clips terrain', pathClear(r.path, w));
}

/* ---- 5. a 2-block wall is NOT climbed (exceeds jump height) ---- */
{
  const w = makeWorld(10);
  w.fill(4, 11, -20, 4, 12, 20, ID.STONE);   // long, 2 tall: impassable
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });
  ok('tall wall: not passable', !r.complete, 'mob climbed a 2-block wall');
  ok('tall wall: no path crosses x=4', !r.path.some((p) => Math.floor(p.x) >= 4),
    r.path.map((p) => Math.floor(p.x)).join(','));
}

/* ---- 6. a lethal drop is avoided when a safe route exists ---- */
{
  const w = makeWorld(10);
  // A chasm at x=4 spanning z=-2..2, 20 deep; safe ground at z=3.
  w.fill(4, -9, -2, 6, 10, 2, ID.AIR);
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 9.5, y: 11, z: 0.5 }, { height: 2 });
  ok('chasm: found a way across', r.complete, `complete=${r.complete}`);
  ok('chasm: did not fall in', r.path.every((p) => p.y >= 10), r.path.map((p) => p.y).join(','));
  ok('chasm: went around via the intact ground', r.path.some((p) => p.z >= 3));
}

/* ---- 7. headroom is respected for a tall mob ---- */
{
  const w = makeWorld(10);
  // A 1-block-high tunnel: passable by a 1-tall mob, not a 2-tall one.
  w.fill(3, 12, -1, 6, 14, 1, ID.STONE);
  const pf = new Pathfinder(w);
  const shortMob = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 1 });
  const tallMob = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });
  ok('headroom: short mob fits the tunnel', shortMob.complete);
  ok('headroom: tall mob does not clip through', pathClear(tallMob.path, w, 2));
}

/* ---- 8. diagonals do not cut through wall corners ---- */
{
  const w = makeWorld(10);
  // An inside corner: blocks at (1,z=0) and (0,z=1) leave (1,1) diagonally
  // adjacent to (0,0) but unreachable without clipping.
  w.fill(1, 11, 0, 1, 12, 0, ID.STONE);
  w.fill(0, 11, 1, 0, 12, 1, ID.STONE);
  const pf = new Pathfinder(w);
  const r = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 1.5, y: 11, z: 1.5 }, { height: 2 });
  // It may route the long way, but must never step straight across the corner.
  const cutCorner = r.path.length > 0
    && Math.floor(r.path[0].x) === 1 && Math.floor(r.path[0].z) === 1;
  ok('diagonal: did not clip the corner', !cutCorner, 'first step cut through the corner');
  ok('diagonal: path avoids solids', pathClear(r.path, w));
}

/* ---- 9. water is crossable but penalised ---- */
{
  const dry = makeWorld(10);
  const wet = makeWorld(10);
  // A pond in the direct line; a dry detour exists at z>=3.
  wet.fill(3, 11, -2, 6, 11, 2, ID.WATER);
  const a = new Pathfinder(dry).find({ x: 0.5, y: 11, z: 0.5 }, { x: 9.5, y: 11, z: 0.5 }, { height: 2 });
  const b = new Pathfinder(wet).find({ x: 0.5, y: 11, z: 0.5 }, { x: 9.5, y: 11, z: 0.5 }, { height: 2 });
  ok('water: both routes exist', a.complete && b.complete);
  // Either side of the pond is equally valid, so asserting a particular
  // direction would be testing an arbitrary tie-break. The real property is
  // that the water penalty made it route around rather than wade through.
  const wadedThrough = b.path.filter((p) => wet.getBlock(Math.floor(p.x), p.y, Math.floor(p.z)) === ID.WATER).length;
  ok('water: routed around rather than through', wadedThrough === 0,
    `${wadedThrough} of ${b.path.length} steps were in water`);
  ok('water: the detour is real', b.path.some((p) => Math.abs(p.z - 0.5) > 1),
    b.path.map((p) => p.z).join(','));
}

/* ---- 10. cost and determinism ---- */
{
  const w = makeWorld(10);
  w.fill(4, 11, -3, 4, 13, 2, ID.STONE);
  const pf = new Pathfinder(w);
  const a = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });
  const b = pf.find({ x: 0.5, y: 11, z: 0.5 }, { x: 8.5, y: 11, z: 0.5 }, { height: 2 });
  ok('deterministic: identical results', JSON.stringify(a.path) === JSON.stringify(b.path));

  // The node budget must actually bound the work.
  const tiny = new Pathfinder(w, { maxNodes: 25 });
  const r = tiny.find({ x: 0.5, y: 11, z: 0.5 }, { x: 200.5, y: 11, z: 200.5 }, { height: 2 });
  ok('budget: respected', r.nodes <= 25, `${r.nodes} nodes`);
  ok('budget: still returns something usable', r.path.length > 0);
}

console.log(`\n==== pathfinder: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
