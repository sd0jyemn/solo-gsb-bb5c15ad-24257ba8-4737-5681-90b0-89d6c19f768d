import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CacheStore } from './db';
import registerRoutes from './routes';
import { NormalizeError } from './canonical';
import { ValidationError } from './util';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? '/data/cache-lab.db';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

export function buildServer(dbPath: string): FastifyInstance {
  const store = new CacheStore(dbPath);
  const app = Fastify({
    logger: { level: LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024,
  });

  app.setErrorHandler((error, _req: FastifyRequest, reply: FastifyReply) => {
    const statusCode =
      (error as { statusCode?: number }).statusCode ??
      (error.validation ? 400 : 500);
    if (statusCode >= 500) {
      app.log.error(error);
    } else {
      app.log.info({ err: error.message }, 'request rejected');
    }
    reply.code(statusCode).send({
      error: error.name ?? 'Error',
      statusCode,
      message: error.message,
    });
  });

  registerRoutes(app, store);

  app.addHook('onClose', async () => {
    store.close();
  });

  return app;
}

if (require.main === module) {
  const app = buildServer(DB_PATH);
  app
    .listen({ port: PORT, host: HOST })
    .then(() => {
      app.log.info(`http-cache-lab listening on http://${HOST}:${PORT} (db=${DB_PATH})`);
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
