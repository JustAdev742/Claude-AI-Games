/* =========================================================================
   growth.js — saplings growing into trees.

   Any sapling block in the loaded world (placed by the player, restored from
   a save, or arriving any other way) gets a growth timer. When it fires the
   sapling becomes a tree of its species — if it is still on grass or dirt,
   gets enough light, and has room. A blocked sapling tries again a few times
   and then gives up waiting rather than polling forever.

   The tree's shape comes from trees.js, the same definition world generation
   uses, seeded from the sapling's position so a given sapling always grows
   the same tree.

   Growth is a single-player mechanic: in a multiplayer session the server
   owns the world and would never hear about locally grown blocks, so
   saplings simply stay saplings there.
   ========================================================================= */

import { ID } from './blocks.js';
import Blocks from './blocks.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './constants.js';
import { RNG, hashCombine } from '../core/utils.js';
import { treeBlocks, kindOfSapling } from './trees.js';

const GROW_MIN = 45;          // seconds until the first attempt
const GROW_MAX = 120;
const RETRY_MIN = 20;
const RETRY_MAX = 45;
const MAX_TRIES = 6;
const MIN_SKYLIGHT = 9;       // a sapling in the dark does not grow
const MIN_CANOPY_FREE = 0.7;  // fraction of leaf cells that must be clear

const keyOf = (x, y, z) => `${x},${y},${z}`;

export class Growth {
  constructor(game) {
    this.game = game || null;
    this.saplings = new Map();        // "x,y,z" -> { x, y, z, timer, tries }
    this._unsubs = [];
  }

  init() {
    const ev = this.game && this.game.events;
    if (ev) {
      // Every block write fires block:update, so this sees saplings from any
      // source and notices when one is removed or replaced.
      this._unsubs.push(ev.on('block:update', (e) => { if (e) this.noteBlock(e.x, e.y, e.z); }));
    }
    return this;
  }

  reset() { this.saplings.clear(); }

  // (Re)check one position: track it if it holds a sapling, forget it if not.
  noteBlock(x, y, z) {
    const world = this.game && this.game.world;
    if (!world) return;
    const k = keyOf(x, y, z);
    if (kindOfSapling(world.getBlock(x, y, z))) {
      if (!this.saplings.has(k)) this.saplings.set(k, { x, y, z, timer: this._delay(GROW_MIN, GROW_MAX), tries: 0 });
    } else {
      this.saplings.delete(k);
    }
  }

  // After loading a save: every sapling recorded in the world's edits.
  scanEdits() {
    const world = this.game && this.game.world;
    if (!world || !world.edits) return;
    for (const [k, id] of world.edits) {
      if (!kindOfSapling(id)) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (!this.saplings.has(k)) this.saplings.set(k, { x, y, z, timer: this._delay(GROW_MIN, GROW_MAX), tries: 0 });
    }
  }

  // Random spread, so a row of saplings does not all grow on the same frame.
  // (Timing is deliberately not deterministic; the tree's SHAPE is.)
  _delay(lo, hi) { return lo + Math.random() * (hi - lo); }

  _loaded(x, z) {
    const world = this.game && this.game.world;
    if (!world || typeof world.getChunk !== 'function') return true;
    return !!world.getChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ));
  }

  update(dt) {
    if (!this.saplings.size) return;
    const net = this.game && this.game.net;
    if (net && net.connected) return;               // see the file header
    for (const [k, s] of this.saplings) {
      if (!this._loaded(s.x, s.z)) continue;        // paused while its chunk is away
      s.timer -= dt;
      if (s.timer > 0) continue;
      const result = this.tryGrow(s);
      if (result === 'grown' || result === 'gone') this.saplings.delete(k);
      else if (++s.tries >= MAX_TRIES) this.saplings.delete(k);
      else s.timer = this._delay(RETRY_MIN, RETRY_MAX);
    }
  }

  /* Try to turn one sapling into a tree. Returns 'grown', 'blocked' (try again
     later) or 'gone' (no longer a sapling, or nowhere it can grow). */
  tryGrow(s) {
    const world = this.game.world;
    const kind = kindOfSapling(world.getBlock(s.x, s.y, s.z));
    if (!kind) return 'gone';

    const below = world.getBlock(s.x, s.y - 1, s.z);
    if (below !== ID.GRASS && below !== ID.DIRT) return 'gone';
    if (world.getSkyLight(s.x, s.y, s.z) < MIN_SKYLIGHT) return 'blocked';

    const seed = this.game.seed | 0;
    const tree = treeBlocks(kind, new RNG(hashCombine(seed, s.x, s.y, s.z, 31337)).next, CHUNK_SY - 1 - s.y);

    const open = (id) => id === ID.AIR || Blocks.renderType(id) === 'cross';
    let leafTotal = 0, leafFree = 0;
    for (const b of tree.blocks) {
      const x = s.x + b.dx, y = s.y + b.dy, z = s.z + b.dz;
      if (y < 0 || y >= CHUNK_SY) { if (!b.leaf) return 'blocked'; leafTotal++; continue; }
      const cur = world.getBlock(x, y, z);
      if (!b.leaf) {
        if (!(open(cur) || cur === b.id)) return 'blocked';       // the trunk needs a clear column
      } else {
        leafTotal++;
        if (open(cur) || isLeafId(cur)) leafFree++;
      }
    }
    if (leafTotal && leafFree / leafTotal < MIN_CANOPY_FREE) return 'blocked';

    // Grow it. Logs first so leaves never overwrite a trunk cell.
    for (const b of tree.blocks) {
      if (b.leaf) continue;
      world.setBlock(s.x + b.dx, s.y + b.dy, s.z + b.dz, b.id, { cause: 'network' });
    }
    for (const b of tree.blocks) {
      if (!b.leaf) continue;
      const x = s.x + b.dx, y = s.y + b.dy, z = s.z + b.dz;
      if (y < 0 || y >= CHUNK_SY) continue;
      const cur = world.getBlock(x, y, z);
      if (open(cur)) world.setBlock(x, y, z, b.id, { cause: 'network' });
    }
    // Grass turns to dirt under a trunk, as it does for any heavy block.
    if (below === ID.GRASS) world.setBlock(s.x, s.y - 1, s.z, ID.DIRT, { cause: 'network' });
    const ev = this.game.events;
    if (ev) ev.emit('tree:grown', { x: s.x, y: s.y, z: s.z, kind });
    return 'grown';
  }

  /* ---- persistence: only edits matter, and scanEdits() rebuilds timers ---- */
}

function isLeafId(id) { return id === ID.LEAVES || id === ID.BIRCH_LEAVES || id === ID.PINE_LEAVES; }

export default Growth;
