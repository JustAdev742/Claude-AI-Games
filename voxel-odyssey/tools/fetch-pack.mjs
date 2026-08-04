/* =========================================================================
   fetch-pack.mjs — download a Minecraft resource pack for local testing.

   Usage:
     node tools/fetch-pack.mjs <modrinth-slug|url> [outfile]
     node tools/fetch-pack.mjs --search <terms>       list candidates
     node tools/fetch-pack.mjs --check <file.zip>     report coverage only

   Packs land in packs/, which is gitignored on purpose. Complete Minecraft
   texture packs are substantial original artwork and are almost always "All
   Rights Reserved" — fine to download and play with privately, not fine to
   redistribute by committing into a repository. Keeping them out of git is
   what lets you use any pack you like without the project itself
   redistributing someone's art.

   --check reports which of the game's texture slots a pack actually fills,
   which is the fastest way to tell a complete pack from a partial one. A lot
   of popular packs turn out to be supplements (PBR normal/specular maps, or
   a handful of retextured blocks) with no base colour textures at all.
   ========================================================================= */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PACK_ALIASES } from '../js/render/resourcepack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PACK_DIR = path.join(ROOT, 'packs');
const UA = { 'User-Agent': 'voxel-odyssey-educational/1.0 (resource pack pipeline testing)' };

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`Usage:
  node tools/fetch-pack.mjs <modrinth-slug|url> [outfile]
  node tools/fetch-pack.mjs --search <terms>
  node tools/fetch-pack.mjs --check <file.zip>

Then drag the downloaded .zip onto the game window to apply it.`);
  process.exit(0);
}

/* ---- ZIP central directory, just enough to list entries ---------------- */
function listEntries(buf) {
  const view = new DataView(buf);
  const len = view.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  let count = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);
  if (cd === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(view.getBigUint64(loc + 8, true));
      count = Number(view.getBigUint64(z64 + 32, true));
      cd = Number(view.getBigUint64(z64 + 48, true));
    }
  }
  const dec = new TextDecoder();
  const names = [];
  let p = cd;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(dec.decode(new Uint8Array(buf, p + 46, nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/* ---- coverage report --------------------------------------------------- */
function report(names, label) {
  const set = new Set(names);
  const roots = new Set();
  for (const n of names) {
    const m = n.match(/^assets\/([^/]+)\/textures\/(blocks?)\//);
    if (m) roots.add(`assets/${m[1]}/textures/${m[2]}/`);
  }

  const filled = [];
  const missing = [];
  for (const [slot, cands] of Object.entries(PACK_ALIASES)) {
    let hit = null;
    for (const root of roots) {
      for (const c of cands) if (set.has(`${root}${c}.png`)) { hit = c; break; }
      if (hit) break;
    }
    (hit ? filled : missing).push(slot);
  }

  const total = Object.keys(PACK_ALIASES).length;
  const pct = Math.round((filled.length / total) * 100);
  console.log(`\n${label}`);
  console.log(`  texture roots : ${[...roots].join(', ') || '(none found)'}`);
  console.log(`  block PNGs    : ${names.filter((n) => /\/textures\/blocks?\/.*\.png$/.test(n)).length}`);
  console.log(`  slots filled  : ${filled.length}/${total}  (${pct}%)`);
  if (missing.length) console.log(`  falls back to built-ins for: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` … +${missing.length - 12}` : ''}`);

  // A pack made only of _n/_s files is a PBR supplement, not a texture pack —
  // worth calling out, because it looks complete by file count and then
  // changes nothing in game.
  const pbr = names.filter((n) => /_(n|s)\.png$/.test(n)).length;
  const plain = names.filter((n) => /\/textures\/blocks?\/[^/]*\.png$/.test(n) && !/_(n|s)\.png$/.test(n)).length;
  if (pbr > 0 && plain === 0) {
    console.log('  NOTE: every block texture is a _n/_s map — this is a PBR');
    console.log('        supplement meant to layer over vanilla, and carries no');
    console.log('        base colour textures. It will not change how blocks look.');
  }
  if (pct === 0) console.log('  NOTE: this pack fills none of the slots; the game will look unchanged.');
  return { filled: filled.length, total };
}

/* ---- commands ---------------------------------------------------------- */
async function search(terms) {
  const facets = encodeURIComponent(JSON.stringify([['project_type:resourcepack']]));
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(terms)}&facets=${facets}&limit=20&index=relevance`;
  const res = await fetch(url, { headers: UA });
  const data = await res.json();
  console.log(`${'downloads'.padStart(10)}  ${'license'.padEnd(14)} slug`);
  for (const h of data.hits) {
    console.log(`${h.downloads.toLocaleString().padStart(10)}  ${String(h.license).padEnd(14)} ${h.slug}`);
    console.log(`${' '.repeat(12)}${h.title} — ${h.description.slice(0, 70)}`);
  }
  console.log('\nCheck the license before using a pack for anything beyond private testing.');
}

async function download(target, outfile) {
  let url = target;
  let name = outfile;

  if (!/^https?:\/\//.test(target)) {
    const res = await fetch(`https://api.modrinth.com/v2/project/${target}/version`, { headers: UA });
    if (!res.ok) throw new Error(`Modrinth returned ${res.status} for "${target}"`);
    const versions = await res.json();
    if (!versions.length) throw new Error(`No published versions for "${target}"`);
    const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
    url = file.url;
    name = name || `${target}.zip`;
    console.log(`${target}: version ${versions[0].version_number}, ${(file.size / 1e6).toFixed(1)} MB`);
  }
  name = name || path.basename(new URL(url).pathname) || 'pack.zip';

  await fs.mkdir(PACK_DIR, { recursive: true });
  const dest = path.isAbsolute(name) ? name : path.join(PACK_DIR, name);

  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`saved ${path.relative(ROOT, dest)} (${(buf.length / 1e6).toFixed(1)} MB)`);

  report(listEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    path.basename(dest));
  console.log('\nDrag that file onto the game window to apply it.');
}

async function check(file) {
  const buf = await fs.readFile(path.resolve(process.cwd(), file));
  report(listEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    path.basename(file));
}

try {
  if (args[0] === '--search') await search(args.slice(1).join(' '));
  else if (args[0] === '--check') await check(args[1]);
  else await download(args[0], args[1]);
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
