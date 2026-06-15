import { Router } from 'express';
import { authCli } from '../middleware/authCli.js';
import { getRepos, getIssue, closeIssue, listOpenIssues } from '../clients/gitClient.js';
import { postCommentAndMaybeEmail } from '../services/issueService.js';

const router = Router();
router.use(authCli);

// Repo names must be safe slug-like identifiers — no path traversal characters.
const REPO_RE = /^[a-zA-Z0-9_.-]{1,100}$/;
// Issue numbers must be positive integers.
const NUMBER_RE = /^\d{1,9}$/;
// Maximum comment body length (64 KiB).
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

// Used by the GitClient poller to discover new open issues across all repos
router.get('/issues', async (req, res) => {
  try {
    const repos = await getRepos();
    const results = await Promise.all(repos.map(r => listOpenIssues(r.name)));
    res.json(results.flat());
  } catch (err) {
    console.error('GET /issues error:', err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

router.get('/cli/issue/:number', async (req, res) => {
  const { number } = req.params;
  const { repo } = req.query;
  if (!repo) {
    return res.status(400).json({ error: 'repo query parameter is required' });
  }
  if (!isValidRepo(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }
  if (!isValidNumber(number)) {
    return res.status(400).json({ error: 'Invalid issue number' });
  }
  try {
    const issue = await getIssue(repo, number);
    res.json(issue);
  } catch (err) {
    console.error(`GET /cli/issue/${number} error:`, err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Issue not found' });
    }
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

router.post('/cli/issue/:number/comment', async (req, res) => {
  const { number } = req.params;
  const { repo, body, type } = req.body;
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
    const result = await postCommentAndMaybeEmail(repo, number, body, type);
    res.status(201).json(result);
  } catch (err) {
    console.error(`POST /cli/issue/${number}/comment error:`, err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

router.patch('/cli/issue/:number/close', async (req, res) => {
  const { number } = req.params;
  const { repo } = req.body;
  if (!repo) {
    return res.status(400).json({ error: 'repo is required' });
  }
  if (!isValidRepo(repo)) {
    return res.status(400).json({ error: 'Invalid repo name' });
  }
  if (!isValidNumber(number)) {
    return res.status(400).json({ error: 'Invalid issue number' });
  }
  try {
    await closeIssue(repo, number);
    res.json({ number: Number(number), state: 'closed' });
  } catch (err) {
    console.error(`PATCH /cli/issue/${number}/close error:`, err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

export default router;
