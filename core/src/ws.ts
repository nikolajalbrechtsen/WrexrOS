/**
 * Dependency-free RFC 6455 WebSocket endpoint.
 *
 * Supports handshake, masked client frames, text/binary/ping/pong/close,
 * fragmentation, broadcasting and the three WrexrOS channels. Malformed
 * frames close only that client instead of crashing the process.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { subscribeEvents } from './audit.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { sampleMetrics } from './system.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CHANNELS = new Set(['/ws/metrics', '/ws/events', '/ws/terminal']);

export function websocketAccept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode an unmasked server text/binary frame. */
export function encodeFrame(payload: string | Buffer, opcode = 1): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode, server frames are unmasked
  return Buffer.concat([header, data]);
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

/** Decode as many complete client frames as possible. Client frames are masked. */
export function decodeFrames(buffer: Buffer): { frames: DecodedFrame[]; consumed: number } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    const fin = (first & 0x80) !== 0;
    if ((first & 0x70) !== 0) throw new Error('WebSocket RSV bits are not supported');
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (!masked) throw new Error('Client frames must be masked');
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const huge = buffer.readBigUInt64BE(offset + 2);
      if (huge > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame too large');
      length = Number(huge);
      headerLength = 10;
    }
    if (offset + headerLength + 4 > buffer.length) break;
    const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
    const payloadStart = offset + headerLength + 4;
    if (payloadStart + length > buffer.length) break; // wait for more bytes
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    offset = payloadStart + length;
    frames.push({ opcode, payload, fin });
    if (frames.length >= 64) break; // prevent a single chunk from hogging the loop
  }
  return { frames, consumed: offset };
}

/** Mask a payload - useful for tests that emulate a browser client. */
export function encodeMaskedClientFrame(payload: string | Buffer, opcode = 1): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (mask[i % 4] as number);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, mask, masked]);
}

interface TerminalMessage {
  type?: string;
  data?: unknown;
  cols?: number;
  rows?: number;
}

class WsConnection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  private child: ChildProcess | null = null;
  readonly socket: Duplex;
  readonly channel: string;

  constructor(socket: Duplex, channel: string) {
    this.socket = socket;
    this.channel = channel;
    this.socket.on('error', () => this.cleanup());
    this.socket.on('close', () => this.cleanup());
  }

  start(initial?: Buffer): void {
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    if (this.channel === '/ws/terminal') this.startTerminal();
    if (initial && initial.length) this.onData(initial);
  }

  send(payload: unknown): void {
    this.sendText(JSON.stringify(payload));
  }

  sendText(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(text));
    } catch (error) {
      logger.debug('WebSocket write failed', { error: String(error) });
      this.cleanup();
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      const body = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(reason)]);
      this.socket.write(encodeFrame(body, 0x8));
      this.socket.end();
    } catch {
      /* socket may already be gone */
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    clients.delete(this);
  }

  onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded: { frames: DecodedFrame[]; consumed: number };
    try {
      decoded = decodeFrames(this.buffer);
    } catch (error) {
      logger.debug('Dropping malformed WebSocket frame', { error: String(error) });
      this.close(1002, 'malformed frame');
      return;
    }
    this.buffer = this.buffer.subarray(decoded.consumed);
    for (const frame of decoded.frames) this.handleFrame(frame);
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case 0x0: // continuation
        this.fragments.push(frame.payload);
        if (frame.fin) this.deliverText(Buffer.concat(this.fragments).toString('utf8'));
        this.fragments = [];
        break;
      case 0x1: // text
        if (!frame.fin) {
          this.fragments.push(frame.payload);
        } else if (this.fragments.length) {
          this.fragments.push(frame.payload);
          this.deliverText(Buffer.concat(this.fragments).toString('utf8'));
          this.fragments = [];
        } else {
          this.deliverText(frame.payload.toString('utf8'));
        }
        break;
      case 0x8: // close
        this.close(1000);
        break;
      case 0x9: // ping -> pong
        try {
          this.socket.write(encodeFrame(frame.payload, 0xa));
        } catch {
          /* ignore */
        }
        break;
      case 0xa: // pong
        break;
      default:
        this.close(1002, 'unsupported opcode');
    }
  }

  private deliverText(text: string): void {
    if (this.channel !== '/ws/terminal') return;
    let message: TerminalMessage;
    try {
      message = JSON.parse(text) as TerminalMessage;
    } catch {
      return; // terminal channel only understands JSON messages
    }
    if (message.type === 'close') {
      this.close(1000, 'terminal closed');
      return;
    }
    if (message.type === 'input') {
      const input = String(message.data ?? '');
      if (this.child?.stdin) {
        this.child.stdin.write(input);
      } else {
        // Demo mode: echo without spawning a shell on the host.
        this.send({ type: 'output', data: `${input}${input.endsWith('\n') ? '' : '\r\n'}` });
      }
    }
    if (message.type === 'resize') {
      // Terminal resize is informational; shells pick it up via SIGWINCH on Linux.
      if (process.platform !== 'win32' && this.child?.pid) {
        try {
          process.kill(this.child.pid, 'SIGWINCH');
        } catch {
          /* ignore */
        }
      }
    }
  }

  private startTerminal(): void {
    if (config.demoMode || !config.terminalEnabled) return;
    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
      const args = process.platform === 'win32' ? [] : ['-i'];
      this.child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const forward = (chunk: Buffer) => this.send({ type: 'output', data: chunk.toString('utf8') });
      this.child.stdout?.on('data', forward);
      this.child.stderr?.on('data', forward);
      this.child.on('error', (error) => {
        this.send({ type: 'output', data: `terminal error: ${error.message}\r\n` });
      });
      this.child.on('exit', () => this.close(1000, 'shell exited'));
    } catch (error) {
      this.send({ type: 'output', data: `terminal unavailable: ${String(error)}\r\n` });
    }
  }
}

const clients = new Set<WsConnection>();

export function broadcast(channel: string, payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const client of clients) {
    if (client.channel === channel) client.sendText(text);
  }
}

/** Perform the HTTP -> WebSocket upgrade. Returns null on a rejected upgrade. */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head?: Buffer): WsConnection | null {
  try {
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return null;
    }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return null;
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!CHANNELS.has(pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return null;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    const client = new WsConnection(socket, pathname);
    clients.add(client);
    client.start(head);
    return client;
  } catch (error) {
    logger.warn('WebSocket upgrade failed', { error: String(error) });
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return null;
  }
}

let metricsTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeEvents: (() => void) | undefined;

export function startMetricsPump(intervalMs = 2000): void {
  if (metricsTimer) return;
  metricsTimer = setInterval(() => {
    sampleMetrics()
      .then((metrics) => broadcast('/ws/metrics', { type: 'metrics', data: metrics }))
      .catch((error) => logger.debug('Metrics sampling failed', { error: String(error) }));
  }, intervalMs);
  metricsTimer.unref?.();
}

export function startEventBridge(): void {
  if (unsubscribeEvents) return;
  unsubscribeEvents = subscribeEvents((event) => {
    broadcast('/ws/events', {
      type: 'event',
      data: {
        id: event.id,
        level: event.level,
        message: event.message,
        time: event.ts,
        ...event.data,
      },
    });
  });
}

export function stopWebSocketServices(): void {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = undefined;
  unsubscribeEvents?.();
  unsubscribeEvents = undefined;
  for (const client of [...clients]) client.close(1001, 'server shutting down');
}

export function attachWebSocketServer(server: HttpServer): { close: () => void } {
  startEventBridge();
  startMetricsPump();
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });
  return { close: stopWebSocketServices };
}
