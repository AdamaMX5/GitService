import { Router } from 'express';
import { config } from '../config.js';

const router = Router();

router.get('/', (req, res) => {
  res.json("I'm the GitService.");
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GitService',
    provider: config.gitProvider,
    timestamp: new Date().toISOString(),
  });
});

export default router;
