import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-ws-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';

const { initDb, closeDb } = await import('../src/db.ts');
const {
  decodeFrames, encodeFrame, encodeMaskedClientFrame, websocketAccept, attachWebSocketServer,
} = await import('../src/ws.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

test('server frames are unmasked with correct FIN and length bytes', () => {
  const shortFrame = encodeFrame('hello');
  assert.equal(shortFrame[0], 0x81);
  assert.equal(shortFrame[1], 5);
  assert.equal(shortFrame.subarray(2).toString(), 'hello');

  const medium = encodeFrame('x'.repeat(200));
  assert.equal(medium[0], 0x81);
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 200);

  const large = encodeFrame('y'.repeat(70_000));
  assert.equal(large[1], 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70_000);
});

test('masked client frames decode and partial frames are buffered', () => {
  const frame = encodeMaskedClientFrame('{"type":"input","data":"ls\\n"}');
  const decoded = decodeFrames(frame);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, 1);
  assert.equal(decoded.frames[0].payload.toString(), '{"type":"input","data":"ls\\n"}');
  assert.equal(decoded.consumed, frame.length);

  const partial = decodeFrames(frame.subarray(0, 5));
  assert.equal(partial.frames.length, 0);
  assert.equal(partial.consumed, 0);

  const ping = encodeMaskedClientFrame('ping', 0x9);
  assert.equal(decodeFrames(ping).frames[0].opcode, 0x9);
});

test('malformed frames are rejected without throwing unknown errors', () => {
  assert.throws(() => decodeFrames(encodeFrame('unmasked')), /must be masked/);
  const badRsv = encodeMaskedClientFrame('x');
  badRsv[0] = badRsv[0] | 0x40;
  assert.throws(() => decodeFrames(badRsv), /RSV/);
});

test('handshake accept matches the RFC 6455 example', () => {
  assert.equal(
    websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

test('live terminal socket completes handshake, echoes input and answers ping', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const hub = attachWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const socket = net.connect(port, '127.0.0.1');
  const key = crypto.randomBytes(16).toString('base64');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve) => socket.once('connect', resolve));

  socket.write(
    'GET /ws/terminal HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const handshake = Buffer.concat(chunks).toString('latin1');
  assert.match(handshake, /^HTTP\/1\.1 101/);
  assert.ok(handshake.includes(websocketAccept(key)));

  // Server frames are unmasked: parse the two-byte header directly.
  const serverFrames = (buffer: Buffer) => {
    const frames: Array<{ opcode: number; payload: string }> = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const opcode = (buffer[offset] as number) & 0x0f;
      const length = buffer[offset + 1] as number;
      const headerLength = length < 126 ? 2 : length === 126 ? 4 : 10;
      const size = length < 126
        ? length
        : length === 126
          ? buffer.readUInt16BE(offset + 2)
          : Number(buffer.readBigUInt64BE(offset + 2));
      frames.push({
        opcode,
        payload: buffer.subarray(offset + headerLength, offset + headerLength + size).toString(),
      });
      offset += headerLength + size;
    }
    return frames;
  };

  chunks.length = 0;
  socket.write(encodeMaskedClientFrame(JSON.stringify({ type: 'input', data: 'hello\n' })));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const echo = serverFrames(Buffer.concat(chunks));
  assert.equal(echo.length, 1);
  assert.deepEqual(JSON.parse(echo[0].payload), { type: 'output', data: 'hello\n' });

  chunks.length = 0;
  socket.write(encodeMaskedClientFrame('ping', 0x9));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pong = serverFrames(Buffer.concat(chunks));
  assert.equal(pong[0].opcode, 0xa);
  assert.equal(pong[0].payload, 'ping');

  socket.end();
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
