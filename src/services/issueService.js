import { getIssue, createComment } from '../clients/gitClient.js';
import { sendEmail } from '../clients/emailClient.js';
import { config } from '../config.js';

// In-memory store: `${repo}:${number}` → { creatorEmail, title, repo, number, createdAt }
// Note: this store is cleared on server restart. A persistent store (DB) is needed for production.
const issueStore = new Map();

// In-memory set of `${repo}:${number}` keys already flagged and reported to the admin.
// Prevents re-notifying on every GitClient poll cycle. Cleared on server restart, same
// caveat as issueStore above.
const flaggedIssues = new Set();

export function storeIssue(repo, number, { creatorEmail, title }) {
  issueStore.set(`${repo}:${number}`, {
    creatorEmail,
    title,
    repo,
    number: Number(number),
    createdAt: new Date(),
  });
}

export function getStoredIssue(repo, number) {
  return issueStore.get(`${repo}:${number}`) || null;
}

export function findIssueByNumber(number) {
  const num = Number(number);
  for (const entry of issueStore.values()) {
    if (entry.number === num) return entry;
  }
  return null;
}

export function parseIssueNumberFromSubject(subject) {
  const match = subject?.match(/\[GitService #(\d+)\]/);
  return match ? Number(match[1]) : null;
}

export function hasBeenFlagged(repo, number) {
  return flaggedIssues.has(`${repo}:${number}`);
}

export async function flagIssueAndNotifyAdmin(issue, reasons) {
  const { repo, number } = issue;

  if (hasBeenFlagged(repo, number)) {
    return { notified: false };
  }
  // Mark as flagged before the (possibly slow) email call so a duplicate call within
  // the same poll tick can't send a second notification.
  flaggedIssues.add(`${repo}:${number}`);

  if (!config.email.adminEmail) {
    console.warn(`No admin email configured — skipping malicious-content notification for ${repo}#${number}`);
    return { notified: false };
  }

  try {
    const excerpt = (issue.body || '').slice(0, 500);
    await sendEmail({
      to: config.email.adminEmail,
      subject: `[GitService] Issue #${number} auf verdächtigen Inhalt geprüft und zurückgehalten`,
      body: [
        `Repo: ${repo}`,
        `Issue: #${number}`,
        `Titel: ${issue.title}`,
        `URL: ${issue.url}`,
        `Gründe: ${reasons.join(', ')}`,
        '',
        'Auszug (erste 500 Zeichen):',
        excerpt,
      ].join('\n'),
    });
    return { notified: true };
  } catch (err) {
    console.error(`Failed to send admin notification for flagged issue ${repo}#${number}:`, err.message);
    return { notified: false };
  }
}

export async function postCommentAndMaybeEmail(repo, number, body, type) {
  const comment = await createComment(repo, number, body);

  if (type !== 'question') {
    return { ...comment, emailSent: false };
  }

  let emailSent = false;
  try {
    const stored = getStoredIssue(repo, number);
    if (!stored?.creatorEmail) {
      console.warn(`No creator email stored for ${repo}#${number} — skipping question email`);
      return { ...comment, emailSent: false };
    }

    const issue = await getIssue(repo, number);
    await sendEmail({
      to: stored.creatorEmail,
      subject: `[GitService #${number}] Frage zu: ${issue.title}`,
      body: `${body}\n\n---\nAntworten Sie auf diese Email, um im Issue zu antworten.\nIssue: ${issue.url}`,
    });
    emailSent = true;
  } catch (err) {
    console.error(`Failed to send question email for ${repo}#${number}:`, err.message);
  }

  return { ...comment, emailSent };
}
