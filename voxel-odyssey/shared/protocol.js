/* =========================================================================
   protocol.js — the client/server wire format.

   Imported unchanged by both the browser client and the Node server, so the
   encoder and decoder can never drift apart. Everything is a DataView over an
   ArrayBuffer; no JSON on the hot paths.

   WHY BINARY
   ----------
   Player state is the dominant traffic: every player, every tick, to every
   other player. As JSON a single player update is ~120 bytes of quoted keys
   and stringified floats; packed here it is 22. At 20Hz with 16 players that
   is the difference between ~300 KB/s and ~7 KB/s of broadcast, which decides
   whether a small VPS can host a game at all.

   Control messages that happen rarely (join, chat, kick) stay JSON — the
   readability is worth more there than the bytes.

   QUANTISATION
   ------------
   Angles ship as int16 over their natural range rather than float32: a yaw is
   never needed to more than ~0.005 rad, and halving the field costs nothing
   visually because remote players are interpolated anyway.

   All multi-byte fields are little-endian, matching every platform this runs
   on and letting the browser skip byte swapping.
   ========================================================================= */

export const PROTOCOL_VERSION = 1;

/* Message type ids. Never renumber these — a client and server disagreeing
   about a type id is the one failure mode that produces silent corruption
   rather than a clean error, which is why HELLO carries a version check. */
export const MSG = {
  // client -> server
  HELLO: 1,
  PLAYER_STATE: 2,
  BLOCK_EDIT: 3,
  CHAT: 4,
  PONG: 5,
  INVENTORY_STATE: 6,

  // server -> client
  WELCOME: 20,
  PLAYER_JOIN: 21,
  PLAYER_LEAVE: 22,
  SNAPSHOT: 23,
  BLOCK_SET: 24,
  BLOCK_REJECT: 25,
  CHAT_BROADCAST: 26,
  PING: 27,
  WORLD_EDITS: 28,
  KICK: 29,
  MOB_SNAPSHOT: 30,
};

/* Player movement/animation flags, packed into one byte. */
export const FLAG = {
  ON_GROUND: 1 << 0,
  SPRINTING: 1 << 1,
  SNEAKING: 1 << 2,
  FLYING: 1 << 3,
  IN_WATER: 1 << 4,
  SWINGING: 1 << 5,   // arm swing (mining / attacking) — drives remote animation
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ---- angle quantisation ------------------------------------------------ */
// Yaw covers a full turn; pitch is clamped to +/- pi/2 by the camera anyway.
const YAW_SCALE = 32767 / Math.PI;
const PITCH_SCALE = 32767 / (Math.PI / 2);

const packYaw = (v) => {
  // Wrap into [-pi, pi] before scaling so a player spinning past pi doesn't
  // overflow int16 and snap to the opposite direction.
  let a = v % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return Math.max(-32767, Math.min(32767, Math.round(a * YAW_SCALE)));
};
const unpackYaw = (v) => v / YAW_SCALE;
const packPitch = (v) => Math.max(-32767, Math.min(32767, Math.round(clampPitch(v) * PITCH_SCALE)));
const unpackPitch = (v) => v / PITCH_SCALE;
const clampPitch = (v) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, v));

/* ---- JSON envelope for low-frequency control messages ------------------ */

export function encodeJson(type, obj) {
  const body = textEncoder.encode(JSON.stringify(obj));
  const buf = new ArrayBuffer(1 + body.length);
  new DataView(buf).setUint8(0, type);
  new Uint8Array(buf, 1).set(body);
  return buf;
}

export function decodeJson(buf, offset = 1) {
  const bytes = new Uint8Array(buf, offset);
  return JSON.parse(textDecoder.decode(bytes));
}

/* ---- PLAYER_STATE: client -> server, 20Hz ------------------------------
   Layout (22 bytes):
     u8   type
     f32  x, y, z
     i16  yaw, pitch
     u8   flags
     u8   heldItemId
     u16  health (scaled x100 so half-hearts survive)
     u8   reserved (keeps the record 4-byte aligned for future fields)
*/
export const PLAYER_STATE_SIZE = 22;

export function encodePlayerState(s) {
  const buf = new ArrayBuffer(PLAYER_STATE_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PLAYER_STATE);
  v.setFloat32(1, s.x, true);
  v.setFloat32(5, s.y, true);
  v.setFloat32(9, s.z, true);
  v.setInt16(13, packYaw(s.yaw || 0), true);
  v.setInt16(15, packPitch(s.pitch || 0), true);
  v.setUint8(17, s.flags | 0);
  v.setUint8(18, s.heldItem | 0);
  v.setUint16(19, Math.max(0, Math.min(65535, Math.round((s.health || 0) * 100))), true);
  v.setUint8(21, 0);
  return buf;
}

export function decodePlayerState(v, offset = 1) {
  return {
    x: v.getFloat32(offset, true),
    y: v.getFloat32(offset + 4, true),
    z: v.getFloat32(offset + 8, true),
    yaw: unpackYaw(v.getInt16(offset + 12, true)),
    pitch: unpackPitch(v.getInt16(offset + 14, true)),
    flags: v.getUint8(offset + 16),
    heldItem: v.getUint8(offset + 17),
    health: v.getUint16(offset + 18, true) / 100,
  };
}

/* ---- SNAPSHOT: server -> client, 20Hz ----------------------------------
   All players except the recipient, packed back to back:
     u8   type
     u32  serverTick
     u16  count
     [ u16 playerId, <20 bytes of player state> ] * count
*/
const SNAPSHOT_HEADER = 7;
// Stated outright rather than derived from PLAYER_STATE_SIZE: the two layouts
// are deliberately different (a snapshot entry adds a player id and drops the
// reserved alignment byte), so deriving one from the other silently
// misaligned every entry after the first.
//   u16 id + f32 x,y,z + i16 yaw,pitch + u8 flags + u8 held + u16 health
const SNAPSHOT_ENTRY = 2 + 12 + 4 + 1 + 1 + 2;   // = 22

export function encodeSnapshot(tick, players) {
  const buf = new ArrayBuffer(SNAPSHOT_HEADER + players.length * SNAPSHOT_ENTRY);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, players.length, true);

  let o = SNAPSHOT_HEADER;
  for (const p of players) {
    v.setUint16(o, p.id, true); o += 2;
    v.setFloat32(o, p.x, true); o += 4;
    v.setFloat32(o, p.y, true); o += 4;
    v.setFloat32(o, p.z, true); o += 4;
    v.setInt16(o, packYaw(p.yaw || 0), true); o += 2;
    v.setInt16(o, packPitch(p.pitch || 0), true); o += 2;
    v.setUint8(o, p.flags | 0); o += 1;
    v.setUint8(o, p.heldItem | 0); o += 1;
    v.setUint16(o, Math.max(0, Math.min(65535, Math.round((p.health || 0) * 100))), true); o += 2;
  }
  return buf;
}

export function decodeSnapshot(v) {
  const tick = v.getUint32(1, true);
  const count = v.getUint16(5, true);
  const players = [];
  let o = SNAPSHOT_HEADER;
  for (let i = 0; i < count; i++) {
    players.push({
      id: v.getUint16(o, true),
      x: v.getFloat32(o + 2, true),
      y: v.getFloat32(o + 6, true),
      z: v.getFloat32(o + 10, true),
      yaw: unpackYaw(v.getInt16(o + 14, true)),
      pitch: unpackPitch(v.getInt16(o + 16, true)),
      flags: v.getUint8(o + 18),
      heldItem: v.getUint8(o + 19),
      health: v.getUint16(o + 20, true) / 100,
    });
    o += SNAPSHOT_ENTRY;
  }
  return { tick, players };
}

/* ---- BLOCK_EDIT: client -> server --------------------------------------
   Carries a client sequence number. The server echoes it on rejection so the
   client knows exactly which optimistic edit to roll back — without it a
   client could only resynchronise by refetching state.
     u8  type, u32 seq, i32 x, u16 y, i32 z, u8 blockId, u8 cause
*/
export const BLOCK_EDIT_SIZE = 17;
export const CAUSE = { PLACE: 0, BREAK: 1 };

export function encodeBlockEdit(seq, x, y, z, blockId, cause) {
  const buf = new ArrayBuffer(BLOCK_EDIT_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.BLOCK_EDIT);
  v.setUint32(1, seq >>> 0, true);
  v.setInt32(5, x | 0, true);
  v.setUint16(9, y & 0xffff, true);
  v.setInt32(11, z | 0, true);
  v.setUint8(15, blockId & 0xff);
  v.setUint8(16, cause | 0);
  return buf;
}

export function decodeBlockEdit(v) {
  return {
    seq: v.getUint32(1, true),
    x: v.getInt32(5, true),
    y: v.getUint16(9, true),
    z: v.getInt32(11, true),
    blockId: v.getUint8(15),
    cause: v.getUint8(16),
  };
}

/* ---- BLOCK_SET: server -> client (authoritative) ----------------------
     u8 type, i32 x, u16 y, i32 z, u8 blockId, u16 byPlayerId
*/
export const BLOCK_SET_SIZE = 16;

export function encodeBlockSet(x, y, z, blockId, byPlayerId) {
  const buf = new ArrayBuffer(BLOCK_SET_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.BLOCK_SET);
  v.setInt32(1, x | 0, true);
  v.setUint16(5, y & 0xffff, true);
  v.setInt32(7, z | 0, true);
  v.setUint8(11, blockId & 0xff);
  v.setUint16(12, byPlayerId | 0, true);
  return buf;
}

export function decodeBlockSet(v) {
  return {
    x: v.getInt32(1, true),
    y: v.getUint16(5, true),
    z: v.getInt32(7, true),
    blockId: v.getUint8(11),
    by: v.getUint16(12, true),
  };
}

/* ---- BLOCK_REJECT: server -> client ------------------------------------
   "Your optimistic edit `seq` was refused; the truth at that voxel is
   `blockId`." Both facts are needed: the seq to drop the pending entry, and
   the real id to repaint, since the reason for rejection may be that someone
   else already changed it.
     u8 type, u32 seq, i32 x, u16 y, i32 z, u8 blockId, u8 reason
*/
export const BLOCK_REJECT_SIZE = 17;
export const REJECT = { OUT_OF_REACH: 0, RATE_LIMIT: 1, PROTECTED: 2, STALE: 3, BAD_BLOCK: 4 };

export function encodeBlockReject(seq, x, y, z, blockId, reason) {
  const buf = new ArrayBuffer(BLOCK_REJECT_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.BLOCK_REJECT);
  v.setUint32(1, seq >>> 0, true);
  v.setInt32(5, x | 0, true);
  v.setUint16(9, y & 0xffff, true);
  v.setInt32(11, z | 0, true);
  v.setUint8(15, blockId & 0xff);
  v.setUint8(16, reason | 0);
  return buf;
}

export function decodeBlockReject(v) {
  return {
    seq: v.getUint32(1, true),
    x: v.getInt32(5, true),
    y: v.getUint16(9, true),
    z: v.getInt32(11, true),
    blockId: v.getUint8(15),
    reason: v.getUint8(16),
  };
}

/* ---- WORLD_EDITS: server -> client on join -----------------------------
   The full edit map, so a joiner reconstructs the world as
   (deterministic worldgen from seed) + (everyone's edits so far).
   Sending edits rather than voxels is what keeps joining cheap: a world
   that has been played in for hours is still only its diff.
     u8 type, u32 count, [ i32 x, u16 y, i32 z, u8 id ] * count
*/
export function encodeWorldEdits(edits) {
  const n = edits.length;
  const buf = new ArrayBuffer(5 + n * 11);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WORLD_EDITS);
  v.setUint32(1, n, true);
  let o = 5;
  for (const e of edits) {
    v.setInt32(o, e.x | 0, true); o += 4;
    v.setUint16(o, e.y & 0xffff, true); o += 2;
    v.setInt32(o, e.z | 0, true); o += 4;
    v.setUint8(o, e.id & 0xff); o += 1;
  }
  return buf;
}

export function decodeWorldEdits(v) {
  const n = v.getUint32(1, true);
  const out = [];
  let o = 5;
  for (let i = 0; i < n; i++) {
    out.push({
      x: v.getInt32(o, true),
      y: v.getUint16(o + 4, true),
      z: v.getInt32(o + 6, true),
      id: v.getUint8(o + 10),
    });
    o += 11;
  }
  return out;
}

/* ---- MOB_SNAPSHOT: authority client -> server -> everyone ---------------
   Mobs are simulated by whichever client holds authority (see net/client.js)
   rather than by the server, which has no physics or worldgen. This keeps
   every player seeing the same creatures without a headless simulation.
     u8 type, u16 count, [ u16 id, u8 kind, f32 x,y,z, i16 yaw, u8 flags ] * count
*/
const MOB_ENTRY = 2 + 1 + 12 + 2 + 1;

export function encodeMobSnapshot(mobs) {
  const buf = new ArrayBuffer(3 + mobs.length * MOB_ENTRY);
  const v = new DataView(buf);
  v.setUint8(0, MSG.MOB_SNAPSHOT);
  v.setUint16(1, mobs.length, true);
  let o = 3;
  for (const m of mobs) {
    v.setUint16(o, m.id, true); o += 2;
    v.setUint8(o, m.kind); o += 1;
    v.setFloat32(o, m.x, true); o += 4;
    v.setFloat32(o, m.y, true); o += 4;
    v.setFloat32(o, m.z, true); o += 4;
    v.setInt16(o, packYaw(m.yaw || 0), true); o += 2;
    v.setUint8(o, m.flags | 0); o += 1;
  }
  return buf;
}

export function decodeMobSnapshot(v) {
  const n = v.getUint16(1, true);
  const out = [];
  let o = 3;
  for (let i = 0; i < n; i++) {
    out.push({
      id: v.getUint16(o, true),
      kind: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, true),
      y: v.getFloat32(o + 7, true),
      z: v.getFloat32(o + 11, true),
      yaw: unpackYaw(v.getInt16(o + 15, true)),
      flags: v.getUint8(o + 17),
    });
    o += MOB_ENTRY;
  }
  return out;
}

/* Dispatch helper: every decoder above assumes it is handed the right type,
   so reading the tag is deliberately the caller's first step. */
export function messageType(buf) {
  return new DataView(buf).getUint8(0);
}
