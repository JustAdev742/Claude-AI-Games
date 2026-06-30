/* =========================================================================
   events.js — a tiny synchronous event bus.

   Modules communicate through named events to stay decoupled. Common events
   used across the game (documented here so every module agrees on the shape):

     'block:break'    { x, y, z, blockId, by }      a block was removed
     'block:place'    { x, y, z, blockId, by }      a block was placed
     'block:update'   { x, y, z }                   a single voxel changed
     'chunk:meshed'   { cx, cz }                    a chunk finished meshing
     'player:hurt'    { amount, source }            player took damage
     'player:heal'    { amount }                    player healed
     'player:die'     {}                            player health hit 0
     'player:respawn' {}                            player respawned
     'player:move'    { x, y, z }                   throttled position update
     'entity:spawn'   { entity }                    a mob/entity spawned
     'entity:death'   { entity, by }                a mob died
     'inventory:change' {}                          inventory contents changed
     'hotbar:select'  { index, item }               selected hotbar slot changed
     'item:pickup'    { itemId, count }             player picked up an item
     'craft'          { recipeId, output }          a craft was performed
     'time:day'       {}                            a new day began
     'time:phase'     { phase }                     'dawn'|'day'|'dusk'|'night'
     'mode:change'    { mode }                      'play' | 'menu'
     'pause'          { paused }                    pause state toggled
     'toast'          { text, kind }                request a toast message
     'sfx'            { name, opts }                request a sound effect
     'settings:change' { key, value }               a setting changed
     'loading:progress' { value, text }             loading-screen progress
   ========================================================================= */

export class EventBus {
  constructor() {
    this._handlers = new Map();   // name -> Set<fn>
    this._onceWrappers = new Map(); // original fn -> wrapper, for off()
    this._debug = false;
  }

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this.off(name, fn); // returns an unsubscribe handle
  }

  once(name, fn) {
    const wrapper = (payload) => { this.off(name, wrapper); fn(payload); };
    this._onceWrappers.set(fn, wrapper);
    return this.on(name, wrapper);
  }

  off(name, fn) {
    const set = this._handlers.get(name);
    if (!set) return;
    set.delete(fn);
    const wrapper = this._onceWrappers.get(fn);
    if (wrapper) { set.delete(wrapper); this._onceWrappers.delete(fn); }
  }

  emit(name, payload) {
    if (this._debug) console.debug('[event]', name, payload);
    const set = this._handlers.get(name);
    if (!set || set.size === 0) return;
    // Copy to a temporary array so handlers may unsubscribe during dispatch.
    const arr = [...set];
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (err) {
        console.error(`[event] handler for "${name}" threw:`, err);
      }
    }
  }

  // Remove every handler for a name, or all handlers if no name given.
  clear(name) {
    if (name) this._handlers.delete(name);
    else this._handlers.clear();
  }

  listenerCount(name) {
    const set = this._handlers.get(name);
    return set ? set.size : 0;
  }

  setDebug(on) { this._debug = !!on; }
}

// A convenient shared instance; modules may also create their own buses.
export const globalBus = new EventBus();
