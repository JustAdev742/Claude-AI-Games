/* =========================================================================
   chest.js — storage chests.

   Each placed chest owns 27 slots, stored by position. Slots hold ordinary
   stacks ({id, count, wear?}), so a worn tool keeps its wear in a chest.
   Like furnaces, the contents are local to the client and saved with the
   world; breaking a chest spills everything it held.
   ========================================================================= */

import Items from './items.js';
import { ID } from '../world/blocks.js';
import { cloneStack } from './inventory.js';

export const CHEST_SLOTS = 27;

const keyOf = (x, y, z) => `${x | 0},${y | 0},${z | 0}`;

/* Put a stack into a slot array: top up matching stacks first, then fill empty
   slots. Worn tools never merge. Returns how many items did not fit; the
   `stack` argument is not modified. */
export function moveInto(slots, stack) {
  if (!stack || !stack.id || !(stack.count > 0)) return 0;
  const max = Items.stackSize(stack.id);
  let left = stack.count;
  if (!stack.wear) {
    for (let i = 0; i < slots.length && left > 0; i++) {
      const s = slots[i];
      if (s && s.id === stack.id && !s.wear && s.count < max) {
        const n = Math.min(max - s.count, left);
        s.count += n; left -= n;
      }
    }
  }
  for (let i = 0; i < slots.length && left > 0; i++) {
    if (slots[i] == null) {
      const n = Math.min(max, left);
      slots[i] = cloneStack(stack, n);
      left -= n;
    }
  }
  return left;
}

export class Chests {
  constructor(game) {
    this.game = game || null;
    this.states = new Map();       // "x,y,z" -> { slots: Array(27) of stack | null }
    this._unsubs = [];
  }

  init() {
    const ev = this.game && this.game.events;
    if (ev) {
      this._unsubs.push(ev.on('block:break', (e) => {
        if (e && e.blockId === ID.CHEST) this.removeAt(e.x, e.y, e.z);
      }));
    }
    return this;
  }

  reset() { this.states.clear(); }

  get(x, y, z) { return this.states.get(keyOf(x, y, z)) || null; }

  ensure(x, y, z) {
    const k = keyOf(x, y, z);
    let st = this.states.get(k);
    if (!st) { st = { slots: new Array(CHEST_SLOTS).fill(null) }; this.states.set(k, st); }
    return st;
  }

  // Everything a chest holds, for spilling or counting.
  contents(st) { return st.slots.filter(Boolean); }

  // A chest block is gone: its contents drop into the world.
  removeAt(x, y, z) {
    const k = keyOf(x, y, z);
    const st = this.states.get(k);
    if (!st) return;
    this.states.delete(k);
    const ents = this.game && this.game.entities;
    if (!ents || typeof ents.dropItem !== 'function') return;
    for (const s of this.contents(st)) {
      try { ents.dropItem(x + 0.5, y + 0.5, z + 0.5, s.id, s.count); } catch (_) { /* never throw from an event */ }
    }
  }

  /* ---- persistence ------------------------------------------------------ */

  serialize() {
    const out = [];
    for (const [k, st] of this.states) {
      if (!st.slots.some(Boolean)) continue;                  // empty: nothing to keep
      out.push({ k, slots: st.slots.map((s) => cloneStack(s)) });
    }
    return out;
  }

  load(arr) {
    this.states.clear();
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      if (!e || typeof e.k !== 'string' || !Array.isArray(e.slots)) continue;
      const slots = new Array(CHEST_SLOTS).fill(null);
      for (let i = 0; i < CHEST_SLOTS; i++) {
        const s = e.slots[i];
        if (s && typeof s.id === 'string' && Items.has(s.id) && s.count > 0) {
          slots[i] = { id: s.id, count: Math.min(Items.stackSize(s.id), Math.floor(s.count)) };
          const max = Items.durability(s.id);
          if (max > 0 && s.wear > 0) slots[i].wear = Math.min(max - 1, Math.floor(s.wear));
        }
      }
      this.states.set(e.k, { slots });
    }
  }
}

export default Chests;
