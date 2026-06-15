import { getIssue, createComment } from '../clients/gitClient.js';
import { sendEmail } from '../clients/emailClient.js';

// In-memory store: `${repo}:${number}` → { creatorEmail, title, repo, number, createdAt }
// Note: this store is cleared on server restart. A persistent store (DB) is needed for production.
const issueStore = new Map();

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
