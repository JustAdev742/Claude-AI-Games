/* The compact vertex format: pack/unpack must be faithful to what the mesher
   produced, and small. */
import { packBucket, unpackVertex, faceOfNormal, packedBuffers, POS_SCALE } from '../js/world/vertexPack.js';
import { meshChunk, Chunk } from '../js/world/chunk.js';
import { WorldGen } from '../js/world/worldgen.js';
import { ID, FACES } from '../js/world/blocks.js';
import { CHUNK_SX, CHUNK_SZ } from '../js/world/constants.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};

/* ---- face numbering matches the block table ---- */
{
  let good = true;
  FACES.forEach((f, i) => { if (faceOfNormal(f.dir[0], f.dir[1], f.dir[2]) !== i) good = false; });
  ok('faces: normals map to the FACES order', good);
}

/* ---- a real chunk round-trips ---- */
{
  const wg = new WorldGen({ seed: 1 }); wg.setSeed(99);
  const chunks = new Map();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) { const c = new Chunk(cx, cz); wg.generateChunk(c); chunks.set(`${cx},${cz}`, c); }
  const c = chunks.get('0,0');
  const getBlock = (x, y, z) => {
    const cx = Math.floor(x / CHUNK_SX), cz = Math.floor(z / CHUNK_SZ);
    const k = chunks.get(`${cx},${cz}`);
    return k ? k.getLocal(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ) : 0;
  };
  const atlas = { layerFor: (id, f) => (id * 7 + f) % 90 };
  const data = meshChunk(c, getBlock, { atlas, getLight: () => 0xc5, climate: (() => { const a = new Float32Array(512); for (let i = 0; i < 512; i += 2) { a[i] = 0.95; a[i + 1] = 0.2; } return a; })() });

  for (const name of ['opaque', 'water', 'cross']) {
    const b = data[name];
    const p = packBucket(b);
    if (!b.positions.length) { ok(`${name}: empty bucket packs to null`, p === null); continue; }
    const n = b.positions.length / 3;
    ok(`${name}: ${n} vertices packed`, p && p.count === n && p.pos.length === n * 4);
    ok(`${name}: 16 bytes per vertex (was 60)`, p.pos.byteLength + p.col.byteLength + p.misc.byteLength === n * 16);
    ok(`${name}: indices are 16-bit when they fit and unchanged`, p.indices instanceof Uint16Array && p.indices.length === b.indices.length && b.indices.every((v, i) => p.indices[i] === v));

    let worst = { pos: 0, col: 0, light: 0, ao: 0 }, badNormal = 0, badUv = 0, badTex = 0;
    for (let i = 0; i < n; i += 3) {
      const v = unpackVertex(p, i);
      worst.pos = Math.max(worst.pos, Math.abs(v.x - b.positions[i * 3]), Math.abs(v.y - b.positions[i * 3 + 1]), Math.abs(v.z - b.positions[i * 3 + 2]));
      worst.col = Math.max(worst.col, Math.abs(v.r - b.colors[i * 3]), Math.abs(v.g - b.colors[i * 3 + 1]), Math.abs(v.b - b.colors[i * 3 + 2]));
      worst.light = Math.max(worst.light, Math.abs(v.sky - b.light[i * 2]), Math.abs(v.blk - b.light[i * 2 + 1]));
      worst.ao = Math.max(worst.ao, Math.abs(v.ao - b.ao[i]));
      if (v.normal[0] !== b.normals[i * 3] || v.normal[1] !== b.normals[i * 3 + 1] || v.normal[2] !== b.normals[i * 3 + 2]) badNormal++;
      if (v.u !== b.uv[i * 2] || v.v !== b.uv[i * 2 + 1]) badUv++;
      if (v.texIdx !== b.texIdx[i]) badTex++;
    }
    ok(`${name}: positions within 1/${POS_SCALE * 2} block`, worst.pos <= 1 / (POS_SCALE * 2) + 1e-9, worst.pos);
    ok(`${name}: colours (incl. biome tints above 1) within 1/127`, worst.col <= 1 / 127 + 1e-9, worst.col);
    ok(`${name}: light and AO within 1/255`, worst.light <= 1 / 255 + 1e-9 && worst.ao <= 1 / 255 + 1e-9, JSON.stringify(worst));
    ok(`${name}: normals, uv corners and texture layers exact`, badNormal === 0 && badUv === 0 && badTex === 0, `${badNormal}/${badUv}/${badTex}`);
  }
  // A hot, dry climate tints grass red-ward by more than 1x (see biomeColor.js);
  // the format has to carry multipliers above 1.
  const grass = new Chunk(0, 0);
  grass.setLocal(5, 10, 5, ID.GRASS);
  const hot = new Float32Array(512); for (let i = 0; i < 512; i += 2) { hot[i] = 1; hot[i + 1] = 0; }
  const gd = meshChunk(grass, () => 0, { atlas, climate: hot });
  const gp = packBucket(gd.opaque);
  let maxCol = 0;
  for (let i = 0; i < gp.count; i++) maxCol = Math.max(maxCol, unpackVertex(gp, i).r);
  ok('colour: a hot-climate tint above 1.0 survives (range is 0..2)', maxCol > 1.3, `${maxCol}`);
}

/* ---- awkward inputs ---- */
{
  const one = {
    positions: [0.02, 80, 16, 15.98, 0.88, 3.5, 0, 0, 0],
    normals: [0, 1, 0, 0, 0, -1, 1, 0, 0],
    colors: [0.5, 0.5, 0.5, 2.5, -1, 1, 1, 1, 1],
    light: [0, 1, 0.2, 0.8, 1, 0], ao: [1, 0.5, 0],
    uv: [0, 0, 1, 0, 0, 1], texIdx: [-1, 0, 65000], indices: [0, 1, 2],
  };
  const p = packBucket(one);
  const v0 = unpackVertex(p, 0), v1 = unpackVertex(p, 1), v2 = unpackVertex(p, 2);
  ok('edge: untextured (-1) survives', v0.texIdx === -1 && v1.texIdx === 0 && v2.texIdx === 65000);
  ok('edge: the far corner of a chunk and the lowered water level survive', Math.abs(v0.y - 80) < 1e-9 && Math.abs(v0.z - 16) < 1e-9 && Math.abs(v1.y - 0.88) < 0.003);
  ok('edge: out-of-range colours clamp instead of wrapping', v1.r <= 2 && v1.g === 0);
  ok('edge: buffers list for transfer', packedBuffers(p).length === 4 && packedBuffers(null).length === 0);
  ok('edge: empty buckets are null', packBucket({ positions: [], indices: [] }) === null);

  const n = 70000;
  const big = { positions: new Array(n * 3).fill(1), normals: new Array(n * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), colors: new Array(n * 3).fill(1), light: new Array(n * 2).fill(1), ao: new Array(n).fill(1), uv: new Array(n * 2).fill(0), texIdx: new Array(n).fill(2), indices: [0, 1, n - 1] };
  const pb = packBucket(big);
  ok('edge: more than 65535 vertices switches to 32-bit indices', pb.indices instanceof Uint32Array && pb.indices[2] === n - 1);
}

console.log(`\n==== vertex pack: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
