import { Router } from 'express';
import { authJwt } from '../middleware/authJwt.js';
import { getRepos, createIssue, createComment } from '../clients/gitClient.js';
import { storeIssue } from '../services/issueService.js';

const router = Router();
router.use(authJwt);

router.get('/repos', async (req, res) => {
  try {
    const repos = await getRepos();
    res.json(repos);
  } catch (err) {
    console.error('GET /repos error:', err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

router.post('/issue', async (req, res) => {
  const { repo, title, body, labels } = req.body;
  if (!repo || !title || !body) {
    return res.status(400).json({ error: 'repo, title and body are required' });
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
  try {
    const comment = await createComment(repo, number, body);
    res.status(201).json(comment);
  } catch (err) {
    console.error(`POST /issue/${number}/comment error:`, err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

export default router;
