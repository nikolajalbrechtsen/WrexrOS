/** Minimal dependency-free RFC 6455 WebSocket client (text/binary, ping/pong, close). */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';

export interface WSClient {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

export interface WSClientOptions {
  insecure?: boolean;
  handshakeTimeoutMs?: number;
  keepaliveMs?: number;
  onOpen?: () => void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function opcodeName(opcode: number): string {
  switch (opcode) {
    case 0x0: return 'continuation';
    case 0x1: return 'text';
    case 0x2: return 'binary';
    case 0x8: return 'close';
    case 0x9: return 'ping';
    case 0xa: return 'pong';
    default: return `0x${opcode.toString(16)}`;
  }
}

/** Open a WebSocket connection. Returns a handle with send() and close(). */
export function connect(
  url: string,
  headers: Record<string, string>,
  onMessage: (data: string | Buffer, isBinary: boolean) => void,
  onClose?: (code: number, reason: string) => void,
  options: WSClientOptions = {},
  onError?: (error: Error) => void,
): WSClient {
  const target = new URL(url);
  const scheme = target.protocol.toLowerCase();
  if (scheme !== 'ws:' && scheme !== 'wss:' && scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`unsupported WebSocket protocol: ${target.protocol}`);
  }
  const secure = scheme === 'wss:' || scheme === 'https:';
  const requestor = secure ? https : http;
  const key = crypto.randomBytes(16).toString('base64');
  const requestPath = `${target.pathname || '/'}${target.search}`;

  let socket: import('node:net').Socket | undefined;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let keepalive: NodeJS.Timeout | undefined;
  let closeTimeout: NodeJS.Timeout | undefined;

  const fail = (error: Error): void => {
    if (onError) onError(error);
    else process.stderr.write(`ws-client: ${error.message}\n`);
  };

  const sendFrame = (opcode: number, payload: Buffer, fin = true): void => {
    if (closed || !socket || socket.destroyed) throw new Error('WebSocket is not connected');
    if (opcode >= 0x8 && payload.length > 125) throw new Error('control frame too large');

    const mask = crypto.randomBytes(4);
    let headerLength = 2 + 4;
    if (payload.length >= 65536) headerLength += 8;
    else if (payload.length > 125) headerLength += 2;

    const header = Buffer.alloc(headerLength);
    header[0] = (fin ? 0x80 : 0) | opcode;
    let offset = 2;
    if (payload.length < 126) {
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, offset);
      offset += 2;
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), offset);
      offset += 8;
    }
    mask.copy(header, offset);

    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
    socket.write(Buffer.concat([header, masked]));
  };

  const finishClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    if (socket && !socket.destroyed) socket.end();
    if (onClose) onClose(code, reason);
  };

  const handleFrame = (fin: boolean, opcode: number, payload: Buffer): void => {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      try {
        if (!closed) sendFrame(0x8, payload.length >= 2 ? payload.subarray(0, Math.min(payload.length, 125)) : Buffer.from([0x03, 0xe8]));
      } catch {
        // Peer may already have gone away.
      }
      finishClose(code, reason);
      return;
    }
    if (opcode === 0x9) {
      sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      if (fragments.length === 0) {
        fail(new Error('unexpected continuation frame'));
        finishClose(1002, 'unexpected continuation');
        return;
      }
      fragments.push(payload);
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (fragments.length > 0) {
        fail(new Error('interleaved WebSocket data frames'));
        finishClose(1002, 'interleaved frames');
        return;
      }
      fragmentOpcode = opcode;
      fragments.push(payload);
    } else {
      fail(new Error(`unsupported WebSocket opcode ${opcodeName(opcode)}`));
      finishClose(1002, 'unsupported opcode');
      return;
    }

    if (!fin) return;
    const complete = Buffer.concat(fragments);
    fragments = [];
    const isBinary = fragmentOpcode === 0x2;
    try {
      onMessage(isBinary ? complete : complete.toString('utf8'), isBinary);
    } catch (error) {
      fail(error as Error);
    }
  };

  const parseBuffer = (): void => {
    while (!closed && buffer.length >= 2) {
      const first = buffer[0]!;
      const second = buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const wide = buffer.readBigUInt64BE(offset);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail(new Error('WebSocket frame too large'));
          finishClose(1009, 'frame too large');
          return;
        }
        length = Number(wide);
        offset += 8;
      }

      let mask: Buffer | undefined;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
      buffer = buffer.subarray(offset + length);
      handleFrame(fin, opcode, payload);
    }
  };

  const requestHeaders: Record<string, string> = {
    Host: target.host,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...headers,
  };

  const request = requestor.request(
    {
      protocol: secure ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port ? Number(target.port) : secure ? 443 : 80,
      path: requestPath,
      method: 'GET',
      headers: requestHeaders,
      rejectUnauthorized: options.insecure !== true,
    } as https.RequestOptions,
    (response) => {
      response.resume();
      fail(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode ?? 'unknown'}`));
      finishClose(1006, 'upgrade failed');
    },
  );

  request.setTimeout(options.handshakeTimeoutMs ?? 15000, () => {
    request.destroy(new Error('WebSocket handshake timed out'));
  });
  request.on('error', (error) => {
    fail(error);
    finishClose(1006, 'handshake error');
  });
  request.on('upgrade', (response, upgraded, head) => {
    const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
    if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) {
      fail(new Error('invalid WebSocket upgrade response'));
      upgraded.destroy();
      finishClose(1006, 'invalid handshake');
      return;
    }
    socket = upgraded;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      parseBuffer();
    });
    socket.on('error', (error) => fail(error));
    socket.on('close', () => finishClose(1000, 'socket closed'));
    if (head && head.length > 0) {
      buffer = Buffer.from(head);
      parseBuffer();
    }
    keepalive = setInterval(() => {
      try {
        sendFrame(0x9, Buffer.alloc(0));
      } catch {
        // close handler will clean up
      }
    }, options.keepaliveMs ?? 30000);
    keepalive.unref();
    if (options.onOpen) options.onOpen();
  });
  request.end();

  return {
    get closed(): boolean {
      return closed;
    },
    send(data: string | Buffer): void {
      sendFrame(0x1, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    },
    close(code = 1000, reason = ''): void {
      if (closed) return;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      try {
        sendFrame(0x8, payload.subarray(0, Math.min(payload.length, 125)));
      } catch {
        // Already closed.
      }
      if (closeTimeout) clearTimeout(closeTimeout);
      closeTimeout = setTimeout(() => {
        if (socket && !socket.destroyed) socket.destroy();
        finishClose(code, reason);
      }, 1000);
      closeTimeout.unref();
    },
  };
}
