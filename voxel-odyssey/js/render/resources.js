/* =========================================================================
   resources.js — owns the block texture atlas and resource-pack switching.

   One place is responsible for "what do blocks look like": it builds the
   procedural default set at startup, accepts a user-supplied resource pack,
   merges the two (a pack only has to override the textures it cares about),
   and hands the resulting texture array to World.

   Packs are kept in IndexedDB rather than localStorage: a 64px pack is
   several megabytes of binary, well past localStorage's ~5MB string quota,
   and storing it as base64 would inflate it by a third.
   ========================================================================= */

import TextureAtlas from './atlas.js';
import { generateDefaultTextures } from './textures.js';
import { loadResourcePack } from './resourcepack.js';

const DB_NAME = 'voxel-odyssey-resources';
const DB_STORE = 'packs';
const ACTIVE_KEY = 'active-pack';

export class Resources {
  constructor(game) {
    this.game = game;
    this.atlas = null;
    this.packName = 'Built-in';
    this.packInfo = null;
    this._defaults = null;
    this._tileSize = 16;
  }

  async init() {
    // Canvas work needs a document; under Node (unit tests) we stay atlas-less
    // and the renderer falls back to flat vertex colour.
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return this;

    this._defaults = generateDefaultTextures(16);
    this._rebuild({}, 16);

    // Restore a previously loaded pack, if any. Failure here is never fatal:
    // a corrupt stored pack just leaves the built-in textures in place.
    try {
      const stored = await this._loadStoredPack();
      if (stored && stored.buffer) {
        await this.applyPack(stored.buffer, stored.name, { persist: false });
      }
    } catch (err) {
      console.warn('resources: could not restore stored resource pack', err);
    }
    return this;
  }

  /* Build (or rebuild) the atlas from the defaults plus any pack overrides. */
  _rebuild(overrides, tileSize) {
    const size = tileSize || this._tileSize;
    // Regenerate defaults at the pack's resolution so a 64px pack's textures
    // aren't sitting next to 16px ones scaled up into mush.
    const defaults = size === 16 && this._defaults
      ? this._defaults
      : generateDefaultTextures(size);

    const sources = Object.assign({}, defaults, overrides || {});
    const old = this.atlas;
    this.atlas = TextureAtlas.build(sources, { tileSize: size });
    this._tileSize = size;

    if (this.game && this.game.world && typeof this.game.world.setAtlas === 'function') {
      this.game.world.setAtlas(this.atlas);
    }
    // Dispose only after the new one is bound, so no frame renders with a
    // freed texture.
    if (old) old.dispose();
    return this.atlas;
  }

  /**
   * Apply a resource pack from a .zip ArrayBuffer.
   * @returns {Promise<object>} summary { name, found, missing, tileSize }
   */
  async applyPack(buffer, name = 'Resource pack', opts = {}) {
    const events = this.game && this.game.events;
    const result = await loadResourcePack(buffer, {
      onProgress: (v, tex) => {
        if (events) events.emit('resources:progress', { value: v, texture: tex });
      },
    });

    this._rebuild(result.textures, result.tileSize);
    this.packName = name;
    this.packInfo = {
      name,
      found: result.found,
      missing: result.missing,
      tileSize: result.tileSize,
      description: (result.meta && result.meta.pack && result.meta.pack.description) || '',
    };

    if (opts.persist !== false) {
      try { await this._storePack(buffer, name); }
      catch (err) { console.warn('resources: could not persist pack', err); }
    }

    if (events) events.emit('resources:pack', this.packInfo);
    return this.packInfo;
  }

  /* Drop back to the procedural textures. */
  async clearPack() {
    this._rebuild({}, 16);
    this.packName = 'Built-in';
    this.packInfo = null;
    try { await this._deleteStoredPack(); } catch (_) { /* nothing stored */ }
    const events = this.game && this.game.events;
    if (events) events.emit('resources:pack', null);
  }

  /* Advance animated textures (water, fire, lantern glow in packs that have
     them). Returns true when a layer index changed, meaning chunks that use
     the animated texture need no work at all — only the lookup table moved. */
  update(dt) {
    if (!this.atlas) return false;
    return this.atlas.update(dt);
  }

  /* ---- IndexedDB persistence ------------------------------------------- */

  _openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async _storePack(buffer, name) {
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ buffer, name, savedAt: Date.now() }, ACTIVE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async _loadStoredPack() {
    const db = await this._openDB();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(ACTIVE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  }

  async _deleteStoredPack() {
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(ACTIVE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  dispose() {
    if (this.atlas) this.atlas.dispose();
    this.atlas = null;
  }
}

export default Resources;
