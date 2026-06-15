import { Router } from 'express';
import { authApiKey } from '../middleware/authApiKey.js';
import { createComment } from '../clients/gitClient.js';
import { parseIssueNumberFromSubject, findIssueByNumber } from '../services/issueService.js';

const router = Router();
router.use(authApiKey);

router.post('/webhook/email-reply', async (req, res) => {
  const { from, subject, body } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body are required' });
  }

  const issueNumber = parseIssueNumberFromSubject(subject);
  if (!issueNumber) {
    return res.status(422).json({ error: 'Could not parse issue number from subject' });
  }

  const stored = findIssueByNumber(issueNumber);
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
