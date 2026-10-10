/* World workers under Node: the worker code (workerCore.js) runs in-process
   behind a fake Worker that behaves like the real one where it matters —
   messages are structured-cloned with transfer lists (so buffers detach), and
   delivery is asynchronous. Run via:
   node --import ./tests/three-resolve.mjs tests/workers.test.mjs */
import { World } from '../js/world/world.js';
import { WorldGen } from '../js/world/worldgen.js';
import { Chunk } from '../js/world/chunk.js';
import { EventBus } from '../js/core/events.js';
import { Perf } from '../js/core/perf.js';
import { createWorkerCore } from '../js/world/workerCore.js';
import { CHUNK_SX, CHUNK_SZ } from '../js/world/constants.js';
import { chunkKey } from '../js/core/utils.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* A worker that runs the real core in this thread, one message per macrotask. */
class FakeWorker {
  constructor(opts = {}) {
    this.opts = opts;
    this.terminated = false;
    this.log = [];
    this.core = createWorkerCore((msg, transfer) => {
      if (this.terminated) return;
      const copy = structuredClone(msg, { transfer: transfer || [] });
      setTimeout(() => { if (!this.terminated && this.onmessage) this.onmessage({ data: copy }); }, 0);
    });
  }
  postMessage(msg, transfer) {
    if (this.terminated) return;
    const copy = structuredClone(msg, { transfer: transfer || [] });
    this.log.push(copy.type === 'gen' || copy.type === 'mesh' ? `${copy.type}:${copy.cx},${copy.cz}` : copy.type);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.opts.failGen && copy.type === 'gen' && this.opts.failGen(copy.cx, copy.cz)) {
        if (this.onmessage) this.onmessage({ data: { type: 'error', kind: 'gen', jobId: copy.jobId, cx: copy.cx, cz: copy.cz, message: 'boom' } });
        return;
      }
      this.core.handle(copy);
    }, 0);
  }
  terminate() { this.terminated = true; }
}

function makeWorld({ rd = 3, seed = 4242, workers = 2, workerOpts = {}, withWorkers = true } = {}) {
  const made = [];
  const added = new Set();
  const game = {
    events: new EventBus(),
    scene: { add: (m) => added.add(m), remove: (m) => added.delete(m) },
    state: { settings: { renderDistance: rd }, flags: {} },
    perf: new Perf(),
    seed,
  };
  game.worldgen = new WorldGen(game);
  game.worldgen.setSeed(seed);
  game.world = new World(game);
  game.world.init();
  if (withWorkers) {
    game.world.meshPool.init({ factory: () => { const w = new FakeWorker(workerOpts); made.push(w); return w; }, count: workers });
  }
  game.world.reset(seed);
  return { game, world: game.world, workers: made };
}
const anchorAt = (cx, cz) => ({ x: cx * CHUNK_SX + 8, y: 40, z: cz * CHUNK_SZ + 8 });
const quiet = (w) => w._planIdx >= (w._plan ? w._plan.length : 0) && w.remeshQueue.size === 0 && w.meshPool.pending === 0;
async function settle(world, anchor, max = 3000) {
  for (let i = 0; i < max; i++) {
    world.update(0.016, anchor);
    await tick();
    if (quiet(world)) { world.update(0.016, anchor); if (quiet(world)) return i + 1; }
  }
  return max;
}
function syncSettle(world, anchor, max = 400) {
  for (let i = 0; i < max; i++) { world.update(0.016, anchor); if (quiet(world)) return; }
}
const vcount = (world, key) => {
  const set = world.meshes.get(key);
  if (!set) return 'none';
  return ['opaque', 'water', 'cross'].map((b) => (set[b] ? set[b].geometry.getAttribute('aPos').count : 0)).join('/');
};
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---- the generation job itself ---- */
{
  const out = [];
  const core = createWorkerCore((m) => out.push(m));
  let same = true, climateSame = true;
  for (const [seed, cx, cz] of [[4242, 0, 0], [4242, -5, 7], [91, 12, -3], [4242, 3, 3]]) {
    core.handle({ type: 'gen', jobId: 1, cx, cz, seed });
    const msg = out.pop();
    const ref = new Chunk(cx, cz);
    new WorldGen({ seed }).generateChunk(ref);
    if (!sameBytes(msg.blocks, ref.blocks)) same = false;
    if (!sameBytes(msg.climate, ref.climate)) climateSame = false;
    if (msg.empty !== ref.empty) same = false;
  }
  ok('gen job: blocks match the main-thread generator (also across a seed change in one worker)', same);
  ok('gen job: climate tints match', climateSame);
  core.handle({ type: 'gen', jobId: 9, cx: 1, cz: 1, seed: 7 });
  ok('gen job: replies with type "generated" and the job id', out.at(-1).type === 'generated' && out.at(-1).jobId === 9);
}

/* ---- a whole world built by workers equals one built synchronously ---- */
{
  const w = makeWorld({ rd: 3 });
  w.world._primed = true;                            // in play: the main thread leaves generation to the workers
  const s = makeWorld({ rd: 3, withWorkers: false });
  const steps = await settle(w.world, anchorAt(0, 0));
  syncSettle(s.world, anchorAt(0, 0));
  ok('world: the worker-driven world settles', steps < 3000, `${steps} frames`);
  ok('world: same set of chunks loaded', w.world.chunks.size === s.world.chunks.size, `${w.world.chunks.size} vs ${s.world.chunks.size}`);
  let blocksOk = true, lightOk = true, meshOk = true, climOk = true, badMesh = '';
  for (const [key, c] of s.world.chunks) {
    const d = w.world.chunks.get(key);
    if (!d) { blocksOk = false; continue; }
    if (!sameBytes(c.blocks, d.blocks)) blocksOk = false;
    if (!sameBytes(c.light, d.light)) lightOk = false;
    if (!sameBytes(c.climate, d.climate)) climOk = false;
    const a = vcount(s.world, key), b = vcount(w.world, key);
    if (a !== b) { meshOk = false; badMesh = `${c.cx},${c.cz}: ${a} vs ${b}`; }
  }
  ok('world: every chunk\'s blocks are identical', blocksOk);
  ok('world: lighting is identical', lightOk);
  ok('world: climate tints are identical', climOk);
  ok('world: meshes built in workers have identical geometry counts', meshOk, badMesh);
  ok('world: nothing left pending', w.world._genPending.size === 0 && w.world.meshPool.pending === 0);
  const jobs = w.workers.flatMap((x) => x.log);
  ok('world: both kinds of job went to the workers', jobs.some((j) => j.startsWith('gen:')) && jobs.some((j) => j.startsWith('mesh:')));
  ok('world: the main thread generated nothing itself', w.world.meshPool.stats.generated === w.world.chunks.size, `${w.world.meshPool.stats.generated} of ${w.world.chunks.size}`);
}

/* ---- while loading, the main thread generates too ---- */
{
  const w = makeWorld({ rd: 4, workers: 1 });
  let ready = false;
  w.game.events.on('world:ready', () => { ready = true; });
  for (let i = 0; i < 3000 && !ready; i++) { w.world.update(0.016, anchorAt(0, 0)); await tick(); }
  const genJobs = w.workers[0].log.filter((j) => j.startsWith('gen:'));
  ok('loading: the main thread took a share of the generation', genJobs.length < w.world.chunks.size, `${genJobs.length} worker jobs for ${w.world.chunks.size} chunks`);
  ok('loading: ...without any chunk being generated twice', new Set(genJobs).size === genJobs.length);
  // every chunk the workers did generate is also correct
  const ref = new WorldGen({ seed: 4242 });
  let wrong = 0;
  for (const c of w.world.chunks.values()) { const r = new Chunk(c.cx, c.cz); ref.generateChunk(r); if (!sameBytes(r.blocks, c.blocks)) wrong++; }
  ok('loading: the mix of worker and main-thread chunks is all correct', wrong === 0, `${wrong} wrong`);
  // once the world is playable it stops helping
  const before = w.world.chunks.size;
  const stolen = (() => { let n = 0; const o = w.world.ensureChunk.bind(w.world); w.world.ensureChunk = (a, b) => { if (!w.world.chunks.has(chunkKey(a, b))) n++; return o(a, b); }; return () => n; })();
  await settle(w.world, anchorAt(6, 0));
  ok('loading: after the world is ready the main thread leaves generation to the workers', w.world.chunks.size > before && stolen() === 0, `${stolen()} generated on the main thread`);
}

/* ---- the world is ready (loading screen) through workers ---- */
{
  const w = makeWorld({ rd: 4 });
  let ready = false;
  w.game.events.on('world:ready', () => { ready = true; });
  let frames = 0;
  while (!ready && frames < 3000) { w.world.update(0.016, anchorAt(0, 0)); await tick(); frames++; }
  ok('ready: world:ready fires with worker generation', ready, `${frames} frames`);
  ok('ready: ...before the whole view distance has loaded', w.world.chunks.size < 113, `${w.world.chunks.size} chunks`);
}

/* ---- results for a world that no longer exists are discarded ---- */
{
  const w = makeWorld({ rd: 3, seed: 111 });
  w.world.update(0.016, anchorAt(0, 0));            // requests go out
  await tick(); await tick();                        // some are in flight / done
  w.world.reset(222);                                // a new world, mid-flight
  await settle(w.world, anchorAt(0, 0));
  const ref = new WorldGen({ seed: 222 });
  let mismatches = 0, n = 0;
  for (const c of w.world.chunks.values()) {
    const r = new Chunk(c.cx, c.cz);
    ref.generateChunk(r);
    if (!sameBytes(r.blocks, c.blocks)) mismatches++;
    n++;
  }
  ok('reset: nothing from the old seed survives', n > 20 && mismatches === 0, `${mismatches} of ${n} chunks wrong`);
}

/* ---- the world needs a chunk right now, while a worker is on it ---- */
{
  const w = makeWorld({ rd: 3 });
  w.world.update(0.016, anchorAt(0, 0));
  ok('race: chunk is pending a worker', w.world._genPending.has(chunkKey(2, 1)));
  const made = w.world.ensureChunk(2, 1);            // e.g. physics reads a block there
  ok('race: ensureChunk generates it on the spot', w.world.chunks.get(chunkKey(2, 1)) === made && made.generated);
  await settle(w.world, anchorAt(0, 0));
  ok('race: the late worker result does not replace it', w.world.chunks.get(chunkKey(2, 1)) === made);
  ok('race: bookkeeping is clean afterwards', w.world._genPending.size === 0);
  const ref = new Chunk(2, 1);
  new WorldGen({ seed: 4242 }).generateChunk(ref);
  ok('race: and its terrain is right', sameBytes(ref.blocks, made.blocks));
}
{
  // Same, but the worker has already started on the chunk when the world needs it.
  const w = makeWorld({ rd: 3 });
  w.world.update(0.016, anchorAt(0, 0));
  const flying = [...w.world.meshPool.inFlight.values()].filter((j) => j.kind === 'gen');
  ok('race (in flight): workers are already generating', flying.length >= 1, `${flying.length} jobs`);
  const j = flying[0];
  const made = w.world.ensureChunk(j.cx, j.cz);
  made.setLocal(1, 60, 1, 7);                         // the player/physics changes it before the worker answers
  await settle(w.world, anchorAt(0, 0));
  const now = w.world.chunks.get(chunkKey(j.cx, j.cz));
  ok('race (in flight): the arriving result does not replace the live chunk', now === made);
  ok('race (in flight): ...so changes made meanwhile survive', now.getLocal(1, 60, 1) === 7);
  ok('race (in flight): bookkeeping is clean', w.world._genPending.size === 0);
}

/* ---- saved edits are applied to terrain that arrives from a worker ---- */
{
  const w = makeWorld({ rd: 3 });
  const wx = 2 * CHUNK_SX + 5, wz = 1 * CHUNK_SZ + 9, wy = 70;
  w.world._indexEdit(2, 1, 5, wy, 9, 42);            // an edit saved for a chunk not loaded yet
  w.world.edits.set(`${wx},${wy},${wz}`, 42);
  await settle(w.world, anchorAt(0, 0));
  ok('edits: a saved edit shows up in worker-generated terrain', w.world.chunks.get(chunkKey(2, 1)).getLocal(5, wy, 9) === 42);
}

/* ---- the player moves on: queued terrain is dropped, finished terrain out of range too ---- */
{
  const w = makeWorld({ rd: 3, workers: 1 });
  w.world.update(0.016, anchorAt(0, 0));
  ok('move: a long queue builds up behind one worker', w.world.meshPool.genQueue.size > 20, `${w.world.meshPool.genQueue.size}`);
  w.world.update(0.016, anchorAt(30, 0));            // teleport away before anything much has been generated
  await settle(w.world, anchorAt(30, 0));
  let far = 0;
  for (const c of w.world.chunks.values()) if ((c.cx - 30) ** 2 + c.cz ** 2 > (3 + 1 + 2 + 0.5) ** 2) far++;
  ok('move: nothing around the abandoned position was generated', far === 0, `${far} far chunks`);
  ok('move: the new position is loaded and meshed', w.world.chunks.has(chunkKey(30, 0)) && w.world.meshes.has(chunkKey(30, 0)));
  const jobs = w.workers[0].log.filter((j) => j.startsWith('gen:')).length;
  ok('move: the worker did not waste its time on the old plan', jobs < w.world.chunks.size + 12, `${jobs} gen jobs for ${w.world.chunks.size} chunks`);
}

/* ---- nearest first across both kinds of job ---- */
{
  const w = makeWorld({ rd: 4, workers: 1 });
  w.world._primed = true;                            // otherwise the main thread helps with the nearest chunks
  for (let i = 0; i < 400; i++) { w.world.update(0.016, anchorAt(0, 0)); await tick(); if (quiet(w.world)) break; }
  const gens = w.workers[0].log.filter((j) => j.startsWith('gen:')).map((j) => j.slice(4).split(',').map(Number));
  let inversions = 0;
  const d = (g) => g[0] * g[0] + g[1] * g[1];
  // The first jobs go out before the plan is complete, so allow a little slack;
  // what matters is that far chunks do not jump ahead of near ones.
  for (let i = 1; i < gens.length; i++) if (d(gens[i]) + 6 < d(gens[i - 1])) inversions++;
  ok('order: terrain is generated nearest-first', gens.length > 50 && inversions === 0, `${inversions} inversions in ${gens.length}`);
}

/* ---- a generation job that fails is made on the main thread instead ---- */
{
  const w = makeWorld({ rd: 3, workerOpts: { failGen: (cx, cz) => cx === 1 && cz === 0 } });
  const warn = console.warn; console.warn = () => {};
  await settle(w.world, anchorAt(0, 0));
  console.warn = warn;
  const c = w.world.chunks.get(chunkKey(1, 0));
  ok('failure: the failed chunk exists anyway', !!c && c.generated);
  ok('failure: it was meshed too', w.world.meshes.has(chunkKey(1, 0)));
  ok('failure: bookkeeping is clean', w.world._genPending.size === 0);
}

/* ---- the workers die mid-load: the main thread takes over ---- */
{
  const w = makeWorld({ rd: 3 });
  const warn = console.warn; console.warn = () => {};
  w.world.update(0.016, anchorAt(0, 0));
  await tick();
  w.world.meshPool.shutdown();                       // as the onerror handler does
  console.warn = warn;
  ok('shutdown: the pool reports itself disabled', w.world.meshPool.enabled === false);
  syncSettle(w.world, anchorAt(0, 0));
  const s = makeWorld({ rd: 3, withWorkers: false });
  syncSettle(s.world, anchorAt(0, 0));
  ok('shutdown: the full ring still loads and meshes', w.world.chunks.size === s.world.chunks.size && w.world.meshes.size === s.world.meshes.size,
    `${w.world.chunks.size}/${w.world.meshes.size} vs ${s.world.chunks.size}/${s.world.meshes.size}`);
  ok('shutdown: nothing stays pending', w.world._genPending.size === 0 && w.world.meshPool.pending === 0);
}

console.log(`\n==== workers: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
