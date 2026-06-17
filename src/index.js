import express from 'express';
import { config } from './config.js';
import { initJwtMiddleware } from './middleware/authJwt.js';
import { init as initRepoCache } from './services/repoCache.js';
import publicRouter from './routes/public.js';
import frontendRouter from './routes/frontend.js';
import cliRouter from './routes/cli.js';
import webhookRouter from './routes/webhook.js';

const app = express();
// Limit JSON body to 512 KiB to prevent DoS via oversized payloads.
app.use(express.json({ limit: '512kb' }));

app.use('/', publicRouter);
app.use('/', frontendRouter);
app.use('/', cliRouter);
app.use('/', webhookRouter);

async function start() {
  await initJwtMiddleware();
  await initRepoCache();
  app.listen(config.port, () => {
    console.log(`GitService running on port ${config.port} (provider: ${config.gitProvider})`);
  });
}

start().catch(err => {
  console.error('Failed to start GitService:', err.message);
  process.exit(1);
});
