/* =========================================================================
   pathfinder.js — A* over the voxel grid for mob navigation.

   Mobs previously steered straight at their target and relied on a hop
   heuristic to get over things, which fails on anything an animal should
   obviously walk around: a two-block wall, a tree, the lip of a ravine. They
   would press into geometry and vibrate.

   WHAT MAKES VOXEL PATHFINDING DIFFERENT
   --------------------------------------
   The graph is not the set of solid blocks — it is the set of places a body
   of a given size can STAND. A node is therefore a column position (x,z) at
   the y where the mob's feet would rest, and an edge exists only if the mob
   can physically get from one to the other:

     - step across  : same height, headroom at both ends
     - step up      : destination one block higher, and headroom to rise into
     - drop down    : destination lower, within a survivable fall
     - diagonals    : only when BOTH orthogonal neighbours are also clear, or
                      the mob clips through the corner of a wall

   Costs are deliberately not pure distance. Jumping and falling are made
   more expensive than walking so a mob prefers the ramp to the cliff, and
   water is penalised so land animals stay out of it without being forbidden
   from crossing a stream.

   BUDGETING
   ---------
   Search is capped by node count, not by time, so behaviour is identical
   regardless of frame rate — important because mobs run on every client in
   multiplayer and a machine-dependent path would desync them. When the cap is
   hit we return the best partial path found (the node closest to the goal),
   which reads as "the mob made a sensible attempt" rather than freezing.
   ========================================================================= */

import Blocks, { ID } from '../world/blocks.js';
import { CHUNK_SY } from '../world/constants.js';

/* Movement costs, in arbitrary units where one flat step is 1. */
const COST_STEP = 1.0;
const COST_DIAGONAL = 1.414;
const COST_JUMP = 2.4;      // climbing is slow and mobs should prefer around
const COST_FALL = 1.6;      // dropping is quick but risky
const COST_WATER = 3.0;     // crossable, but land mobs will route around

/* Limits, tuned so a mob can navigate a house or a hillside but never stalls
   the frame hunting an unreachable target across the map. */
export const DEFAULT_LIMITS = {
  maxNodes: 900,      // A* expansions before giving up
  maxRange: 40,       // blocks from the start; beyond this, give up early
  maxFall: 4,         // survivable drop in blocks
  maxJump: 1,         // step-up height (1 = Minecraft-like)
};

/* A binary min-heap. A sorted array or repeated linear scan dominates A* cost
   once the open set passes a few dozen nodes, which happens immediately on
   any real path. */
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }

  push(node) {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < a.length && a[l].f < a[s].f) s = l;
        if (r < a.length && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/* The 8 horizontal neighbours, orthogonals first so ties favour straight
   lines over diagonals (which looks more deliberate). */
const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class Pathfinder {
  /**
   * @param {object} world  needs getBlock(x,y,z)
   */
  constructor(world, limits = {}) {
    this.world = world;
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits);
    this.stats = { searches: 0, nodesExpanded: 0, partial: 0, failed: 0 };
  }

  /* ---- terrain queries ---- */

  _isSolid(x, y, z) {
    if (y < 0) return true;                 // bedrock floor
    if (y >= CHUNK_SY) return false;
    const id = this.world.getBlock(x, y, z);
    if (id === ID.AIR || id === undefined || id === null) return false;
    const d = Blocks.get(id);
    // Cross-shaped plants (flowers, grass) are walked through, not over.
    return d.solid && d.render !== 'cross';
  }

  _isLiquid(x, y, z) {
    if (y < 0 || y >= CHUNK_SY) return false;
    return Blocks.isLiquid(this.world.getBlock(x, y, z));
  }

  /* Can a body `height` blocks tall occupy the space with feet at (x,y,z)? */
  _hasClearance(x, y, z, height) {
    for (let i = 0; i < height; i++) {
      if (this._isSolid(x, y + i, z)) return false;
    }
    return true;
  }

  /**
   * The y a mob's feet rest at in column (x,z), searching near `fromY`.
   * Returns null when there is nowhere to stand.
   */
  groundY(x, z, fromY, height, limits) {
    const maxFall = (limits || this.limits).maxFall;
    const maxJump = (limits || this.limits).maxJump;

    // Search from the highest reachable step down to the deepest safe drop.
    const top = Math.min(CHUNK_SY - 1, fromY + maxJump);
    const bottom = Math.max(0, fromY - maxFall - 1);
    for (let y = top; y >= bottom; y--) {
      // Standable means: solid below, and clearance for the body above.
      if (!this._isSolid(x, y - 1, z)) continue;
      if (!this._hasClearance(x, y, z, height)) continue;
      return y;
    }
    // Swimming counts as standable so aquatic routes exist at all.
    for (let y = top; y >= bottom; y--) {
      if (this._isLiquid(x, y, z) && this._hasClearance(x, y + 1, z, height - 1)) return y;
    }
    return null;
  }

  /**
   * Find a path from start to goal.
   *
   * @param {object} start  {x,y,z} world position (feet)
   * @param {object} goal   {x,y,z} world position
   * @param {object} opts   { height, limits }
   * @returns {{path: Array<{x,y,z}>, complete: boolean, nodes: number}}
   *          `path` is in world coordinates, start-exclusive. Empty when no
   *          route exists at all.
   */
  find(start, goal, opts = {}) {
    const height = Math.max(1, Math.ceil(opts.height || 2));
    const limits = Object.assign({}, this.limits, opts.limits);
    this.stats.searches++;

    const sx = Math.floor(start.x), sz = Math.floor(start.z);
    const gx = Math.floor(goal.x), gz = Math.floor(goal.z);
    const sy = this.groundY(sx, sz, Math.floor(start.y), height, limits);
    if (sy === null) { this.stats.failed++; return { path: [], complete: false, nodes: 0 }; }

    const gy = this.groundY(gx, gz, Math.floor(goal.y), height, limits);
    // An unreachable goal column still gets a search — we head toward it and
    // return the closest approach, which is what "chase" should do anyway.
    const goalY = gy === null ? Math.floor(goal.y) : gy;

    const key = (x, y, z) => `${x},${y},${z}`;
    const h = (x, y, z) => {
      // Octile distance: the admissible heuristic for 8-way movement. Plain
      // Euclidean under-estimates less well here and expands more nodes.
      const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
      const dy = Math.abs(y - goalY);
      return (dx + dz) + (COST_DIAGONAL - 2) * Math.min(dx, dz) + dy * 0.5;
    };

    const open = new MinHeap();
    const seen = new Map();   // key -> {g, parent, x,y,z}

    const startNode = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), parent: null };
    open.push(startNode);
    seen.set(key(sx, sy, sz), startNode);

    let best = startNode;
    let bestH = startNode.f;
    let expanded = 0;

    while (open.size > 0 && expanded < limits.maxNodes) {
      const cur = open.pop();
      expanded++;

      if (cur.x === gx && cur.z === gz && Math.abs(cur.y - goalY) <= 1) {
        this.stats.nodesExpanded += expanded;
        return { path: this._reconstruct(cur), complete: true, nodes: expanded };
      }

      const curH = h(cur.x, cur.y, cur.z);
      if (curH < bestH) { bestH = curH; best = cur; }

      for (const [dx, dz] of NEIGHBOURS) {
        const nx = cur.x + dx, nz = cur.z + dz;

        // Bail out early on anything absurdly far from the start.
        if (Math.abs(nx - sx) > limits.maxRange || Math.abs(nz - sz) > limits.maxRange) continue;

        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal) {
          // Both orthogonal neighbours must be passable at the current height,
          // or the mob would cut the corner of a wall and clip through it.
          if (!this._hasClearance(cur.x + dx, cur.y, cur.z, height)) continue;
          if (!this._hasClearance(cur.x, cur.y, cur.z + dz, height)) continue;
        }

        const ny = this.groundY(nx, nz, cur.y, height, limits);
        if (ny === null) continue;

        const rise = ny - cur.y;
        if (rise > limits.maxJump) continue;
        if (-rise > limits.maxFall) continue;

        // Climbing needs headroom to rise into at the ORIGIN column too.
        if (rise > 0 && !this._hasClearance(cur.x, cur.y + rise, cur.z, height)) continue;

        let step = diagonal ? COST_DIAGONAL : COST_STEP;
        if (rise > 0) step += COST_JUMP * rise;
        else if (rise < 0) step += COST_FALL * -rise * 0.5;
        if (this._isLiquid(nx, ny, nz)) step += COST_WATER;

        const g = cur.g + step;
        const k = key(nx, ny, nz);
        const prev = seen.get(k);
        if (prev && prev.g <= g) continue;

        const node = { x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: cur };
        seen.set(k, node);
        open.push(node);
      }
    }

    this.stats.nodesExpanded += expanded;
    // Out of budget or out of options: hand back the closest approach so the
    // mob still moves sensibly instead of standing still.
    if (best !== startNode) {
      this.stats.partial++;
      return { path: this._reconstruct(best), complete: false, nodes: expanded };
    }
    this.stats.failed++;
    return { path: [], complete: false, nodes: expanded };
  }

  _reconstruct(node) {
    const out = [];
    let n = node;
    while (n && n.parent) {
      // Centre of the block, so mobs walk down the middle of a corridor
      // rather than scraping the wall.
      out.push({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 });
      n = n.parent;
    }
    out.reverse();
    return out;
  }
}

export default Pathfinder;
