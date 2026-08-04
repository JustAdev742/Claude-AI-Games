/* =========================================================================
   websocket.js — a minimal RFC 6455 server over Node's http module.

   Node ships no WebSocket *server*, and the game otherwise has zero runtime
   dependencies — a property worth keeping, since it means `node server` works
   on a fresh machine with no install step and nothing to audit. The subset
   RFC 6455 needs for this use is small: the opening handshake (a SHA-1 of the
   client key against a fixed GUID), frame parsing with the client->server
   mask, fragmentation reassembly, and close/ping/pong control frames.

   Deliberately NOT implemented: permessage-deflate (our payloads are already
   packed binary and would not compress meaningfully), and extensions
   generally. Both are optional and negotiated, so browsers fall back cleanly.
   ========================================================================= */

import crypto from 'crypto';
import { EventEmitter } from 'events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/* Frames larger than this are refused outright. Without a cap, a hostile
   client can announce a 2^63-byte payload and have the server allocate
   towards it. Our largest legitimate message is the initial WORLD_EDITS dump. */
const MAX_FRAME = 8 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', (err) => { this.emit('error', err); this._closed(); });
    // Nagle batches small writes; for a 20Hz tick that adds latency for no
    // benefit, since our messages are already sized deliberately.
    socket.setNoDelay(true);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // A single TCP read can contain several frames, or half of one.
    while (this.open) {
      const consumed = this._tryReadFrame();
      if (!consumed) break;
    }
  }

  _tryReadFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return false;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME)) { this.close(1009, 'message too large'); return false; }
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_FRAME) { this.close(1009, 'message too large'); return false; }

    // The spec requires client->server frames to be masked; an unmasked one
    // means either a broken client or someone speaking the wrong protocol.
    if (!masked) { this.close(1002, 'client frames must be masked'); return false; }

    if (buf.length < offset + 4 + len) return false;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += len;

    this._buffer = buf.subarray(offset);

    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.PING:
        this._send(OP.PONG, payload);
        return;
      case OP.PONG:
        this.emit('pong', payload);
        return;
      case OP.CLOSE:
        this.close(1000, '');
        return;
      case OP.CONTINUATION:
        if (this._fragmentOp === null) { this.close(1002, 'unexpected continuation'); return; }
        this._fragments.push(payload);
        break;
      case OP.TEXT:
      case OP.BINARY:
        if (this._fragmentOp !== null) { this.close(1002, 'interleaved fragments'); return; }
        if (fin) { this._deliver(opcode, payload); return; }
        this._fragmentOp = opcode;
        this._fragments = [payload];
        return;
      default:
        this.close(1002, `unknown opcode ${opcode}`);
        return;
    }

    if (fin && this._fragmentOp !== null) {
      const full = Buffer.concat(this._fragments);
      const op = this._fragmentOp;
      this._fragments = [];
      this._fragmentOp = null;
      this._deliver(op, full);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      this.emit('message', payload.toString('utf8'), false);
    } else {
      // Hand up a copy sized exactly to the payload: Buffer views share the
      // pooled allocation, and a caller wrapping one in a DataView would
      // otherwise see neighbouring frames' bytes.
      const ab = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      this.emit('message', ab, true);
    }
  }

  _send(opcode, payload) {
    if (!this.open) return false;
    const len = payload.length;
    let header;
    // Server->client frames are never masked.
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;   // FIN + opcode
    try {
      this.socket.write(header);
      this.socket.write(payload);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  send(data) {
    if (typeof data === 'string') return this._send(OP.TEXT, Buffer.from(data, 'utf8'));
    const buf = data instanceof Buffer ? data
      : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
    return this._send(OP.BINARY, buf);
  }

  ping() { this._send(OP.PING, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._send(OP.CLOSE, body);
    this.open = false;
    try { this.socket.end(); } catch (_) { /* already gone */ }
    this.emit('close');
  }
}

/**
 * Attach WebSocket upgrade handling to an http.Server.
 * @param {import('http').Server} httpServer
 * @param {(conn: WebSocketConnection, req) => void} onConnection
 */
export function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = new WebSocketConnection(socket);
    // Bytes that arrived in the same packet as the upgrade request belong to
    // the first frame; dropping them loses the client's HELLO on fast links.
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}

export default attachWebSocketServer;
