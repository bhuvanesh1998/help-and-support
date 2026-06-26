import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

const app = createApp();

const server: Server = app.listen(env.port, () => {
  logger.info('server started', {
    port: env.port,
    env: env.nodeEnv,
    baseUrl: env.publicBaseUrl,
  });
});

/** Drain connections and close the DB pool before exiting. */
async function shutdown(signal: string): Promise<void> {
  logger.info('shutdown initiated', { signal });

  server.close(async (closeErr?: Error) => {
    if (closeErr) {
      logger.error('error closing HTTP server', { message: closeErr.message });
    }
    try {
      await prisma.$disconnect();
      logger.info('database disconnected');
    } catch (err) {
      logger.error('error disconnecting database', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(closeErr ? 1 : 0);
  });

  // Hard stop if graceful shutdown stalls.
  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('uncaught exception', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});
