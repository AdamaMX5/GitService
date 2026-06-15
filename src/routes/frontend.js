import { Router } from 'express';
import { authJwt } from '../middleware/authJwt.js';
import { getRepos, createIssue, createComment } from '../clients/gitClient.js';
import { storeIssue } from '../services/issueService.js';

const router = Router();
router.use(authJwt);

// Repo names must be safe slug-like identifiers — no path traversal characters.
// Allows alphanumeric, hyphens, underscores, and dots (e.g. "my-repo", "org.repo").
const REPO_RE = /^[a-zA-Z0-9_.-]{1,100}$/;
// Issue numbers must be positive integers.
const NUMBER_RE = /^\d{1,9}$/;
// Maximum comment / issue body length (64 KiB is generous but bounded).
const MAX_BODY_LENGTH = 65_536;

function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

function isValidNumber(number) {
  return typeof number === 'string' && NUMBER_RE.test(number);
}

function isValidBody(body) {
  return typeof body === 'string' && body.length > 0 && body.length <= MAX_BODY_LENGTH;
}

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
