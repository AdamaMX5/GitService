import { Router } from 'express';
import { authJwt } from '../middleware/authJwt.js';
import { getRepos } from '../services/repoCache.js';
import { createIssue, createComment } from '../clients/gitClient.js';
import { storeIssue } from '../services/issueService.js';
import { isValidRepo, isValidNumber, isValidBody, MAX_BODY_LENGTH } from '../utils/validation.js';

const router = Router();
// Scoped to this router's own routes only — a path-less router.use() would run
// for every request that falls through to this router at the '/' mount point,
// even ones destined for a different router (e.g. /admin/*).
router.use(['/repos', '/issue'], authJwt);

router.get('/repos', (req, res) => {
  res.json(getRepos());
});

router.post('/issue', async (req, res) => {
  const { repo, title, body, labels } = req.body;
  if (!repo || !title || !body) {
    return res.status(400).json({ error: 'repo, title and body are required' });
  }
  if (!isValidRepo(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }
  if (!isValidBody(body)) {
    return res.status(400).json({ error: `body must be between 1 and ${MAX_BODY_LENGTH} characters` });
  }
  if (typeof title !== 'string' || title.length === 0 || title.length > 255) {
    return res.status(400).json({ error: 'title must be between 1 and 255 characters' });
  }
  try {
    const issue = await createIssue(repo, { title, body, labels });
    const creatorEmail = req.user?.email;
    if (creatorEmail) {
      storeIssue(repo, issue.number, { creatorEmail, title });
    }
    res.status(201).json(issue);
  } catch (err) {
    console.error('POST /issue error:', err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

router.post('/issue/:number/comment', async (req, res) => {
  const { number } = req.params;
  const { repo, body } = req.body;
  if (!repo || !body) {
    return res.status(400).json({ error: 'repo and body are required' });
  }
  if (!isValidRepo(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }
  if (!isValidNumber(number)) {
    return res.status(400).json({ error: 'Invalid issue number' });
  }
  if (!isValidBody(body)) {
    return res.status(400).json({ error: `body must be between 1 and ${MAX_BODY_LENGTH} characters` });
  }
  try {
    const comment = await createComment(repo, number, body);
    res.status(201).json(comment);
  } catch (err) {
    console.error(`POST /issue/${number}/comment error:`, err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

export default router;
