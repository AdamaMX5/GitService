import { Router } from 'express';
import { authCli } from '../middleware/authCli.js';
import { getRepos, getIssue, closeIssue, listOpenIssues } from '../clients/gitClient.js';
import { postCommentAndMaybeEmail, flagIssueAndNotifyAdmin } from '../services/issueService.js';
import { scanIssueContent } from '../services/contentSafety.js';
import { isValidRepo, isValidNumber, isValidBody, MAX_BODY_LENGTH } from '../utils/validation.js';

const router = Router();
// Scoped to this router's own routes only — a path-less router.use() would run
// for every request that falls through to this router at the '/' mount point,
// even ones destined for a different router (e.g. /admin/*).
router.use('/issues', authCli);
router.use('/cli', authCli);

// Used by the GitClient poller to discover new open issues across all repos.
// Issues are scanned for prompt-injection / malicious content before being handed to
// the poller — flagged issues are excluded here and the admin is notified instead,
// since the poller feeds this content directly into an autonomous coding agent.
router.get('/issues', async (req, res) => {
  try {
    const repos = await getRepos();
    const results = await Promise.all(repos.map(r => listOpenIssues(r.name)));
    const issues = results.flat();

    const safeIssues = [];
    const flagged = [];
    for (const issue of issues) {
      const scan = scanIssueContent(issue.title, issue.body);
      if (scan.flagged) {
        flagged.push({ issue, reasons: scan.reasons });
      } else {
        safeIssues.push(issue);
      }
    }

    res.json(safeIssues);

    // Fire-and-forget: admin notification emails must not block/delay this response —
    // a slow/down EmailService, or an attacker flooding a repo with flagged issues,
    // would otherwise starve the GitClient poller of every repo's issues, not just
    // the flagged ones. Rejections are caught here so they don't surface as unhandled.
    Promise.allSettled(flagged.map(({ issue, reasons }) => flagIssueAndNotifyAdmin(issue, reasons))).catch(err => {
      console.error('Unexpected error while notifying admin of flagged issues:', err.message);
    });
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
