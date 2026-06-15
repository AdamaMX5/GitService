import { Router } from 'express';
import { authApiKey } from '../middleware/authApiKey.js';
import { getRepos, createComment, listOpenIssues } from '../clients/gitClient.js';
import { parseIssueNumberFromSubject, findIssueByNumber, storeIssue } from '../services/issueService.js';

const router = Router();
router.use(authApiKey);

/**
 * Resolves which repo owns the given issue number.
 * First checks the in-memory store (fast path).
 * Falls back to querying all repos via the git provider (handles server restart scenario).
 */
async function resolveIssueRepo(issueNumber) {
  const stored = findIssueByNumber(issueNumber);
  if (stored) return stored;

  // Fallback: query all repos for the open issue
  try {
    const repos = await getRepos();
    const allIssues = await Promise.all(repos.map(r => listOpenIssues(r.name)));
    for (const issues of allIssues) {
      const match = issues.find(i => i.number === issueNumber);
      if (match) {
        // Repopulate the in-memory store so subsequent calls are fast
        storeIssue(match.repo, match.number, {
          creatorEmail: null, // creator email unknown after restart — email-based questions won't work
          title: match.title,
        });
        return findIssueByNumber(issueNumber);
      }
    }
  } catch (err) {
    console.error(`Webhook fallback repo-lookup failed for issue #${issueNumber}:`, err.message);
  }
  return null;
}

// Maximum email body length accepted from the EmailService webhook (256 KiB is generous
// for email replies but still prevents unbounded memory usage).
const MAX_BODY_LENGTH = 262_144;

router.post('/webhook/email-reply', async (req, res) => {
  const { from, subject, body } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) {
    return res.status(400).json({ error: `body must not exceed ${MAX_BODY_LENGTH} characters` });
  }

  const issueNumber = parseIssueNumberFromSubject(subject);
  if (!issueNumber) {
    return res.status(422).json({ error: 'Could not parse issue number from subject' });
  }

  let stored;
  try {
    stored = await resolveIssueRepo(issueNumber);
  } catch (err) {
    console.error(`Webhook repo resolution error for issue #${issueNumber}:`, err.message);
    return res.status(503).json({ error: 'Git provider unavailable' });
  }

  if (!stored) {
    return res.status(404).json({ error: `No active issue found for #${issueNumber}` });
  }

  try {
    const replyBody = `**Email reply from ${from || 'unknown'}:**\n\n${body}`;
    const comment = await createComment(stored.repo, issueNumber, replyBody);
    res.json({ number: issueNumber, commentId: comment.id });
  } catch (err) {
    console.error(`Webhook email-reply error for issue #${issueNumber}:`, err.message);
    res.status(503).json({ error: 'Git provider unavailable' });
  }
});

export default router;
