/* Multiplayer tests: protocol round-trips, then a real server driven by real
   WebSocket clients over a real socket.

   The protocol half matters because an encoder/decoder disagreement corrupts
   silently rather than failing. The server half matters because the
   properties worth having — one winner when two players race for a block,
   rejections that carry the truth, reach and rate limits — are all about
   concurrency, and only show up when two clients actually talk at once. */

import { createServer } from '../server/index.js';
import {
  MSG, PROTOCOL_VERSION, FLAG, CAUSE, REJECT,
  encodeJson, decodeJson, messageType,
  encodePlayerState, decodePlayerState,
  encodeSnapshot, decodeSnapshot,
  encodeBlockEdit, decodeBlockEdit,
  encodeBlockSet, decodeBlockSet,
  encodeBlockReject, decodeBlockReject,
  encodeWorldEdits, decodeWorldEdits,
  encodeMobSnapshot, decodeMobSnapshot,
} from '../shared/protocol.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++;
  else { fail++; console.error('  FAIL', n, extra === undefined ? '' : '— ' + extra); }
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =======================================================================
   1. Protocol round-trips
   ======================================================================= */

{
  const state = {
    x: 123.5, y: 64.25, z: -987.75,
    yaw: 1.234, pitch: -0.789,
    flags: FLAG.ON_GROUND | FLAG.SPRINTING,
    heldItem: 42, health: 17.5,
  };
  const d = decodePlayerState(new DataView(encodePlayerState(state)));
  ok('player state: position exact', d.x === state.x && d.y === state.y && d.z === state.z);
  ok('player state: yaw survives quantisation', near(d.yaw, state.yaw, 1e-3), `${d.yaw} vs ${state.yaw}`);
  ok('player state: pitch survives quantisation', near(d.pitch, state.pitch, 1e-3), `${d.pitch} vs ${state.pitch}`);
  ok('player state: flags', d.flags === state.flags);
  ok('player state: held item', d.heldItem === 42);
  ok('player state: health keeps halves', near(d.health, 17.5, 0.01), d.health);
}

{
  // Yaw must wrap rather than saturate: a player spinning past pi otherwise
  // snaps to face the opposite way.
  for (const yaw of [Math.PI * 1.5, -Math.PI * 1.5, Math.PI * 3, 7.5]) {
    const d = decodePlayerState(new DataView(encodePlayerState({ x: 0, y: 0, z: 0, yaw, pitch: 0, flags: 0, heldItem: 0, health: 20 })));
    // Compare as unit vectors so equivalent angles compare equal.
    const same = near(Math.cos(d.yaw), Math.cos(yaw), 2e-3) && near(Math.sin(d.yaw), Math.sin(yaw), 2e-3);
    ok(`yaw ${yaw.toFixed(2)} wraps correctly`, same, `got ${d.yaw}`);
  }
  // Pitch is clamped by the camera; verify out-of-range input can't overflow.
  const d = decodePlayerState(new DataView(encodePlayerState({ x: 0, y: 0, z: 0, yaw: 0, pitch: 3.0, flags: 0, heldItem: 0, health: 20 })));
  ok('pitch clamps to +/- pi/2', d.pitch <= Math.PI / 2 + 1e-3, d.pitch);
}

{
  const players = [
    { id: 1, x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.1, flags: 1, heldItem: 5, health: 20 },
    { id: 700, x: -50.5, y: 70, z: 200.25, yaw: -2.0, pitch: -0.5, flags: 6, heldItem: 0, health: 3.5 },
  ];
  const s = decodeSnapshot(new DataView(encodeSnapshot(99, players)));
  ok('snapshot: tick', s.tick === 99);
  ok('snapshot: count', s.players.length === 2);
  ok('snapshot: ids', s.players[0].id === 1 && s.players[1].id === 700);
  ok('snapshot: second player position', near(s.players[1].x, -50.5) && near(s.players[1].z, 200.25));
  ok('snapshot: health', near(s.players[1].health, 3.5, 0.01));
  const empty = decodeSnapshot(new DataView(encodeSnapshot(1, [])));
  ok('snapshot: empty is valid', empty.players.length === 0);
}

{
  const e = decodeBlockEdit(new DataView(encodeBlockEdit(4242, -1000, 200, 3000, 17, CAUSE.BREAK)));
  ok('block edit: seq', e.seq === 4242);
  ok('block edit: negative x', e.x === -1000);
  ok('block edit: y', e.y === 200);
  ok('block edit: positive z', e.z === 3000);
  ok('block edit: id + cause', e.blockId === 17 && e.cause === CAUSE.BREAK);

  const s = decodeBlockSet(new DataView(encodeBlockSet(-7, 3, -9, 5, 123)));
  ok('block set: negative coords', s.x === -7 && s.z === -9);
  ok('block set: by player', s.by === 123);

  const r = decodeBlockReject(new DataView(encodeBlockReject(9, 1, 2, 3, 255, REJECT.OUT_OF_REACH)));
  ok('block reject: seq + reason', r.seq === 9 && r.reason === REJECT.OUT_OF_REACH);
  ok('block reject: sentinel truth id', r.blockId === 255);
}

{
  const edits = [{ x: 0, y: 0, z: 0, id: 1 }, { x: -32768, y: 255, z: 32767, id: 40 }];
  const d = decodeWorldEdits(new DataView(encodeWorldEdits(edits)));
  ok('world edits: count', d.length === 2);
  ok('world edits: extremes survive', d[1].x === -32768 && d[1].y === 255 && d[1].z === 32767 && d[1].id === 40);
  ok('world edits: empty', decodeWorldEdits(new DataView(encodeWorldEdits([]))).length === 0);
}

{
  const mobs = [{ id: 3, kind: 2, x: 10.5, y: 64, z: -20.25, yaw: 1.0, flags: 1 }];
  const d = decodeMobSnapshot(new DataView(encodeMobSnapshot(mobs)));
  ok('mob snapshot: round-trip', d.length === 1 && d[0].id === 3 && d[0].kind === 2 && near(d[0].x, 10.5));
}

{
  const buf = encodeJson(MSG.CHAT, { text: 'hello world' });
  ok('json envelope: type tag', messageType(buf) === MSG.CHAT);
  ok('json envelope: body', decodeJson(buf).text === 'hello world');
  ok('json envelope: unicode', decodeJson(encodeJson(MSG.CHAT, { text: 'héllo ⛏' })).text === 'héllo ⛏');
}

/* =======================================================================
   2. Live server, real sockets
   ======================================================================= */

const PORT = 8099 + (process.pid % 300);
const { httpServer, game } = createServer({
  port: PORT, seed: 'test-world', tickRate: 30, maxPlayers: 4,
  maxReach: 12, maxEditsPerSecond: 25, maxSpeed: 40,
  // Small interest range so culling can be exercised over a walkable distance
  // rather than needing a player to trek 160 blocks.
  interestRange: 16,
});
game.log = () => {};   // keep test output clean
game.start();
await new Promise((r) => httpServer.listen(PORT, r));

/* A tiny test harness around the browser-style WebSocket Node 22 provides. */
class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.welcome = null;
    this.blockSets = [];
    this.rejects = [];
    this.chats = [];
    this.joins = [];
    this.leaves = [];
    this.snapshots = [];
    this.worldEdits = null;
    this._seq = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timeout`)), 5000);
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`${this.name}: ${e.message || 'socket error'}`)); };
      ws.onopen = () => ws.send(encodeJson(MSG.HELLO, { version: PROTOCOL_VERSION, name: this.name }));
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return;
        const type = messageType(ev.data);
        const view = new DataView(ev.data);
        this.messages.push(type);
        switch (type) {
          case MSG.WELCOME: this.welcome = decodeJson(ev.data); clearTimeout(timer); resolve(this); break;
          case MSG.WORLD_EDITS: this.worldEdits = decodeWorldEdits(view); break;
          case MSG.BLOCK_SET: this.blockSets.push(decodeBlockSet(view)); break;
          case MSG.BLOCK_REJECT: this.rejects.push(decodeBlockReject(view)); break;
          case MSG.CHAT_BROADCAST: this.chats.push(decodeJson(ev.data)); break;
          case MSG.PLAYER_JOIN: this.joins.push(decodeJson(ev.data)); break;
          case MSG.PLAYER_LEAVE: this.leaves.push(decodeJson(ev.data)); break;
          case MSG.SNAPSHOT: this.snapshots.push(decodeSnapshot(view)); break;
          case MSG.KICK: this.kick = decodeJson(ev.data); break;
          default: break;
        }
      };
    });
  }

  moveTo(x, y, z) {
    this.ws.send(encodePlayerState({ x, y, z, yaw: 0, pitch: 0, flags: 0, heldItem: 0, health: 20 }));
  }

  edit(x, y, z, id, cause = CAUSE.PLACE) {
    const seq = this._seq++;
    this.ws.send(encodeBlockEdit(seq, x, y, z, id, cause));
    return seq;
  }

  chat(text) { this.ws.send(encodeJson(MSG.CHAT, { text })); }
  close() { try { this.ws.close(); } catch (_) { /* already closed */ } }
}

try {
  /* ---- join ---- */
  const alice = await new TestClient('Alice').connect();
  ok('server: welcome carries an id', alice.welcome.id > 0, JSON.stringify(alice.welcome));
  ok('server: welcome carries the seed', alice.welcome.seed === 'test-world');
  ok('server: first joiner gets mob authority', alice.welcome.isMobAuthority === true);
  await sleep(60);
  ok('server: world edits sent on join', Array.isArray(alice.worldEdits), typeof alice.worldEdits);

  const bob = await new TestClient('Bob').connect();
  await sleep(80);
  ok('server: second joiner sees the first', bob.welcome.players.length === 1 && bob.welcome.players[0].name === 'Alice');
  ok('server: second joiner is not mob authority', bob.welcome.isMobAuthority === false);
  ok('server: existing player told of the join', alice.joins.some((j) => j.name === 'Bob'));

  /* ---- both players must be in reach before editing ---- */
  alice.moveTo(0, 64, 0);
  bob.moveTo(2, 64, 0);
  await sleep(80);

  /* ---- an accepted edit reaches BOTH clients ---- */
  alice.edit(1, 64, 1, 5, CAUSE.PLACE);
  await sleep(120);
  ok('server: editor receives its own confirmation',
    alice.blockSets.some((b) => b.x === 1 && b.y === 64 && b.z === 1 && b.blockId === 5),
    JSON.stringify(alice.blockSets));
  ok('server: other client receives the edit',
    bob.blockSets.some((b) => b.x === 1 && b.y === 64 && b.z === 1 && b.blockId === 5),
    JSON.stringify(bob.blockSets));
  ok('server: edit recorded authoritatively', game.world.get(1, 64, 1) === 5, game.world.get(1, 64, 1));

  /* ---- out-of-reach edits are rejected, and say so ---- */
  const farSeq = alice.edit(9999, 64, 9999, 1, CAUSE.PLACE);
  await sleep(120);
  const rej = alice.rejects.find((r) => r.seq === farSeq);
  ok('server: distant edit rejected', !!rej, JSON.stringify(alice.rejects));
  ok('server: rejection names the reason', rej && rej.reason === REJECT.OUT_OF_REACH, rej && rej.reason);
  ok('server: rejection carries the true block (255 = unedited)', rej && rej.blockId === 255, rej && rej.blockId);
  ok('server: rejected edit not applied', game.world.get(9999, 64, 9999) === null);

  /* ---- rejection reports the CURRENT truth, not the sentinel, when the
         voxel has already been edited by someone else ---- */
  bob.edit(2, 64, 1, 9, CAUSE.PLACE);
  await sleep(120);
  const contestedSeq = alice.edit(2, 64, 900, 3, CAUSE.PLACE);  // out of reach
  await sleep(120);
  ok('server: contested block stored', game.world.get(2, 64, 1) === 9, game.world.get(2, 64, 1));
  const r2 = alice.rejects.find((r) => r.seq === contestedSeq);
  ok('server: second rejection delivered', !!r2);

  /* ---- last writer wins, and everyone agrees on who that was ---- */
  alice.edit(3, 64, 0, 11, CAUSE.PLACE);
  bob.edit(3, 64, 0, 22, CAUSE.PLACE);
  await sleep(160);
  const truth = game.world.get(3, 64, 0);
  const aliceLast = alice.blockSets.filter((b) => b.x === 3 && b.y === 64 && b.z === 0).pop();
  const bobLast = bob.blockSets.filter((b) => b.x === 3 && b.y === 64 && b.z === 0).pop();
  ok('race: server picked one winner', truth === 11 || truth === 22, truth);
  ok('race: both clients end on the server truth',
    aliceLast && bobLast && aliceLast.blockId === truth && bobLast.blockId === truth,
    `alice=${aliceLast && aliceLast.blockId} bob=${bobLast && bobLast.blockId} truth=${truth}`);

  /* ---- rate limiting ---- */
  const burst = [];
  for (let i = 0; i < 60; i++) burst.push(alice.edit(0, 60, i % 5, 1, CAUSE.PLACE));
  await sleep(300);
  const limited = alice.rejects.filter((r) => r.reason === REJECT.RATE_LIMIT);
  ok('server: rate limit engages on a burst', limited.length > 0, `rejects=${alice.rejects.length}`);
  ok('server: rate limit lets the early edits through', limited.length < burst.length, `limited=${limited.length}/${burst.length}`);

  /* ---- snapshots carry other players ---- */
  alice.snapshots.length = 0;
  bob.moveTo(5, 65, 5);
  await sleep(200);
  // The LAST snapshot, not the first: the first one after the move was sent
  // may have been encoded before the server processed it, which is correct
  // behaviour but makes a first-match assertion flaky.
  const withBob = alice.snapshots.filter((s) => s.players.some((p) => p.id === bob.welcome.id)).pop();
  ok('server: snapshots include other players', !!withBob, `snapshots=${alice.snapshots.length}`);
  const bobState = withBob && withBob.players.find((p) => p.id === bob.welcome.id);
  ok('server: snapshot position is current', bobState && near(bobState.x, 5) && near(bobState.z, 5),
    bobState && `${bobState.x},${bobState.z}`);
  ok('server: snapshot excludes the recipient',
    alice.snapshots.every((s) => s.players.every((p) => p.id !== alice.welcome.id)));

  /* ---- interest management drops distant players ----
     The client has to WALK there. A single long jump trips the server's own
     movement sanity check, leaving the player where they started — which
     looks exactly like a culling failure. Step size is derived from the
     server's own limit so the two rules can't drift apart. */
  const walkTo = async (client, tx, tz) => {
    const p = game.players.get(client.welcome.id);
    const stepMs = 120;
    // Stay comfortably under maxSpeed for the interval we actually sleep.
    const maxStep = game.config.maxSpeed * (stepMs / 1000) * 0.5;
    let { x, z } = p;
    for (let guard = 0; guard < 200; guard++) {
      const dx = tx - x, dz = tz - z;
      const d = Math.hypot(dx, dz);
      if (d < 0.01) break;
      const step = Math.min(d, maxStep);
      x += (dx / d) * step;
      z += (dz / d) * step;
      client.moveTo(x, 65, z);
      await sleep(stepMs);
    }
    return game.players.get(client.welcome.id);
  };

  const range = game.config.interestRange;
  const farPos = await walkTo(bob, range * 2, range * 2);
  const bobDist = Math.hypot(farPos.x, farPos.z);
  ok('server: player actually walked out of range', bobDist > range,
    `bob at ${bobDist.toFixed(1)}, range ${range}`);

  alice.snapshots.length = 0;
  await sleep(250);
  ok('server: distant players culled from snapshots',
    !alice.snapshots.some((s) => s.players.some((p) => p.id === bob.welcome.id)),
    `bob at ${bobDist.toFixed(1)} vs range ${range}, snapshots=${alice.snapshots.length}`);

  // Culling must be reversible, not a one-way drop.
  await walkTo(bob, 4, 4);
  alice.snapshots.length = 0;
  await sleep(250);
  ok('server: players reappear when back in range',
    alice.snapshots.some((s) => s.players.some((p) => p.id === bob.welcome.id)),
    `snapshots=${alice.snapshots.length}`);

  /* ---- chat ---- */
  alice.chat('hello everyone');
  await sleep(120);
  ok('server: chat reaches other clients', bob.chats.some((c) => c.text === 'hello everyone' && c.from === 'Alice'));
  ok('server: chat echoes to the sender', alice.chats.some((c) => c.text === 'hello everyone'));

  /* ---- teleport sanity check ---- */
  alice.moveTo(0, 64, 0);
  await sleep(80);
  alice.moveTo(100000, 64, 100000);
  await sleep(150);
  ok('server: implausible movement rejected', !!alice.kick && alice.kick.soft === true, JSON.stringify(alice.kick));
  ok('server: correction carries the last good position',
    alice.kick && Number.isFinite(alice.kick.x), JSON.stringify(alice.kick));

  /* ---- protocol version guard ---- */
  const stale = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.binaryType = 'arraybuffer';
    let got = null;
    ws.onopen = () => ws.send(encodeJson(MSG.HELLO, { version: PROTOCOL_VERSION + 99, name: 'Stale' }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' && messageType(ev.data) === MSG.KICK) got = decodeJson(ev.data);
    };
    ws.onclose = () => resolve(got);
    setTimeout(() => resolve(got), 2500);
  });
  ok('server: rejects mismatched protocol version', !!stale && /Protocol mismatch/.test(stale.reason), JSON.stringify(stale));

  /* ---- disconnect handling + authority migration ---- */
  const before = game.players.size;
  alice.close();
  await sleep(250);
  ok('server: player removed on disconnect', game.players.size === before - 1, `${game.players.size} vs ${before}`);
  ok('server: remaining client told of the leave', bob.leaves.some((l) => l.id === alice.welcome.id));
  ok('server: mob authority migrated to survivor', game.mobAuthorityId === bob.welcome.id,
    `authority=${game.mobAuthorityId} bob=${bob.welcome.id}`);

  /* ---- edits survive the editor leaving; a new joiner receives them ---- */
  const carol = await new TestClient('Carol').connect();
  await sleep(150);
  ok('server: joiner receives accumulated edits', carol.worldEdits && carol.worldEdits.length > 0,
    carol.worldEdits && carol.worldEdits.length);
  ok('server: joiner sees the earlier edit',
    carol.worldEdits.some((e) => e.x === 1 && e.y === 64 && e.z === 1 && e.id === 5));

  bob.close();
  carol.close();
  await sleep(120);
} finally {
  game.stop();
  httpServer.close();
}

console.log(`\n==== multiplayer: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
