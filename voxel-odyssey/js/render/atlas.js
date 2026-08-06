/* =========================================================================
   atlas.js — block texture storage.

   WHY A TEXTURE ARRAY, NOT A 2D ATLAS
   -----------------------------------
   The usual voxel approach packs every block texture into one big 2D image
   and gives each face a sub-rectangle of UVs. It works, but it fights the
   GPU on two fronts:

     - Mip bleeding. At distance the hardware averages neighbouring texels,
       which at a tile border means averaging in the *next block's* texture.
       You get dirt-coloured fringes on grass at range. The usual mitigation
       (padding each tile with duplicated edge pixels) costs memory and only
       buys a couple of mip levels before it breaks down anyway.
     - Wrapping. A tile can't repeat, so anything wanting REPEAT has to be
       faked in the mesher.

   A DataArrayTexture (WebGL2 `sampler2DArray`) sidesteps both: each texture
   is its own layer with its own full mip chain, sampled as texture(atlas,
   vec3(uv, layer)). No bleeding is even possible, because no two textures
   share a texel neighbourhood. Faces just carry a layer index.

   Every layer must share one resolution, so incoming images (a 16px built-in
   set, a 64px resource pack) are all rescaled to `tileSize` on the way in.

   ANIMATION
   ---------
   Minecraft animates a texture by stacking its frames vertically in one PNG
   and describing the timing in a .mcmeta sidecar. We split those frames into
   consecutive layers at build time; playing an animation is then just
   rewriting the block's layer index each tick — no texture uploads at all.
   ========================================================================= */

import * as THREE from 'three';
import Blocks, { ID } from '../world/blocks.js';

/* Which texture each block wears, per face. Keys are block registry keys.
   A string means "same texture on all faces"; an object names the sides that
   differ. This lives here rather than in blocks.js so the block registry
   stays a pure gameplay/data table with no rendering concerns. */
export const BLOCK_TEXTURES = {
  stone: 'stone',
  dirt: 'dirt',
  grass: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
  sand: 'sand',
  water: 'water',
  log: { top: 'log_top', side: 'log_side', bottom: 'log_top' },
  leaves: 'leaves',
  planks: 'planks',
  cobblestone: 'cobblestone',
  bedrock: 'bedrock',
  gravel: 'gravel',
  snow: { top: 'snow', side: 'snow_side', bottom: 'dirt' },
  ice: 'ice',
  coal_ore: 'coal_ore',
  iron_ore: 'iron_ore',
  gold_ore: 'gold_ore',
  diamond_ore: 'diamond_ore',
  glass: 'glass',
  glowstone: 'glowstone',
  cactus: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' },
  pumpkin: { top: 'pumpkin_top', side: 'pumpkin_side', bottom: 'pumpkin_top' },
  crafting_table: { top: 'crafting_table_top', side: 'crafting_table_side', bottom: 'planks' },
  furnace: { top: 'furnace_top', side: 'furnace_side', bottom: 'furnace_top' },
  bricks: 'bricks',
  mossy_cobble: 'mossy_cobble',
  clay: 'clay',
  sandstone: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' },
  birch_log: { top: 'birch_log_top', side: 'birch_log_side', bottom: 'birch_log_top' },
  birch_leaves: 'birch_leaves',
  pine_log: { top: 'log_top', side: 'pine_log_side', bottom: 'log_top' },
  pine_leaves: 'pine_leaves',
  flower_red: 'flower_red',
  flower_yellow: 'flower_yellow',
  tall_grass: 'tall_grass',
  mushroom_red: 'mushroom_red',
  torch: 'torch',
  obsidian: 'obsidian',
  emerald_ore: 'emerald_ore',
  redstone_ore: 'redstone_ore',
  lantern: 'lantern',
};

/* Face index -> which slot of a per-face texture spec applies.
   0:+X 1:-X 2:+Y(top) 3:-Y(bottom) 4:+Z 5:-Z */
const FACE_SLOT = ['side', 'side', 'top', 'bottom', 'side', 'side'];

export class TextureAtlas {
  constructor(tileSize = 16) {
    this.tileSize = tileSize;
    this.texture = null;

    this.names = [];                 // layer index -> texture name
    this.indexByName = new Map();    // texture name -> layer index
    this.animations = new Map();     // base name -> { frames:[idx], time, frameTime }

    // blockId*6 + face -> layer index. Flat array so the mesher's per-face
    // lookup is an array read, not a map lookup + string build. The mesher
    // calls layerFor() once per emitted face — millions of times per world.
    this._faceLayer = null;

    // NOTE: layer lookup returns a plain integer, not a descriptor object.
    // An earlier version returned a shared mutable {index,u0,v0,u1,v1} to
    // avoid allocating in the mesher's hot loop, but that aliases: holding
    // two results at once silently gave both the second one's index. With a
    // texture array the UV rect is always the whole tile, so the object
    // carried no information beyond the index anyway.
  }

  get layerCount() { return this.names.length; }

  /**
   * Build from a map of { textureName: source }, where source is anything
   * canvas drawImage accepts (HTMLImageElement, ImageBitmap, canvas), or
   * { image, frames } for an animated texture.
   */
  static build(sources, opts = {}) {
    const tileSize = opts.tileSize || 16;
    const atlas = new TextureAtlas(tileSize);

    // Flatten sources into an ordered list of layers, expanding animations.
    const entries = [];
    for (const [name, src] of Object.entries(sources)) {
      const frames = (src && src.frames) || 1;
      entries.push({ name, src: (src && src.image) || src, frames, meta: src && src.meta });
    }
    // Stable order keeps layer indices deterministic between runs, which
    // matters because chunk geometry caches them.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    let totalLayers = 0;
    for (const e of entries) totalLayers += e.frames;

    const size = tileSize * tileSize * 4;
    const data = new Uint8Array(size * totalLayers);

    const canvas = makeCanvas(tileSize, tileSize);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;   // keep the crisp pixel-art look

    let layer = 0;
    for (const e of entries) {
      const first = layer;
      const srcW = e.src.width || tileSize;
      const srcH = e.src.height || tileSize;
      // Animated sheets stack frames vertically, so one frame is srcH/frames.
      const frameH = srcH / e.frames;

      for (let f = 0; f < e.frames; f++) {
        ctx.clearRect(0, 0, tileSize, tileSize);
        try {
          ctx.drawImage(e.src, 0, f * frameH, srcW, frameH, 0, 0, tileSize, tileSize);
        } catch (err) {
          // A broken image in a user-supplied pack must not kill the build;
          // that layer just stays transparent.
          console.warn(`atlas: could not draw texture "${e.name}"`, err);
        }
        const img = ctx.getImageData(0, 0, tileSize, tileSize);

        // Flip vertically on the way in.
        //
        // Three applies UNPACK_FLIP_Y_WEBGL only to image-sourced textures.
        // A DataArrayTexture is a raw typed-array upload, so it gets no such
        // treatment: row 0 of the buffer becomes v=0, which GL samples as the
        // BOTTOM of the texture — while canvas getImageData returns rows
        // top-first. Uploading directly therefore renders every texture upside
        // down (grass blocks showed dirt on top and the green lip underneath).
        //
        // Correcting it here, once, is what makes every consumer right
        // automatically — terrain, the held-item viewmodel, inventory icons and
        // anything added later — instead of each one carrying its own flipped
        // UVs to compensate.
        const rowBytes = tileSize * 4;
        const base = size * layer;
        for (let row = 0; row < tileSize; row++) {
          const src = row * rowBytes;
          const dst = base + (tileSize - 1 - row) * rowBytes;
          data.set(img.data.subarray(src, src + rowBytes), dst);
        }
        layer++;
      }

      atlas.names[first] = e.name;
      atlas.indexByName.set(e.name, first);
      for (let f = 1; f < e.frames; f++) atlas.names[first + f] = `${e.name}#${f}`;

      if (e.frames > 1) {
        const frameTime = (e.meta && e.meta.frametime ? e.meta.frametime : 2) / 20; // MC ticks -> seconds
        atlas.animations.set(e.name, {
          base: first,
          frames: e.frames,
          frameTime,
          time: 0,
          current: 0,
        });
      }
    }

    const tex = new THREE.DataArrayTexture(data, tileSize, tileSize, totalLayers);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    // NearestFilter on magnification is what preserves the blocky pixel-art
    // identity; linear mipmaps on minification stop distant terrain from
    // shimmering as texels alias against each other.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    atlas.texture = tex;

    atlas._buildFaceTable();
    return atlas;
  }

  /* Precompute blockId*6+face -> layer so the mesher never does string work. */
  _buildFaceTable() {
    const count = Blocks.count;
    this._faceLayer = new Int32Array(count * 6).fill(-1);

    for (const def of Blocks.all()) {
      if (!def || def.id === ID.AIR) continue;
      const spec = BLOCK_TEXTURES[def.key];
      if (!spec) continue;

      for (let f = 0; f < 6; f++) {
        let name;
        if (typeof spec === 'string') name = spec;
        else name = spec[FACE_SLOT[f]] || spec.side || spec.top;
        if (!name) continue;
        const idx = this.indexByName.get(name);
        if (idx !== undefined) this._faceLayer[def.id * 6 + f] = idx;
      }
    }
  }

  /**
   * Atlas layer for one block face, or -1 when the block has no texture (the
   * mesher then falls back to flat vertex colour).
   *
   * Returns a primitive on purpose: it cannot alias, cannot be mutated by a
   * later call, and allocates nothing in the mesher's hot loop.
   */
  layerFor(blockId, face) {
    if (!this._faceLayer) return -1;
    return this._faceLayer[blockId * 6 + face];
  }

  /* Advance animated textures. Rewrites the face table's layer index rather
     than uploading pixels, so an animated water surface costs one integer
     write per frame regardless of how much water is on screen. */
  update(dt) {
    if (this.animations.size === 0) return false;
    let changed = false;

    for (const [name, anim] of this.animations) {
      anim.time += dt;
      if (anim.time < anim.frameTime) continue;
      const advance = Math.floor(anim.time / anim.frameTime);
      anim.time -= advance * anim.frameTime;
      const next = (anim.current + advance) % anim.frames;
      if (next === anim.current) continue;
      anim.current = next;
      this.indexByName.set(name, anim.base + next);
      changed = true;
    }

    if (changed) this._buildFaceTable();
    return changed;
  }

  dispose() {
    if (this.texture) this.texture.dispose();
    this.texture = null;
  }
}

/* Canvas factory that works in a worker (OffscreenCanvas) or on the page. */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export default TextureAtlas;
