/* Tests for the hand-rolled ZIP reader that backs resource-pack loading.

   Resource packs are the one place the game parses a binary format it didn't
   write, so the reader is verified against archives built here byte-by-byte:
   both compression methods a real pack uses (stored and deflate), names long
   enough to exercise the offset arithmetic, and the local-vs-central header
   divergence that trips up naive implementations. */

import { deflateRawSync, crc32 } from 'zlib';
import { ZipReader, PACK_ALIASES } from '../js/render/resourcepack.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

/* ---- a minimal ZIP writer, so tests own their fixtures ---- */
function buildZip(files, opts = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const deflate = f.method !== 0;
    const payload = deflate ? deflateRawSync(Buffer.from(raw)) : Buffer.from(raw);
    const crc = crc32 ? crc32(Buffer.from(raw)) : 0;

    // Local file header. `extraLocal` lets a test make the local header's
    // extra field differ from the central one — real archivers do this, and a
    // reader that takes the payload offset from the central directory breaks.
    const extraLocal = f.extraLocal || 0;
    const local = Buffer.alloc(30 + nameBytes.length + extraLocal);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extraLocal, 28);
    Buffer.from(nameBytes).copy(local, 30);

    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);   // central extra len: deliberately 0
    central.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const comment = opts.comment ? Buffer.from(opts.comment) : Buffer.alloc(0);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([...locals, cd, eocd]);
}

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = (bytes) => new TextDecoder().decode(bytes);

/* ---- 1. stored + deflated entries round-trip ---- */
{
  const bigBody = 'stone'.repeat(500);   // compresses well, exercises deflate
  const zip = buildZip([
    { name: 'pack.mcmeta', data: '{"pack":{"pack_format":15,"description":"Test"}}', method: 8 },
    { name: 'assets/minecraft/textures/block/stone.png', data: bigBody, method: 8 },
    { name: 'assets/minecraft/textures/block/dirt.png', data: 'DIRTDATA', method: 0 },
  ]);
  const r = new ZipReader(toAB(zip));

  ok('finds all entries', r.entries.size === 3, r.entries.size);
  ok('has() by path', r.has('assets/minecraft/textures/block/stone.png'));
  ok('missing path is absent', !r.has('assets/minecraft/textures/block/nope.png'));

  const meta = JSON.parse(text(await r.read('pack.mcmeta')));
  ok('deflated json round-trips', meta.pack.description === 'Test', JSON.stringify(meta));

  const stone = text(await r.read('assets/minecraft/textures/block/stone.png'));
  ok('deflated large body round-trips', stone === bigBody, `len=${stone.length}`);

  const dirt = text(await r.read('assets/minecraft/textures/block/dirt.png'));
  ok('stored entry round-trips', dirt === 'DIRTDATA', dirt);
}

/* ---- 2. local header extra field differs from central ----
   The payload offset must be derived from the LOCAL header. Readers that
   trust the central directory's extra length read garbage here. */
{
  const zip = buildZip([
    { name: 'assets/minecraft/textures/block/sand.png', data: 'SANDPAYLOAD', method: 0, extraLocal: 17 },
  ]);
  const r = new ZipReader(toAB(zip));
  const got = text(await r.read('assets/minecraft/textures/block/sand.png'));
  ok('honours local header extra length', got === 'SANDPAYLOAD', JSON.stringify(got));
}

/* ---- 3. EOCD located past a trailing archive comment ---- */
{
  const zip = buildZip(
    [{ name: 'assets/minecraft/textures/block/clay.png', data: 'CLAY', method: 8 }],
    { comment: 'x'.repeat(300) },
  );
  const r = new ZipReader(toAB(zip));
  ok('scans back past archive comment', r.has('assets/minecraft/textures/block/clay.png'));
  ok('reads entry after comment', text(await r.read('assets/minecraft/textures/block/clay.png')) === 'CLAY');
}

/* ---- 4. a non-ZIP buffer fails loudly rather than silently ---- */
{
  let threw = false;
  try { new ZipReader(toAB(Buffer.from('this is definitely not a zip file'))); }
  catch (e) { threw = /ZIP/i.test(e.message); }
  ok('rejects non-zip input', threw);
}

/* ---- 5. alias table sanity: every slot has candidates, no dupes ---- */
{
  const names = Object.keys(PACK_ALIASES);
  ok('alias table is populated', names.length > 30, names.length);
  ok('every slot lists candidates', names.every((n) => PACK_ALIASES[n].length > 0));

  // A texture name appearing under two slots would make one silently win.
  const seen = new Map();
  let clash = null;
  for (const [slot, cands] of Object.entries(PACK_ALIASES)) {
    for (const c of cands) {
      if (seen.has(c)) clash = `${c} in both ${seen.get(c)} and ${slot}`;
      else seen.set(c, slot);
    }
  }
  ok('no candidate filename claimed by two slots', clash === null, clash);
}

/* ---- 6. modern and legacy names both covered for renamed textures ---- */
{
  ok('grass_top handles 1.13 rename', PACK_ALIASES.grass_top.includes('grass_block_top'));
  ok('grass_top keeps legacy name', PACK_ALIASES.grass_top.includes('grass_top'));
  ok('log_side handles 1.13 rename', PACK_ALIASES.log_side.includes('oak_log'));
  ok('log_side keeps legacy name', PACK_ALIASES.log_side.includes('log_oak'));
}

console.log(`\n==== resource pack: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
