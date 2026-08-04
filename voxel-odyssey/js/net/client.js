/* =========================================================================
   client.js — multiplayer client.

   Three jobs, each with a distinct correctness problem:

   1. BLOCK EDITS — prediction with reconciliation.
      Waiting for a server round trip before a mined block disappears makes
      building feel broken at any real latency. So edits apply locally at
      once and are recorded as *pending*. The server's decision then arrives
      either as a confirmation (drop the pending entry) or a rejection
      carrying the true block id (repaint that voxel and drop it). Because a
      rejection names the voxel and its true state, recovery is exact — no
      refetch, no guesswork, and two players racing for the same block end up
      agreeing.

   2. REMOTE PLAYERS — interpolation.
      Snapshots arrive at the server tick rate (20Hz) over a jittery link.
      Rendering the newest one directly gives visible stutter. Instead
      snapshots go into a buffer and remote players are drawn INTERP_DELAY in
      the past, interpolating between the two straddling snapshots. Trading a
      little latency for smoothness is the right call for other players —
      you're not aiming at them frame-perfectly in a sandbox game.

   3. THE LOCAL PLAYER — never corrected on the happy path.
      Movement is client-owned (see server/index.js for why), so the local
      player is simply simulated normally. The server only intervenes on an
      implausible jump, which arrives as a soft correction.

   The client is inert until connect() is called: single-player is the exact
   same code path with no socket attached.
   ========================================================================= */

import {
  MSG, PROTOCOL_VERSION, FLAG, REJECT,
  encodeJson, decodeJson, messageType,
  encodePlayerState, decodeSnapshot,
  encodeBlockEdit, decodeBlockSet, decodeBlockReject,
  decodeWorldEdits, encodeMobSnapshot, decodeMobSnapshot,
} from '../../shared/protocol.js';

/* How far in the past remote players are rendered. Must exceed the server
   tick interval (50ms at 20Hz) or the buffer runs dry between snapshots and
   playback stalls; 100ms gives a full tick of slack for jitter. */
const INTERP_DELAY = 0.1;

/* Snapshots older than this are dropped from the buffer. */
const BUFFER_KEEP = 1.0;

const STATE_SEND_HZ = 20;
const MOB_SEND_HZ = 10;

export class NetClient {
  constructor(game) {
    this.game = game;
    this.socket = null;
    this.connected = false;
    this.playerId = 0;
    this.serverSeed = null;

    this.players = new Map();     // id -> { id, name, buffer:[], render:{...} }
    this.isMobAuthority = false;
    this.remoteMobs = new Map();

    // Edits we've applied locally but the server hasn't confirmed.
    // seq -> { x, y, z, previous, applied }
    this.pending = new Map();
    this._seq = 1;

    this._stateAccum = 0;
    this._mobAccum = 0;
    this._clock = 0;
    this.latency = 0;
    this.status = 'offline';
    this.chatLog = [];
  }

  get isMultiplayer() { return this.connected; }

  /* ---- connection ---- */

  connect(url, name) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) { reject(err); return; }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.status = 'connecting';

      const failEarly = (err) => {
        this.status = 'offline';
        this.socket = null;
        reject(err instanceof Error ? err : new Error('Could not reach server'));
      };

      socket.onopen = () => {
        socket.send(encodeJson(MSG.HELLO, { version: PROTOCOL_VERSION, name: name || 'Player' }));
      };
      socket.onerror = () => { if (!this.connected) failEarly(new Error(`Could not connect to ${url}`)); };
      socket.onclose = (e) => {
        if (!this.connected) { failEarly(new Error(e.reason || 'Connection refused')); return; }
        this._onDisconnect(e.reason);
      };
      socket.onmessage = (ev) => {
        try {
          const handled = this._onMessage(ev.data);
          // WELCOME resolves the promise: only then is the session usable.
          if (handled === MSG.WELCOME) { this.connected = true; this.status = 'connected'; resolve(this); }
        } catch (err) {
          console.error('net: bad message', err);
        }
      };
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.close(1000, 'client quit'); } catch (_) { /* already closing */ }
    }
    this._onDisconnect('You disconnected');
  }

  _onDisconnect(reason) {
    const wasConnected = this.connected;
    this.connected = false;
    this.status = 'offline';
    this.socket = null;
    this.players.clear();
    this.pending.clear();
    this.remoteMobs.clear();
    if (wasConnected && this.game.events) {
      this.game.events.emit('net:disconnected', { reason });
    }
  }

  /* ---- inbound ---- */

  _onMessage(data) {
    if (typeof data === 'string') return null;
    const type = messageType(data);
    const view = new DataView(data);
    const events = this.game.events;

    switch (type) {
      case MSG.WELCOME: {
        const msg = decodeJson(data);
        this.playerId = msg.id;
        this.serverSeed = msg.seed;
        this.isMobAuthority = !!msg.isMobAuthority;
        for (const p of msg.players || []) this._addPlayer(p.id, p.name);
        if (events) events.emit('net:welcome', msg);
        return MSG.WELCOME;
      }

      case MSG.PLAYER_JOIN: {
        const msg = decodeJson(data);
        this._addPlayer(msg.id, msg.name);
        if (events) events.emit('net:join', msg);
        return type;
      }

      case MSG.PLAYER_LEAVE: {
        const msg = decodeJson(data);
        this._removePlayer(msg.id);
        if (events) events.emit('net:leave', msg);
        return type;
      }

      case MSG.SNAPSHOT: {
        const snap = decodeSnapshot(view);
        const now = this._clock;
        for (const s of snap.players) {
          const p = this.players.get(s.id) || this._addPlayer(s.id, `Player ${s.id}`);
          p.buffer.push({ t: now, ...s });
          // Trim ancient entries so the buffer can't grow without bound on a
          // long session.
          while (p.buffer.length > 2 && p.buffer[0].t < now - BUFFER_KEEP) p.buffer.shift();
        }
        return type;
      }

      case MSG.BLOCK_SET: {
        const b = decodeBlockSet(view);
        this._applyAuthoritativeBlock(b);
        return type;
      }

      case MSG.BLOCK_REJECT: {
        const r = decodeBlockReject(view);
        this._rollback(r);
        return type;
      }

      case MSG.WORLD_EDITS: {
        const edits = decodeWorldEdits(view);
        this._applyWorldEdits(edits);
        if (events) events.emit('net:world-edits', { count: edits.length });
        return type;
      }

      case MSG.MOB_SNAPSHOT: {
        // Only meaningful when someone else holds authority.
        if (!this.isMobAuthority) {
          const mobs = decodeMobSnapshot(view);
          this.remoteMobs.clear();
          for (const m of mobs) this.remoteMobs.set(m.id, m);
        }
        return type;
      }

      case MSG.CHAT_BROADCAST: {
        const msg = decodeJson(data);
        this.chatLog.push(msg);
        if (this.chatLog.length > 100) this.chatLog.shift();
        if (events) events.emit('net:chat', msg);
        return type;
      }

      case MSG.KICK: {
        const msg = decodeJson(data);
        if (msg.soft) {
          // A movement correction, not an eviction: accept the server's
          // position rather than argue with it.
          if (this.game.player && Number.isFinite(msg.x)) {
            this.game.player.position.set(msg.x, msg.y, msg.z);
            this.game.player.velocity.set(0, 0, 0);
          }
        } else {
          if (events) events.emit('net:kicked', msg);
          this.disconnect();
        }
        return type;
      }

      default:
        return type;
    }
  }

  _addPlayer(id, name) {
    let p = this.players.get(id);
    if (p) return p;
    p = {
      id,
      name,
      buffer: [],
      // Rendered (interpolated) state, consumed by the remote-player renderer.
      render: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, heldItem: 0, health: 20, valid: false },
    };
    this.players.set(id, p);
    return p;
  }

  _removePlayer(id) {
    this.players.delete(id);
    if (this.game.events) this.game.events.emit('net:player-removed', { id });
  }

  /* ---- world reconciliation ---- */

  // A confirmed edit from the server. If it matches something we predicted,
  // the prediction was right and we just retire it.
  _applyAuthoritativeBlock(b) {
    for (const [seq, p] of this.pending) {
      if (p.x === b.x && p.y === b.y && p.z === b.z) { this.pending.delete(seq); break; }
    }
    // Our own confirmed edits are already applied locally; skip the redundant
    // setBlock so we don't re-run lighting and meshing for no change.
    if (b.by === this.playerId) return;
    this._setBlockQuiet(b.x, b.y, b.z, b.blockId);
  }

  _rollback(r) {
    const p = this.pending.get(r.seq);
    this.pending.delete(r.seq);

    // 255 means "no stored edit — revert to what worldgen produces here",
    // which we can recompute exactly because the seed is shared.
    const truth = r.blockId === 255 ? this._worldgenBlock(r.x, r.y, r.z) : r.blockId;
    this._setBlockQuiet(r.x, r.y, r.z, truth);

    const reason = ['too far away', 'editing too fast', 'protected area', 'out of date', 'invalid block'][r.reason] || 'rejected';
    if (this.game.toast) this.game.toast(`Block edit ${reason}`, 'warn');
    if (this.game.events) this.game.events.emit('net:rollback', { ...r, predicted: p });
  }

  _worldgenBlock(x, y, z) {
    const wg = this.game.worldgen;
    if (wg && typeof wg.blockAt === 'function') {
      try { return wg.blockAt(x, y, z); } catch (_) { /* fall through */ }
    }
    return 0; // AIR: the safest fallback — an incorrect solid block would trap a player
  }

  _applyWorldEdits(edits) {
    const world = this.game.world;
    if (!world) return;
    for (const e of edits) this._setBlockQuiet(e.x, e.y, e.z, e.id);
  }

  // Apply a block without re-broadcasting it (that would echo forever).
  _setBlockQuiet(x, y, z, id) {
    const world = this.game.world;
    if (!world) return;
    this._suppress = true;
    try { world.setBlock(x, y, z, id, { cause: 'network' }); }
    finally { this._suppress = false; }
  }

  /* ---- outbound ---- */

  /**
   * Called by the player before applying a block edit locally.
   * Returns true if the edit should proceed optimistically.
   */
  sendBlockEdit(x, y, z, blockId, previous, cause) {
    if (!this.connected || this._suppress) return true;
    const seq = this._seq++;
    this.pending.set(seq, { x, y, z, previous, blockId, at: this._clock });
    this._send(encodeBlockEdit(seq, x, y, z, blockId, cause));
    return true;
  }

  sendChat(text) {
    if (!this.connected) return;
    this._send(encodeJson(MSG.CHAT, { text }));
  }

  _send(buf) {
    if (!this.socket || this.socket.readyState !== 1) return;
    try { this.socket.send(buf); } catch (_) { /* socket closing */ }
  }

  /* ---- per-frame ---- */

  update(dt) {
    this._clock += dt;
    if (!this.connected) return;

    // Publish our own state at a fixed rate, decoupled from frame rate: a
    // 144Hz client must not send seven times more than a 20Hz one.
    this._stateAccum += dt;
    const stateInterval = 1 / STATE_SEND_HZ;
    if (this._stateAccum >= stateInterval) {
      this._stateAccum %= stateInterval;
      this._sendLocalState();
    }

    if (this.isMobAuthority) {
      this._mobAccum += dt;
      const mobInterval = 1 / MOB_SEND_HZ;
      if (this._mobAccum >= mobInterval) {
        this._mobAccum %= mobInterval;
        this._sendMobs();
      }
    }

    this._interpolateRemotes();
  }

  _sendLocalState() {
    const pl = this.game.player;
    if (!pl) return;
    let flags = 0;
    if (pl.onGround) flags |= FLAG.ON_GROUND;
    if (pl.sprinting) flags |= FLAG.SPRINTING;
    if (pl.sneaking) flags |= FLAG.SNEAKING;
    if (pl.flying) flags |= FLAG.FLYING;
    if (pl.inWater) flags |= FLAG.IN_WATER;
    if (pl.swinging || pl.mining) flags |= FLAG.SWINGING;

    const held = this.game.inventory && this.game.inventory.selectedItem
      ? (this.game.inventory.selectedItem().blockId || 0) : 0;

    this._send(encodePlayerState({
      x: pl.position.x, y: pl.position.y, z: pl.position.z,
      yaw: pl.yaw, pitch: pl.pitch,
      flags, heldItem: held, health: pl.health,
    }));
  }

  _sendMobs() {
    const em = this.game.entities;
    if (!em || !em.entities) return;
    const mobs = em.entities.slice(0, 200).map((m, i) => ({
      id: m.netId !== undefined ? m.netId : (m.netId = i + 1),
      kind: m.typeIndex || 0,
      x: m.position.x, y: m.position.y, z: m.position.z,
      yaw: m.yaw || 0,
      flags: m.onGround ? FLAG.ON_GROUND : 0,
    }));
    this._send(encodeMobSnapshot(mobs));
  }

  /* Advance every remote player to its interpolated position. */
  _interpolateRemotes() {
    const renderTime = this._clock - INTERP_DELAY;

    for (const p of this.players.values()) {
      const buf = p.buffer;
      if (buf.length === 0) continue;

      // Find the two snapshots straddling renderTime.
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= renderTime) { a = buf[i]; b = buf[i + 1] || null; break; }
      }

      if (!a) {
        // Every snapshot is newer than renderTime — we've just met this
        // player. Snap to the oldest rather than leaving them at the origin.
        a = buf[0];
        b = null;
      }

      const r = p.render;
      if (!b) {
        // Nothing to interpolate toward: hold the last known state. We
        // deliberately do NOT extrapolate — guessing forward makes players
        // skate through walls on a hiccup, and a brief freeze reads better.
        r.x = a.x; r.y = a.y; r.z = a.z;
        r.yaw = a.yaw; r.pitch = a.pitch;
      } else {
        const span = b.t - a.t;
        const f = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.t) / span)) : 0;
        r.x = a.x + (b.x - a.x) * f;
        r.y = a.y + (b.y - a.y) * f;
        r.z = a.z + (b.z - a.z) * f;
        r.yaw = lerpAngle(a.yaw, b.yaw, f);
        r.pitch = a.pitch + (b.pitch - a.pitch) * f;
      }
      r.flags = a.flags;
      r.heldItem = a.heldItem;
      r.health = a.health;
      r.valid = true;

      // Horizontal speed drives the remote walk cycle.
      r.speed = Math.hypot(r.x - (r._px ?? r.x), r.z - (r._pz ?? r.z));
      r._px = r.x; r._pz = r.z;
    }
  }

  /* Names for the player list UI. */
  roster() {
    const out = [{ id: this.playerId, name: 'You', self: true }];
    for (const p of this.players.values()) out.push({ id: p.id, name: p.name, self: false });
    return out;
  }
}

/* Shortest-path angular interpolation: without the wrap, a player turning
   past pi spins the long way round. */
function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

export default NetClient;
