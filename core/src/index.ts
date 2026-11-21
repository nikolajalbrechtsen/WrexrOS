/** WrexrOS management daemon entry point. */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, lanIp } from './config.ts';
import { closeDb, initDb } from './db.ts';
import { logger } from './logger.ts';
import { handleRequest } from './router.ts';
import { ensureTls } from './system.ts';
import { attachWebSocketServer, stopWebSocketServices } from './ws.ts';

export async function main(): Promise<http.Server | https.Server> {
  initDb();
  const tls = config.insecureHttp ? null : await ensureTls();
  let server: http.Server | https.Server;
  if (tls) {
    server = https.createServer(
      { cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) },
      handleRequest,
    );
  } else {
    if (!config.insecureHttp) {
      logger.warn('HTTPS unavailable; starting plain HTTP (set WREXR_INSECURE_HTTP=1 explicitly)');
    }
    server = http.createServer(handleRequest);
  }

  const websocket = attachWebSocketServer(server);
  server.on('error', (error) => logger.error('HTTP server error', { error: String(error) }));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const scheme = tls ? 'https' : 'http';
  const bannerIp = config.host === '0.0.0.0' ? lanIp() : config.host;
  process.stdout.write(
    `WrexrOS management UI: ${scheme}://${bannerIp}:${config.port}` +
      `${config.demoMode ? ' (demo mode)' : ''}\n`,
  );
  logger.info('WrexrOS daemon started', {
    port: config.port,
    tls: !!tls,
    demo: config.demoMode,
    stateDir: config.stateDir,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    websocket.close();
    stopWebSocketServices();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    logger.error('Failed to start WrexrOS', { error: error instanceof Error ? error.stack : String(error) });
    process.exitCode = 1;
  });
}
