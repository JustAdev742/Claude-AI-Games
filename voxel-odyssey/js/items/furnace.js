/* =========================================================================
   furnace.js — smelting.

   Each placed furnace owns a small state object (input / fuel / output slots
   plus burn and cook timers), stored by position. The simulation is a plain
   per-frame tick with no Three.js dependency, so it runs in Node tests.

   The rules follow the familiar sandbox model:
     - fuel burns for a fixed time and is only consumed when something needs
       cooking;
     - one input item cooks in COOK_TIME seconds while the fuel burns;
     - the output slot only takes the same item, up to a full stack;
     - the block swaps to its lit variant while burning (it emits light).

   Furnace state is local to the client (it is not synchronised in
   multiplayer) and is saved with the world.
   ========================================================================= */

import Items from './items.js';
import { ID } from '../world/blocks.js';

// input item -> { out: item key, time: seconds to cook one }
export const SMELTING = {
  raw_iron: { out: 'iron_ingot', time: 10 },
  raw_gold: { out: 'gold_ingot', time: 10 },
  raw_meat: { out: 'cooked_meat', time: 8 },
  clay_ball: { out: 'brick', time: 10 },
  sand: { out: 'glass', time: 10 },
  cobblestone: { out: 'stone', time: 10 },
  log: { out: 'charcoal', time: 12 },
  birch_log: { out: 'charcoal', time: 12 },
  pine_log: { out: 'charcoal', time: 12 },
};

// fuel item -> seconds one item burns for
export const FUEL = {
  coal: 80,
  charcoal: 80,
  log: 15,
  birch_log: 15,
  pine_log: 15,
  planks: 15,
  crafting_table: 15,
  stick: 5,
  sapling_oak: 5,
  sapling_birch: 5,
  sapling_pine: 5,
};

export function smeltRecipe(itemKey) { return itemKey ? SMELTING[itemKey] || null : null; }
export function fuelTime(itemKey) { return itemKey ? FUEL[itemKey] || 0 : 0; }

const keyOf = (x, y, z) => `${x | 0},${y | 0},${z | 0}`;

function emptyState() {
  return { input: null, fuel: null, output: null, burn: 0, burnMax: 0, cook: 0 };
}

const copyStack = (s) => (s ? { id: s.id, count: s.count } : null);

export class Furnaces {
  constructor(game) {
    this.game = game || null;
    this.states = new Map();       // "x,y,z" -> state
    this._unsubs = [];
  }

  init() {
    const ev = this.game && this.game.events;
    if (ev) {
      // Whoever breaks a furnace (us, or the network), its contents spill out.
      this._unsubs.push(ev.on('block:break', (e) => {
        if (e && (e.blockId === ID.FURNACE || e.blockId === ID.FURNACE_LIT)) this.removeAt(e.x, e.y, e.z);
      }));
    }
    return this;
  }

  reset() { this.states.clear(); }

  get(x, y, z) { return this.states.get(keyOf(x, y, z)) || null; }

  // The state for a furnace, creating an empty one on first use.
  ensure(x, y, z) {
    const k = keyOf(x, y, z);
    let st = this.states.get(k);
    if (!st) { st = emptyState(); this.states.set(k, st); }
    return st;
  }

  // Can this item go in the input / fuel slot right now?
  canInput(st, itemKey) {
    if (!smeltRecipe(itemKey)) return false;
    return !st.input || st.input.id === itemKey;
  }
  canFuel(st, itemKey) {
    if (!fuelTime(itemKey)) return false;
    return !st.fuel || st.fuel.id === itemKey;
  }

  // Would the current input produce something that fits in the output slot?
  _canSmelt(st) {
    if (!st.input) return false;
    const r = smeltRecipe(st.input.id);
    if (!r) return false;
    if (!st.output) return true;
    return st.output.id === r.out && st.output.count < Items.stackSize(r.out);
  }

  isBurning(st) { return !!st && st.burn > 0; }

  // Advance one furnace by dt seconds.
  tickState(st, dt) {
    const wasBurning = st.burn > 0;
    let canSmelt = this._canSmelt(st);

    // Light a new piece of fuel only when there is work to do.
    if (st.burn <= 0 && canSmelt && st.fuel) {
      const t = fuelTime(st.fuel.id);
      if (t > 0) {
        st.burn = st.burnMax = t;
        st.fuel.count -= 1;
        if (st.fuel.count <= 0) st.fuel = null;
      }
    }

    if (st.burn > 0) {
      const used = Math.min(dt, st.burn);
      st.burn -= used;
      if (canSmelt) {
        st.cook += used;
        const r = smeltRecipe(st.input.id);
        if (st.cook >= r.time) {
          st.cook = 0;
          st.input.count -= 1;
          if (st.input.count <= 0) st.input = null;
          if (st.output) st.output.count += 1;
          else st.output = { id: r.out, count: 1 };
          canSmelt = this._canSmelt(st);
        }
      }
      if (st.burn <= 0) st.burn = 0;
    }

    // Progress is lost outright when there is nothing valid to cook, and
    // bleeds away while the fire is out.
    if (!canSmelt) st.cook = 0;
    else if (st.burn <= 0) st.cook = Math.max(0, st.cook - dt * 2);
    return wasBurning !== (st.burn > 0);
  }

  update(dt) {
    if (!this.states.size) return;
    const world = this.game && this.game.world;
    for (const [k, st] of this.states) {
      this.tickState(st, dt);
      if (!world) continue;
      // Keep the block in the world matching the burn state. Only touch loaded
      // chunks: getBlock reports unloaded space as air, which we skip.
      const [x, y, z] = k.split(',').map(Number);
      const cur = world.getBlock(x, y, z);
      if (cur !== ID.FURNACE && cur !== ID.FURNACE_LIT) continue;
      const want = st.burn > 0 ? ID.FURNACE_LIT : ID.FURNACE;
      if (cur !== want) world.setBlock(x, y, z, want, { cause: 'network' });
    }
  }

  // A furnace block is gone: hand its contents back to the world.
  removeAt(x, y, z) {
    const k = keyOf(x, y, z);
    const st = this.states.get(k);
    if (!st) return;
    this.states.delete(k);
    const ents = this.game && this.game.entities;
    if (ents && typeof ents.dropItem === 'function') {
      for (const s of [st.input, st.fuel, st.output]) {
        if (s && s.count > 0) {
          try { ents.dropItem(x + 0.5, y + 0.5, z + 0.5, s.id, s.count); } catch (_) { /* never throw from an event */ }
        }
      }
    }
  }

  /* ---- persistence ------------------------------------------------------ */

  serialize() {
    const out = [];
    for (const [k, st] of this.states) {
      if (!st.input && !st.fuel && !st.output && st.burn <= 0) continue;   // empty: nothing to keep
      out.push({
        k, input: copyStack(st.input), fuel: copyStack(st.fuel), output: copyStack(st.output),
        burn: st.burn, burnMax: st.burnMax, cook: st.cook,
      });
    }
    return out;
  }

  load(arr) {
    this.states.clear();
    if (!Array.isArray(arr)) return;
    const okStack = (s) => (s && typeof s.id === 'string' && Items.has(s.id) && s.count > 0)
      ? { id: s.id, count: Math.floor(s.count) } : null;
    for (const e of arr) {
      if (!e || typeof e.k !== 'string') continue;
      this.states.set(e.k, {
        input: okStack(e.input), fuel: okStack(e.fuel), output: okStack(e.output),
        burn: Math.max(0, +e.burn || 0), burnMax: Math.max(0, +e.burnMax || 0), cook: Math.max(0, +e.cook || 0),
      });
    }
  }
}

export default Furnaces;
