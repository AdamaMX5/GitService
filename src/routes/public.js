import { readFileSync } from 'fs';
import { Router } from 'express';
import { config } from '../config.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));

const router = Router();

const helloHandler = (req, res) => {
  res.json({ message: "I'm the GitService.", version });
};

router.get('/', helloHandler);
router.get('/hello', helloHandler);

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GitService',
    version,
    provider: config.gitProvider,
    timestamp: new Date().toISOString(),
  });
});

export default router;
