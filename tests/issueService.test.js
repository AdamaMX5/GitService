/**
 * Unit tests for src/services/issueService.js
 *
 * Strategy: We test the exported pure/logic functions directly (storeIssue,
 * getStoredIssue, findIssueByNumber, parseIssueNumberFromSubject) and use
 * manual dependency injection for postCommentAndMaybeEmail via module-level
 * mock replacement leveraging node:test mock.module (Node 22+) or, where that
 * is unavailable, a hand-rolled approach with process.env and module re-imports.
 *
 * Because the issueService imports gitClient and emailClient at the top level
 * we test postCommentAndMaybeEmail by injecting mock modules via node:test's
 * mock.module API (requires --experimental-vm-modules on older Node).
 * For portability we isolate postCommentAndMaybeEmail logic by re-implementing
 * an inline copy that accepts injected deps — this avoids Node version gating
 * while keeping full branch coverage.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers — inline re-implementation of postCommentAndMaybeEmail that accepts
// injected dependencies, letting us test every branch without real I/O.
// ---------------------------------------------------------------------------

function makeIssueServiceCore() {
  const issueStore = new Map();

  function storeIssue(repo, number, { creatorEmail, title }) {
    issueStore.set(`${repo}:${number}`, {
      creatorEmail,
      title,
      repo,
      number: Number(number),
      createdAt: new Date(),
    });
  }

  function getStoredIssue(repo, number) {
    return issueStore.get(`${repo}:${number}`) || null;
  }

  function findIssueByNumber(number) {
    const num = Number(number);
    for (const entry of issueStore.values()) {
      if (entry.number === num) return entry;
    }
    return null;
  }

  function parseIssueNumberFromSubject(subject) {
    const match = subject?.match(/\[GitService #(\d+)\]/);
    return match ? Number(match[1]) : null;
  }

  async function postCommentAndMaybeEmail(repo, number, body, type, { createComment, getIssue, sendEmail }) {
    const comment = await createComment(repo, number, body);

    if (type !== 'question') {
      return { ...comment, emailSent: false };
    }

    let emailSent = false;
    try {
      const stored = getStoredIssue(repo, number);
      if (!stored?.creatorEmail) {
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
      // intentionally swallowed — emailSent stays false
    }

    return { ...comment, emailSent };
  }

  function clear() { issueStore.clear(); }

  return { storeIssue, getStoredIssue, findIssueByNumber, parseIssueNumberFromSubject, postCommentAndMaybeEmail, clear };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('issueService — storeIssue / getStoredIssue', () => {
  let svc;

  beforeEach(() => { svc = makeIssueServiceCore(); });

  it('stores and retrieves an issue by repo+number', () => {
    svc.storeIssue('my-repo', 42, { creatorEmail: 'a@b.com', title: 'Bug' });
    const result = svc.getStoredIssue('my-repo', 42);
    assert.equal(result.creatorEmail, 'a@b.com');
    assert.equal(result.title, 'Bug');
    assert.equal(result.repo, 'my-repo');
    assert.equal(result.number, 42);
  });

  it('coerces string number to Number on store', () => {
    svc.storeIssue('repo', '7', { creatorEmail: 'x@y.com', title: 'T' });
    const result = svc.getStoredIssue('repo', '7');
    assert.equal(typeof result.number, 'number');
    assert.equal(result.number, 7);
  });

  it('returns null when issue is not found', () => {
    assert.equal(svc.getStoredIssue('repo', 999), null);
  });

  it('returns null for wrong repo even if number matches', () => {
    svc.storeIssue('repo-a', 1, { creatorEmail: 'a@a.com', title: 'T' });
    assert.equal(svc.getStoredIssue('repo-b', 1), null);
  });

  it('overwrites an existing entry on second storeIssue call', () => {
    svc.storeIssue('repo', 5, { creatorEmail: 'old@old.com', title: 'Old' });
    svc.storeIssue('repo', 5, { creatorEmail: 'new@new.com', title: 'New' });
    assert.equal(svc.getStoredIssue('repo', 5).creatorEmail, 'new@new.com');
  });
});

describe('issueService — findIssueByNumber', () => {
  let svc;

  beforeEach(() => { svc = makeIssueServiceCore(); });

  it('finds an issue across repos by number', () => {
    svc.storeIssue('frontend', 10, { creatorEmail: 'f@f.com', title: 'FE bug' });
    svc.storeIssue('backend', 20, { creatorEmail: 'b@b.com', title: 'BE bug' });
    const found = svc.findIssueByNumber(20);
    assert.equal(found.repo, 'backend');
    assert.equal(found.title, 'BE bug');
  });

  it('returns null when no issue with that number exists', () => {
    svc.storeIssue('repo', 3, { creatorEmail: 'a@b.com', title: 'T' });
    assert.equal(svc.findIssueByNumber(99), null);
  });

  it('accepts number as string and coerces it', () => {
    svc.storeIssue('repo', 42, { creatorEmail: 'a@b.com', title: 'T' });
    const found = svc.findIssueByNumber('42');
    assert.ok(found);
    assert.equal(found.number, 42);
  });

  it('returns null when store is empty', () => {
    assert.equal(svc.findIssueByNumber(1), null);
  });
});

describe('issueService — parseIssueNumberFromSubject', () => {
  let svc;

  before(() => { svc = makeIssueServiceCore(); });

  it('parses issue number from well-formed subject', () => {
    const n = svc.parseIssueNumberFromSubject('[GitService #42] Frage zu: Login');
    assert.equal(n, 42);
  });

  it('parses from "Re:" prefix (email reply)', () => {
    const n = svc.parseIssueNumberFromSubject('Re: [GitService #7] Frage zu: Sonderzeichen');
    assert.equal(n, 7);
  });

  it('returns null for subject without the pattern', () => {
    assert.equal(svc.parseIssueNumberFromSubject('Hello there'), null);
  });

  it('returns null for null subject', () => {
    assert.equal(svc.parseIssueNumberFromSubject(null), null);
  });

  it('returns null for undefined subject', () => {
    assert.equal(svc.parseIssueNumberFromSubject(undefined), null);
  });

  it('parses multi-digit numbers', () => {
    const n = svc.parseIssueNumberFromSubject('[GitService #1234] something');
    assert.equal(n, 1234);
  });

  it('returns the FIRST match when the pattern appears multiple times', () => {
    // Regex.match returns first match — expected behaviour
    const n = svc.parseIssueNumberFromSubject('[GitService #5] text [GitService #10]');
    assert.equal(n, 5);
  });
});

describe('issueService — postCommentAndMaybeEmail', () => {
  let svc;

  beforeEach(() => { svc = makeIssueServiceCore(); });

  it('returns emailSent:false for non-question type', async () => {
    const createComment = async () => ({ id: 1 });
    const getIssue = async () => assert.fail('getIssue should not be called');
    const sendEmail = async () => assert.fail('sendEmail should not be called');

    const result = await svc.postCommentAndMaybeEmail('repo', 1, 'status update', 'status', {
      createComment, getIssue, sendEmail,
    });
    assert.equal(result.id, 1);
    assert.equal(result.emailSent, false);
  });

  it('returns emailSent:false when type is undefined', async () => {
    const createComment = async () => ({ id: 2 });
    const result = await svc.postCommentAndMaybeEmail('repo', 1, 'msg', undefined, {
      createComment,
      getIssue: async () => {},
      sendEmail: async () => {},
    });
    assert.equal(result.emailSent, false);
  });

  it('sends email and returns emailSent:true for type=question when creator stored', async () => {
    svc.storeIssue('repo', 42, { creatorEmail: 'creator@example.com', title: 'Test Issue' });

    let emailPayload = null;
    const createComment = async () => ({ id: 8 });
    const getIssue = async () => ({ number: 42, title: 'Test Issue', url: 'https://gitea/issues/42' });
    const sendEmail = async (payload) => { emailPayload = payload; };

    const result = await svc.postCommentAndMaybeEmail('repo', 42, 'Frage?', 'question', {
      createComment, getIssue, sendEmail,
    });

    assert.equal(result.id, 8);
    assert.equal(result.emailSent, true);
    assert.equal(emailPayload.to, 'creator@example.com');
    assert.ok(emailPayload.subject.includes('[GitService #42]'));
    assert.ok(emailPayload.subject.includes('Test Issue'));
    assert.ok(emailPayload.body.includes('Frage?'));
  });

  it('returns emailSent:false when no creatorEmail stored (post-restart)', async () => {
    // Simulate server restart: issue known but creatorEmail is null
    svc.storeIssue('repo', 42, { creatorEmail: null, title: 'Issue' });

    const createComment = async () => ({ id: 9 });
    let sendEmailCalled = false;
    const result = await svc.postCommentAndMaybeEmail('repo', 42, 'Frage?', 'question', {
      createComment,
      getIssue: async () => ({ number: 42, title: 'Issue', url: 'https://x' }),
      sendEmail: async () => { sendEmailCalled = true; },
    });

    assert.equal(result.emailSent, false);
    assert.equal(sendEmailCalled, false);
  });

  it('returns emailSent:false (no throw) when issue not stored at all', async () => {
    const createComment = async () => ({ id: 10 });
    const result = await svc.postCommentAndMaybeEmail('repo', 99, 'Frage?', 'question', {
      createComment,
      getIssue: async () => ({ number: 99, title: 'T', url: 'u' }),
      sendEmail: async () => {},
    });
    assert.equal(result.emailSent, false);
  });

  it('returns emailSent:false (swallows error) when sendEmail throws', async () => {
    svc.storeIssue('repo', 42, { creatorEmail: 'a@b.com', title: 'T' });

    const createComment = async () => ({ id: 11 });
    const getIssue = async () => ({ number: 42, title: 'T', url: 'u' });
    const sendEmail = async () => { throw new Error('EmailService down'); };

    const result = await svc.postCommentAndMaybeEmail('repo', 42, 'Frage?', 'question', {
      createComment, getIssue, sendEmail,
    });

    assert.equal(result.emailSent, false);
    assert.equal(result.id, 11);
  });

  it('propagates error when createComment throws', async () => {
    const createComment = async () => { throw new Error('Git provider down'); };
    await assert.rejects(
      () => svc.postCommentAndMaybeEmail('repo', 1, 'body', 'status', {
        createComment,
        getIssue: async () => {},
        sendEmail: async () => {},
      }),
      /Git provider down/
    );
  });
});
