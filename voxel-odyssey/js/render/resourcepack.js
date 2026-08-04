/* =========================================================================
   resourcepack.js — load standard Minecraft resource packs (.zip).

   Packs from Modrinth, CurseForge or anywhere else are ordinary ZIP archives
   laid out as:

       pack.mcmeta
       assets/minecraft/textures/block/stone.png
       assets/minecraft/textures/block/water_still.png
       assets/minecraft/textures/block/water_still.png.mcmeta   (animation)

   We read the ZIP ourselves rather than pulling in a library. The browser
   already ships the hard part — DecompressionStream('deflate-raw') is exactly
   the codec ZIP uses for method 8 — so a central-directory parser plus that
   is a complete reader in a couple hundred lines, and the game keeps its
   zero-dependency, works-offline property.

   Only textures referenced by BLOCK_TEXTURES are decompressed. A pack with
   thousands of entity/UI/item textures costs no more than the ~40 block
   textures we actually use.

   NAME MAPPING
   ------------
   Minecraft renamed many textures in 1.13 (grass_top -> grass_block_top,
   log_oak -> oak_log). Each of our texture slots therefore lists candidate
   source names newest-first, and we take the first one the pack provides.
   That makes a single loader work across modern and legacy packs.
   ========================================================================= */

/* Our texture name -> candidate filenames inside the pack (without .png),
   most-modern first. */
export const PACK_ALIASES = {
  stone: ['stone'],
  dirt: ['dirt'],
  grass_top: ['grass_block_top', 'grass_top'],
  grass_side: ['grass_block_side', 'grass_side'],
  sand: ['sand'],
  water: ['water_still', 'water'],
  log_side: ['oak_log', 'log_oak'],
  log_top: ['oak_log_top', 'log_oak_top'],
  leaves: ['oak_leaves', 'leaves_oak'],
  planks: ['oak_planks', 'planks_oak'],
  cobblestone: ['cobblestone'],
  bedrock: ['bedrock'],
  gravel: ['gravel'],
  snow: ['snow'],
  snow_side: ['grass_block_snow', 'grass_side_snowed'],
  ice: ['ice'],
  coal_ore: ['coal_ore'],
  iron_ore: ['iron_ore'],
  gold_ore: ['gold_ore'],
  diamond_ore: ['diamond_ore'],
  emerald_ore: ['emerald_ore'],
  redstone_ore: ['redstone_ore'],
  glass: ['glass'],
  glowstone: ['glowstone'],
  cactus_top: ['cactus_top'],
  cactus_side: ['cactus_side'],
  pumpkin_top: ['pumpkin_top'],
  pumpkin_side: ['pumpkin_side'],
  crafting_table_top: ['crafting_table_top'],
  crafting_table_side: ['crafting_table_side', 'crafting_table_front'],
  furnace_top: ['furnace_top'],
  furnace_side: ['furnace_front', 'furnace_side'],
  bricks: ['bricks', 'brick'],
  mossy_cobble: ['mossy_cobblestone', 'cobblestone_mossy'],
  clay: ['clay'],
  sandstone_top: ['sandstone_top'],
  sandstone_side: ['sandstone', 'sandstone_normal'],
  birch_log_side: ['birch_log', 'log_birch'],
  birch_log_top: ['birch_log_top', 'log_birch_top'],
  birch_leaves: ['birch_leaves', 'leaves_birch'],
  pine_log_side: ['spruce_log', 'log_spruce'],
  pine_leaves: ['spruce_leaves', 'leaves_spruce'],
  flower_red: ['poppy', 'flower_rose'],
  flower_yellow: ['dandelion', 'flower_dandelion'],
  tall_grass: ['short_grass', 'grass', 'tallgrass'],
  mushroom_red: ['red_mushroom', 'mushroom_red'],
  torch: ['torch', 'torch_on'],
  obsidian: ['obsidian'],
  lantern: ['lantern', 'sea_lantern'],
};

/* ---------------------------------------------------------------------------
   Minimal ZIP reader.
   --------------------------------------------------------------------------- */

/* One shared decoder. A pack's central directory can hold thousands of
   entries, and allocating a TextDecoder per filename showed up in profiling. */
const NAME_DECODER = new TextDecoder();
export const decodeText = (bytes) => NAME_DECODER.decode(bytes);

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipReader {
  constructor(arrayBuffer) {
    this.buf = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.entries = new Map();   // path -> {offset, compSize, size, method}
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const view = this.view;
    const len = view.byteLength;

    // The EOCD sits at the end, after a comment of up to 64KB. Scan backwards
    // for its signature.
    let eocd = -1;
    const scanFrom = Math.max(0, len - 66000);
    for (let i = len - 22; i >= scanFrom; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

    let count = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);

    // ZIP64: a pack over 4GB, or with >65535 entries, stores the real values
    // in a separate record and puts sentinels here.
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && view.getUint32(locator, true) === SIG_EOCD64_LOCATOR) {
        const z64 = Number(view.getBigUint64(locator + 8, true));
        count = Number(view.getBigUint64(z64 + 32, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > len || view.getUint32(p, true) !== SIG_CENTRAL) break;
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = NAME_DECODER.decode(new Uint8Array(this.buf, p + 46, nameLen));

      this.entries.set(name, { localOffset, compSize, size, method });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(path) { return this.entries.has(path); }
  list() { return [...this.entries.keys()]; }

  /* Decompress one entry. Returns a Uint8Array. */
  async read(path) {
    const e = this.entries.get(path);
    if (!e) return null;

    // The central directory's name/extra lengths can differ from the local
    // header's, so the payload offset must come from the local header.
    const v = this.view;
    if (v.getUint32(e.localOffset, true) !== SIG_LOCAL) return null;
    const nameLen = v.getUint16(e.localOffset + 26, true);
    const extraLen = v.getUint16(e.localOffset + 28, true);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = new Uint8Array(this.buf, start, e.compSize);

    if (e.method === 0) return raw.slice();          // stored
    if (e.method !== 8) throw new Error(`Unsupported ZIP compression method ${e.method} for ${path}`);

    // Method 8 is raw DEFLATE — exactly what DecompressionStream provides.
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}

/* ---------------------------------------------------------------------------
   Pack loading.
   --------------------------------------------------------------------------- */

/**
 * Read a resource pack and return textures ready for the atlas builder.
 *
 * @param {ArrayBuffer} buffer  the .zip contents
 * @param {object} opts         { onProgress }
 * @returns {Promise<{textures:object, meta:object, found:number, missing:string[]}>}
 *   textures maps OUR texture names to { image, frames, meta }, suitable for
 *   TextureAtlas.build(). Only textures the pack actually provides appear;
 *   callers merge them over the procedural defaults.
 */
export async function loadResourcePack(buffer, opts = {}) {
  const zip = new ZipReader(buffer);
  const onProgress = opts.onProgress || (() => {});

  // Namespace directories other than `minecraft` exist in some packs; scan for
  // whichever namespace actually carries block textures.
  const roots = new Set();
  for (const path of zip.entries.keys()) {
    const m = path.match(/^assets\/([^/]+)\/textures\/block(?:s)?\//);
    if (m) roots.add(`assets/${m[1]}/textures/${path.includes('/textures/blocks/') ? 'blocks' : 'block'}/`);
  }
  if (roots.size === 0) {
    throw new Error('No block textures found — is this a Minecraft resource pack?');
  }

  // pack.mcmeta describes the pack; purely informational for us.
  let meta = {};
  try {
    if (zip.has('pack.mcmeta')) {
      const raw = await zip.read('pack.mcmeta');
      meta = JSON.parse(decodeText(raw));
    }
  } catch (_) { /* a malformed pack.mcmeta shouldn't block the textures */ }

  const names = Object.keys(PACK_ALIASES);
  const textures = {};
  const missing = [];
  let done = 0;

  // Resolve every slot to a path first. This is pure Map lookups — sub-
  // millisecond even for a pack with thousands of entries — so it costs
  // nothing to do up front and lets the expensive work be batched.
  const jobs = [];
  for (const ourName of names) {
    let path = null;
    outer:
    for (const root of roots) {
      for (const candidate of PACK_ALIASES[ourName]) {
        const p = `${root}${candidate}.png`;
        if (zip.has(p)) { path = p; break outer; }
      }
    }
    if (path) jobs.push({ ourName, path });
    else missing.push(ourName);
  }

  // Decompress and decode CONCURRENTLY.
  //
  // Doing this in a sequential loop was pathologically slow: every await
  // yields to the event loop, which runs a full render frame before resuming,
  // so the cost per texture was a frame time rather than the actual decode.
  // On a 71MB pack that turned ~40ms of real work into ~35 seconds. Issuing
  // the reads together lets them overlap each other and the render loop.
  //
  // Bounded, because createImageBitmap on hundreds of textures at once will
  // spike memory on low-end machines — the thing we are explicitly trying not
  // to require.
  const CONCURRENCY = 8;
  const decodeOne = async ({ ourName, path }) => {
    try {
      const bytes = await zip.read(path);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));

      // An animated texture is a vertical strip of square frames; its sidecar
      // .mcmeta carries the timing.
      let frames = 1;
      let animMeta = null;
      if (bitmap.height > bitmap.width && bitmap.height % bitmap.width === 0) {
        frames = bitmap.height / bitmap.width;
      }
      const mcmetaPath = `${path}.mcmeta`;
      if (zip.has(mcmetaPath)) {
        try {
          const mm = JSON.parse(decodeText(await zip.read(mcmetaPath)));
          if (mm && mm.animation) animMeta = mm.animation;
        } catch (_) { /* a bad sidecar still animates at the default rate */ }
      }
      textures[ourName] = { image: bitmap, frames, meta: animMeta };
    } catch (err) {
      console.warn(`resource pack: failed to decode ${path}`, err);
      missing.push(ourName);
    } finally {
      done++;
      onProgress(done / Math.max(1, jobs.length), ourName);
    }
  };

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(decodeOne));
  }

  return {
    textures,
    meta,
    found: Object.keys(textures).length,
    missing,
    // The pack's own resolution, so the atlas can size itself to match rather
    // than downscaling a 64px pack to 16px.
    tileSize: guessTileSize(textures),
  };
}

function guessTileSize(textures) {
  let best = 16;
  for (const t of Object.values(textures)) {
    const w = t.image && t.image.width;
    if (w && w > best) best = w;
  }
  // Clamp: a 512px pack across ~45 layers would be 47MB of VRAM, which is not
  // a reasonable default on integrated graphics.
  return Math.min(best, 128);
}

export default loadResourcePack;
