import express from 'express';
import { config } from './config.js';
import { initJwtMiddleware } from './middleware/authJwt.js';
import publicRouter from './routes/public.js';
import frontendRouter from './routes/frontend.js';
import cliRouter from './routes/cli.js';
import webhookRouter from './routes/webhook.js';

const app = express();
app.use(express.json());

app.use('/', publicRouter);
app.use('/', frontendRouter);
app.use('/', cliRouter);
app.use('/', webhookRouter);

async function start() {
  await initJwtMiddleware();
  app.listen(config.port, () => {
    console.log(`GitService running on port ${config.port} (provider: ${config.gitProvider})`);
  });
}

start().catch(err => {
  console.error('Failed to start GitService:', err.message);
  process.exit(1);
});
