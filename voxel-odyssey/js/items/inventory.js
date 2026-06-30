/* =========================================================================
   inventory.js — the player's 36-slot inventory + hotbar selection.

   Pure logic (no Three.js): importable in Node for unit testing. The only
   external dependency is the Items registry (for stack sizes) and the event
   bus on `game.events`, used to notify the HUD/menus of changes.

   Slot layout:
     0..8   hotbar   (the 9 quick-select slots shown on the HUD)
     9..35  main     (the 27 storage slots shown in the inventory screen)

   A slot is either `null` (empty) or a small "item stack" object:
     { id: <itemKey:string>, count: <int >= 1> }

   Mutations always emit 'inventory:change' so the UI can refresh. Hotbar
   selection changes emit 'hotbar:select' { index, item }.
   ========================================================================= */

import Items from './items.js';
import { clamp } from '../core/utils.js';

const HOTBAR_SLOTS = 9;     // slots 0..8
const TOTAL_SLOTS = 36;     // slots 0..35

export class Inventory {
  constructor(game) {
    this.game = game || null;
    this.size = TOTAL_SLOTS;
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    this.selected = 0;       // hotbar index 0..8
  }

  // Cheap; real setup (if any) happens here. Safe to call more than once.
  init() {
    if (!Array.isArray(this.slots) || this.slots.length !== TOTAL_SLOTS) {
      this.slots = new Array(TOTAL_SLOTS).fill(null);
    }
    this.selected = clamp(this.selected | 0, 0, HOTBAR_SLOTS - 1);
    return this;
  }

  /* ---- internal helpers ------------------------------------------------- */

  // Resolve the event bus defensively — `game` (or its events) may be missing
  // when the inventory is exercised in isolation (tests).
  _events() {
    const g = this.game;
    return g && g.events ? g.events : null;
  }

  _emitChange() {
    const ev = this._events();
    if (ev) ev.emit('inventory:change', {});
  }

  _emitSelect() {
    const ev = this._events();
    if (ev) ev.emit('hotbar:select', { index: this.selected, item: this.selectedItem() });
  }

  // Max stack for an item key (defaults to 64 for unknown keys).
  _stackSize(itemKey) {
    const n = Items && typeof Items.stackSize === 'function' ? Items.stackSize(itemKey) : 64;
    return Number.isFinite(n) && n > 0 ? n : 64;
  }

  // True if `slot` is a valid index into the slots array.
  _valid(slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < TOTAL_SLOTS;
  }

  /* ---- selection -------------------------------------------------------- */

  // The stack currently held in the selected hotbar slot (or null).
  selectedItem() {
    return this.slots[this.selected] || null;
  }

  // The 9 hotbar stacks (slots 0..8), as a fresh array (may contain nulls).
  hotbar() {
    return this.slots.slice(0, HOTBAR_SLOTS);
  }

  // Select a specific hotbar slot (clamped to 0..8). Emits 'hotbar:select'.
  setSelected(i) {
    const idx = clamp(Math.round(i || 0), 0, HOTBAR_SLOTS - 1);
    if (idx === this.selected) {
      // Still emit so callers pressing the same key get a confirmation/label.
      this._emitSelect();
      return;
    }
    this.selected = idx;
    this._emitSelect();
  }

  // Move the selection by `delta` (e.g. mouse wheel), wrapping around 0..8.
  scrollSelected(delta) {
    const d = Math.sign(delta || 0) || (delta > 0 ? 1 : delta < 0 ? -1 : 0);
    if (!d) { this._emitSelect(); return; }
    let idx = (this.selected + d) % HOTBAR_SLOTS;
    if (idx < 0) idx += HOTBAR_SLOTS;
    this.selected = idx;
    this._emitSelect();
  }

  /* ---- adding ----------------------------------------------------------- */

  // Add `count` of `itemKey` to the inventory. Stacks into existing partial
  // stacks first (in slot order), then fills empty slots. Returns the number
  // that did NOT fit. Emits 'inventory:change' if anything was added.
  add(itemKey, count = 1) {
    if (!itemKey) return count | 0;
    let remaining = Math.max(0, Math.floor(count));
    if (remaining === 0) return 0;
    if (Items && typeof Items.has === 'function' && !Items.has(itemKey)) {
      // Unknown item key — refuse to add (would render as a "missing" icon).
      return remaining;
    }

    const max = this._stackSize(itemKey);
    let changed = false;

    // Pass 1: top up existing partial stacks of the same item.
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === itemKey && s.count < max) {
        const space = max - s.count;
        const moved = Math.min(space, remaining);
        s.count += moved;
        remaining -= moved;
        changed = true;
      }
    }

    // Pass 2: drop the rest into empty slots, splitting across stacks.
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      if (this.slots[i] == null) {
        const moved = Math.min(max, remaining);
        this.slots[i] = { id: itemKey, count: moved };
        remaining -= moved;
        changed = true;
      }
    }

    if (changed) this._emitChange();
    return remaining;
  }

  /* ---- removing --------------------------------------------------------- */

  // Remove up to `count` items from a specific slot. Returns the number
  // actually removed. Clears the slot when it empties. Emits change if > 0.
  removeAt(slot, count = 1) {
    if (!this._valid(slot)) return 0;
    const s = this.slots[slot];
    if (!s) return 0;
    const removed = Math.min(s.count, Math.max(0, Math.floor(count)));
    if (removed <= 0) return 0;
    s.count -= removed;
    if (s.count <= 0) this.slots[slot] = null;
    this._emitChange();
    return removed;
  }

  // Remove up to `count` from the currently selected hotbar slot.
  removeSelected(count = 1) {
    return this.removeAt(this.selected, count);
  }

  /* ---- queries ---------------------------------------------------------- */

  // Total number of `itemKey` across every slot.
  count(itemKey) {
    if (!itemKey) return 0;
    let total = 0;
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const s = this.slots[i];
      if (s && s.id === itemKey) total += s.count;
    }
    return total;
  }

  // True if at least `n` (default 1) of `itemKey` are present.
  has(itemKey, n = 1) {
    return this.count(itemKey) >= Math.max(1, Math.floor(n));
  }

  /* ---- consuming -------------------------------------------------------- */

  // Remove exactly `n` of `itemKey` if (and only if) that many are available.
  // Returns true on success (and emits change), false if not enough exist.
  consume(itemKey, n = 1) {
    const need = Math.max(0, Math.floor(n));
    if (need === 0) return true;
    if (!this.has(itemKey, need)) return false;

    let remaining = need;
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === itemKey) {
        const taken = Math.min(s.count, remaining);
        s.count -= taken;
        remaining -= taken;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    this._emitChange();
    return true;
  }

  /* ---- drag & drop ------------------------------------------------------ */

  // Drag-and-drop helper used by the inventory UI. If both slots hold the same
  // stackable item, merge a -> b (overflow stays in a); otherwise swap them.
  // Emits 'inventory:change'.
  swap(a, b) {
    if (!this._valid(a) || !this._valid(b) || a === b) return;
    const sa = this.slots[a];
    const sb = this.slots[b];

    // Merging same-item stacks (pour a into b up to b's max stack).
    if (sa && sb && sa.id === sb.id) {
      const max = this._stackSize(sb.id);
      const space = max - sb.count;
      if (space > 0) {
        const moved = Math.min(space, sa.count);
        sb.count += moved;
        sa.count -= moved;
        if (sa.count <= 0) this.slots[a] = null;
        this._emitChange();
        return;
      }
      // b is already full: fall through to a plain swap.
    }

    // Plain swap (covers empty<->stack, different items, and full same-item).
    this.slots[a] = sb;
    this.slots[b] = sa;
    this._emitChange();
  }

  // Optional menu helpers: pull a whole stack out of a slot (returns it and
  // clears the slot), or drop a stack into a slot, merging/returning leftover.
  // These keep the UI drag logic simple while still emitting change events.
  take(slot) {
    if (!this._valid(slot)) return null;
    const s = this.slots[slot];
    if (!s) return null;
    this.slots[slot] = null;
    this._emitChange();
    return s;
  }

  // Place `stack` into `slot`. If the slot holds the same item, merge up to the
  // max stack; returns whatever did not fit (or the displaced stack on a swap),
  // or null if the slot ended up holding the full incoming stack.
  placeInto(slot, stack) {
    if (!this._valid(slot) || !stack || !stack.id || stack.count <= 0) return stack || null;
    const existing = this.slots[slot];
    if (!existing) {
      this.slots[slot] = { id: stack.id, count: Math.floor(stack.count) };
      this._emitChange();
      return null;
    }
    if (existing.id === stack.id) {
      const max = this._stackSize(existing.id);
      const space = max - existing.count;
      const moved = Math.min(space, stack.count);
      existing.count += moved;
      const leftover = stack.count - moved;
      this._emitChange();
      return leftover > 0 ? { id: stack.id, count: leftover } : null;
    }
    // Different item: swap — return the displaced stack to the caller's cursor.
    this.slots[slot] = { id: stack.id, count: Math.floor(stack.count) };
    this._emitChange();
    return existing;
  }

  /* ---- bulk operations -------------------------------------------------- */

  // Empty every slot. Emits change.
  reset() {
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    this.selected = 0;
    this._emitChange();
    this._emitSelect();
  }

  // A friendly starter kit. Uses real item keys from the registry; each entry
  // is added only if the key exists so a registry change can't break startup.
  giveStarter() {
    // Note: the wooden pickaxe is registered as 'wood_pickaxe' (matName_kind);
    // we try the friendly alias first, then fall back to the real key.
    const pickaxeKey = (Items && Items.has && Items.has('wooden_pickaxe'))
      ? 'wooden_pickaxe' : 'wood_pickaxe';

    const kit = [
      ['planks', 16],
      ['torch', 8],
      [pickaxeKey, 1],
      ['bread', 4],
      ['crafting_table', 1],
    ];

    for (const [key, n] of kit) {
      if (Items && typeof Items.has === 'function' && !Items.has(key)) continue;
      this.add(key, n);
    }
    // `add` already emitted change for each item; ensure at least one fires
    // even if every key was missing (keeps UI in sync defensively).
    this._emitChange();
  }

  /* ---- persistence ------------------------------------------------------ */

  // Serialize to a plain, JSON-safe object. Empty slots become null.
  serialize() {
    return {
      selected: this.selected,
      slots: this.slots.map((s) => (s ? { id: s.id, count: s.count } : null)),
    };
  }

  // Restore from a serialized object. Tolerant of missing/short/long data.
  load(obj) {
    const next = new Array(TOTAL_SLOTS).fill(null);
    const src = obj && Array.isArray(obj.slots) ? obj.slots : [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const s = src[i];
      if (s && typeof s.id === 'string' && Number.isFinite(s.count) && s.count > 0) {
        // Drop entries whose item key no longer exists in the registry.
        if (Items && typeof Items.has === 'function' && !Items.has(s.id)) continue;
        next[i] = { id: s.id, count: Math.max(1, Math.floor(s.count)) };
      }
    }
    this.slots = next;
    this.selected = clamp(
      obj && Number.isFinite(obj.selected) ? Math.floor(obj.selected) : 0,
      0, HOTBAR_SLOTS - 1
    );
    this._emitChange();
    this._emitSelect();
  }
}

export default Inventory;
