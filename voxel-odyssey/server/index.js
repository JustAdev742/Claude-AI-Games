/* =========================================================================
   index.js — the Voxel Odyssey multiplayer server.

   Run with:  node server/index.js [--port 8090] [--seed my-world]

   It also serves the game's static files, so one process is enough to host a
   playable session: point a browser at http://host:8090 and it connects back
   to the same origin.

   AUTHORITY MODEL
   ---------------
   The server is authoritative over the two things that actually desync:

     - The world. Block edits are validated (reach, rate, bounds) and applied
       here; clients only ever *predict* them. Two players mining the same
       block resolve identically for everyone because the server decides the
       order, and the loser gets an explicit rejection carrying the true block
       so it can repaint precisely rather than guess.

     - Membership. Who is in the game, their ids and names.

   It is deliberately NOT authoritative over player movement. Doing that
   properly means running the voxel physics and the terrain generator
   server-side; the cost is a second implementation of both that has to stay
   bit-identical to the client's or players get rubber-banded by the server's
   own disagreement. Instead movement is client-owned with a speed sanity
   check here, which is the right trade for a co-op sandbox: the worst a
   cheater achieves is moving oddly, not corrupting the shared world.

   Mobs are simulated by whichever client currently holds authority (the
   longest-connected one) and relayed, for the same reason: the server has no
   world to simulate them in. Authority migrates automatically on disconnect.

   The world itself is never stored as voxels — only the seed plus the edit
   map. Terrain generation is deterministic, so that is enough to reconstruct
   it, and it means a long-running world costs memory proportional to how much
   players changed rather than how far they explored.
   ========================================================================= */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachWebSocketServer } from './websocket.js';
import {
  MSG, PROTOCOL_VERSION, CAUSE, REJECT,
  encodeJson, decodeJson, messageType,
  decodePlayerState, encodeSnapshot,
  decodeBlockEdit, encodeBlockSet, encodeBlockReject,
  encodeWorldEdits, decodeMobSnapshot, encodeMobSnapshot,
} from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---- configuration ------------------------------------------------------ */
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CONFIG = {
  port: parseInt(argValue('port', process.env.PORT || '8090'), 10),
  seed: argValue('seed', 'voxel-odyssey'),
  tickRate: parseInt(argValue('tick', '20'), 10),
  maxPlayers: parseInt(argValue('max-players', '32'), 10),
  // Reach is checked against the player's last reported position. The limit is
  // generous compared to the client's own reach so ordinary latency (the
  // player moved between predicting and the packet landing) never rejects a
  // legitimate edit; it exists to stop edits from across the map.
  maxReach: 12,
  maxEditsPerSecond: 25,
  // A player teleporting further than this between ticks is snapped back.
  // Sized well above sprint-jump speed so terrain quirks don't trigger it.
  maxSpeed: 40,
  // Players further apart than this aren't sent to each other. Roughly the
  // far fog plane, so anyone culled was invisible anyway. Configurable
  // because it is the main dial between bandwidth and draw distance.
  interestRange: parseInt(argValue('interest-range', '160'), 10),
};

/* ---- world state -------------------------------------------------------- */

class ServerWorld {
  constructor(seed) {
    this.seed = seed;
    // voxelKey -> blockId. The complete authoritative diff from worldgen.
    this.edits = new Map();
  }

  key(x, y, z) { return `${x},${y},${z}`; }

  get(x, y, z) {
    const v = this.edits.get(this.key(x, y, z));
    return v === undefined ? null : v;   // null = "unedited, ask worldgen"
  }

  set(x, y, z, id) { this.edits.set(this.key(x, y, z), id); }

  toArray() {
    const out = [];
    for (const [k, id] of this.edits) {
      const [x, y, z] = k.split(',').map(Number);
      out.push({ x, y, z, id });
    }
    return out;
  }
}

/* ---- players ------------------------------------------------------------ */

let nextPlayerId = 1;

class ServerPlayer {
  constructor(conn, name) {
    // Ids are u16 on the wire and recycled only after wrapping, so a client
    // that reconnects quickly never collides with its own stale entries.
    this.id = nextPlayerId++;
    if (nextPlayerId > 65000) nextPlayerId = 1;
    this.conn = conn;
    this.name = name;
    this.x = 0; this.y = 64; this.z = 0;
    this.yaw = 0; this.pitch = 0;
    this.flags = 0;
    this.heldItem = 0;
    this.health = 20;
    this.joinedAt = Date.now();
    this.lastStateAt = 0;
    this.alive = true;

    // Sliding-window rate limiter for edits.
    this._editTimes = [];
    this.latency = 0;
    this._pingSentAt = 0;
  }

  send(data) { try { this.conn.send(data); } catch (_) { /* dropping */ } }

  /* Returns true when this player may make another edit right now. */
  allowEdit(now) {
    const cutoff = now - 1000;
    while (this._editTimes.length && this._editTimes[0] < cutoff) this._editTimes.shift();
    if (this._editTimes.length >= CONFIG.maxEditsPerSecond) return false;
    this._editTimes.push(now);
    return true;
  }

  withinReach(x, y, z) {
    const dx = (x + 0.5) - this.x;
    const dy = (y + 0.5) - this.y;
    const dz = (z + 0.5) - this.z;
    return dx * dx + dy * dy + dz * dz <= CONFIG.maxReach * CONFIG.maxReach;
  }
}

/* ---- the server --------------------------------------------------------- */

class GameServer {
  constructor(config) {
    this.config = config;
    this.world = new ServerWorld(config.seed);
    this.players = new Map();   // id -> ServerPlayer
    this.tick = 0;
    this.mobAuthorityId = null;
    this.mobs = [];
    this._log = [];
  }

  log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    console.log(line);
  }

  /* ---- connection lifecycle ---- */

  onConnection(conn, req) {
    if (this.players.size >= this.config.maxPlayers) {
      conn.send(encodeJson(MSG.KICK, { reason: 'Server full' }));
      conn.close(1013, 'server full');
      return;
    }

    let player = null;

    conn.on('message', (data, isBinary) => {
      try {
        if (!isBinary) {
          // The only text message is the initial HELLO; everything after is
          // binary or a JSON envelope in a binary frame.
          this.handleJsonText(conn, data, (p) => { player = p; });
          return;
        }
        const type = messageType(data);
        if (type === MSG.HELLO) {
          player = this.handleHello(conn, decodeJson(data));
          return;
        }
        if (!player) return;   // nothing is accepted before HELLO
        this.handleBinary(player, type, data);
      } catch (err) {
        this.log('message error:', err.message);
      }
    });

    conn.on('pong', () => {
      if (player && player._pingSentAt) {
        player.latency = Date.now() - player._pingSentAt;
        player._pingSentAt = 0;
      }
    });

    conn.on('close', () => { if (player) this.removePlayer(player); });
    conn.on('error', () => { if (player) this.removePlayer(player); });
  }

  handleJsonText(conn, text, setPlayer) {
    const msg = JSON.parse(text);
    if (msg.type === 'hello') setPlayer(this.handleHello(conn, msg));
  }

  handleHello(conn, msg) {
    if (msg.version !== PROTOCOL_VERSION) {
      conn.send(encodeJson(MSG.KICK, {
        reason: `Protocol mismatch: server speaks v${PROTOCOL_VERSION}, you speak v${msg.version}`,
      }));
      conn.close(1002, 'protocol version');
      return null;
    }

    const name = String(msg.name || 'Player').slice(0, 20).replace(/[^\w \-]/g, '') || 'Player';
    const player = new ServerPlayer(conn, name);
    this.players.set(player.id, player);

    // The joiner needs: who it is, the world seed, everyone already here, and
    // the accumulated edits. Seed + edits fully determine the world.
    player.send(encodeJson(MSG.WELCOME, {
      id: player.id,
      seed: this.world.seed,
      tickRate: this.config.tickRate,
      players: [...this.players.values()]
        .filter((p) => p.id !== player.id)
        .map((p) => ({ id: p.id, name: p.name })),
      isMobAuthority: this.mobAuthorityId === null,
    }));
    player.send(encodeWorldEdits(this.world.toArray()));

    this.broadcast(encodeJson(MSG.PLAYER_JOIN, { id: player.id, name: player.name }), player.id);

    if (this.mobAuthorityId === null) this.mobAuthorityId = player.id;

    this.log(`+ ${player.name} (#${player.id}) joined — ${this.players.size} online`);
    this.broadcastChat(null, `${player.name} joined the game`);
    return player;
  }

  removePlayer(player) {
    if (!this.players.has(player.id)) return;
    this.players.delete(player.id);
    this.broadcast(encodeJson(MSG.PLAYER_LEAVE, { id: player.id }));
    this.log(`- ${player.name} (#${player.id}) left — ${this.players.size} online`);
    this.broadcastChat(null, `${player.name} left the game`);

    // Hand mob simulation to the longest-connected remaining client, so the
    // creatures keep moving rather than freezing when the host disconnects.
    if (this.mobAuthorityId === player.id) {
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.mobAuthorityId = next ? next.id : null;
      if (next) {
        next.send(encodeJson(MSG.WELCOME, {
          id: next.id, seed: this.world.seed, tickRate: this.config.tickRate,
          players: [...this.players.values()].filter((p) => p.id !== next.id).map((p) => ({ id: p.id, name: p.name })),
          isMobAuthority: true, reassigned: true,
        }));
        this.log(`  mob authority -> ${next.name} (#${next.id})`);
      } else {
        this.mobs = [];
      }
    }
  }

  /* ---- binary message handling ---- */

  handleBinary(player, type, data) {
    const view = new DataView(data);
    switch (type) {
      case MSG.PLAYER_STATE: return this.handlePlayerState(player, view);
      case MSG.BLOCK_EDIT: return this.handleBlockEdit(player, view);
      case MSG.CHAT: return this.handleChat(player, decodeJson(data));
      case MSG.MOB_SNAPSHOT: return this.handleMobSnapshot(player, view);
      default: break;
    }
  }

  handlePlayerState(player, view) {
    const s = decodePlayerState(view);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return;

    // Sanity check rather than authority: a player who appears to have moved
    // implausibly far since their last update is snapped back. This catches
    // gross teleport cheats without pretending to simulate their physics.
    const now = Date.now();
    if (player.lastStateAt) {
      const dt = Math.max(0.001, (now - player.lastStateAt) / 1000);
      const dist = Math.hypot(s.x - player.x, s.y - player.y, s.z - player.z);
      if (dist / dt > this.config.maxSpeed) {
        player.send(encodeJson(MSG.KICK, { reason: 'Movement rejected', soft: true, x: player.x, y: player.y, z: player.z }));
        return;
      }
    }

    player.x = s.x; player.y = s.y; player.z = s.z;
    player.yaw = s.yaw; player.pitch = s.pitch;
    player.flags = s.flags;
    player.heldItem = s.heldItem;
    player.health = s.health;
    player.lastStateAt = now;
  }

  handleBlockEdit(player, view) {
    const e = decodeBlockEdit(view);
    const now = Date.now();

    const reject = (reason) => {
      const truth = this.world.get(e.x, e.y, e.z);
      // A rejection must carry the *current* truth. When the voxel has never
      // been edited there is no stored id, and 255 tells the client "revert to
      // whatever worldgen produces here" — which it can recompute exactly,
      // since generation is deterministic from the shared seed.
      player.send(encodeBlockReject(e.seq, e.x, e.y, e.z, truth === null ? 255 : truth, reason));
    };

    if (e.y < 0 || e.y >= 256) return reject(REJECT.BAD_BLOCK);
    if (!player.withinReach(e.x, e.y, e.z)) return reject(REJECT.OUT_OF_REACH);
    if (!player.allowEdit(now)) return reject(REJECT.RATE_LIMIT);

    // Accepted: record it and tell everyone, including the sender. The sender
    // needs the confirmation to clear its pending-prediction entry.
    this.world.set(e.x, e.y, e.z, e.blockId);
    this.broadcast(encodeBlockSet(e.x, e.y, e.z, e.blockId, player.id));
  }

  handleMobSnapshot(player, view) {
    // Only the authority's snapshots are trusted; anyone else's are ignored
    // rather than merged, so a stale or malicious client can't move mobs.
    if (player.id !== this.mobAuthorityId) return;
    this.mobs = decodeMobSnapshot(view);
    const payload = encodeMobSnapshot(this.mobs);
    this.broadcast(payload, player.id);
  }

  handleChat(player, msg) {
    const text = String(msg.text || '').slice(0, 240).trim();
    if (!text) return;
    this.log(`<${player.name}> ${text}`);
    this.broadcastChat(player.name, text);
  }

  broadcastChat(from, text) {
    this.broadcast(encodeJson(MSG.CHAT_BROADCAST, { from, text, at: Date.now() }));
  }

  broadcast(data, exceptId) {
    for (const p of this.players.values()) {
      if (exceptId !== undefined && p.id === exceptId) continue;
      p.send(data);
    }
  }

  /* ---- the tick ---- */

  start() {
    const interval = 1000 / this.config.tickRate;
    this._timer = setInterval(() => this.step(), interval);
    // Periodic ping doubles as a liveness check and a latency measurement.
    this._pingTimer = setInterval(() => {
      for (const p of this.players.values()) {
        p._pingSentAt = Date.now();
        try { p.conn.ping(); } catch (_) { /* dropped on next tick */ }
      }
    }, 2000);
  }

  stop() {
    clearInterval(this._timer);
    clearInterval(this._pingTimer);
  }

  step() {
    this.tick++;
    if (this.players.size === 0) return;

    // Interest management: each client is only sent players near enough to
    // matter. On a 32-player server this turns an O(n^2) broadcast into
    // something proportional to local density, and it keeps a client's
    // bandwidth flat as the player count grows.
    const all = [...this.players.values()];
    const RANGE = this.config.interestRange || 160;
    const RANGE_SQ = RANGE * RANGE;

    for (const target of all) {
      const near = [];
      for (const p of all) {
        if (p.id === target.id) continue;
        const dx = p.x - target.x, dz = p.z - target.z;
        if (dx * dx + dz * dz > RANGE_SQ) continue;
        near.push(p);
      }
      if (near.length === 0) continue;
      target.send(encodeSnapshot(this.tick, near));
    }
  }

  status() {
    return {
      players: this.players.size,
      tick: this.tick,
      edits: this.world.edits.size,
      seed: this.world.seed,
      mobAuthority: this.mobAuthorityId,
      uptime: process.uptime(),
    };
  }
}

/* ---- static file serving ------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve inside ROOT and verify the result is still inside it, so encoded
  // traversal (%2e%2e%2f) can't escape the game directory.
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---- entry point -------------------------------------------------------- */

export function createServer(config = CONFIG) {
  const game = new GameServer(config);

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(game.status(), null, 2));
      return;
    }
    serveStatic(req, res);
  });

  attachWebSocketServer(httpServer, (conn, req) => game.onConnection(conn, req));
  return { httpServer, game };
}

// Only auto-start when run directly, so tests can import and drive the server.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { httpServer, game } = createServer(CONFIG);
  game.start();
  httpServer.listen(CONFIG.port, () => {
    game.log(`Voxel Odyssey server listening on http://localhost:${CONFIG.port}`);
    game.log(`  seed "${CONFIG.seed}"  tick ${CONFIG.tickRate}Hz  max ${CONFIG.maxPlayers} players`);
    game.log('  open that URL in a browser to play; others join the same address');
  });

  const shutdown = () => {
    game.log('shutting down');
    game.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { GameServer, ServerWorld, ServerPlayer, CONFIG };
