import express from 'express';
import { config } from './config.js';
import { initJwtMiddleware } from './middleware/authJwt.js';
import { init as initRepoCache } from './services/repoCache.js';
import { connectMongo } from './db/mongo.js';
import { ensureIndexes } from './services/apiKeyService.js';
import publicRouter from './routes/public.js';
import frontendRouter from './routes/frontend.js';
import cliRouter from './routes/cli.js';
import webhookRouter from './routes/webhook.js';
import adminRouter from './routes/admin.js';

const app = express();
// Limit JSON body to 512 KiB to prevent DoS via oversized payloads.
app.use(express.json({ limit: '512kb' }));

app.use('/', publicRouter);
app.use('/', frontendRouter);
app.use('/', cliRouter);
app.use('/', webhookRouter);
app.use('/', adminRouter);

async function start() {
  await initJwtMiddleware();
  await connectMongo();
  await ensureIndexes();
  await initRepoCache();
  app.listen(config.port, () => {
    console.log(`GitService running on port ${config.port} (provider: ${config.gitProvider})`);
  });
}

start().catch(err => {
  console.error('Failed to start GitService:', err.message);
  process.exit(1);
});
