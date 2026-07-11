/**
 * Real (executable) unit tests for session-limit detection in
 * verboseClaudeRunner.js.
 *
 * When Claude exhausts its session quota it prints a notice like
 * "You've hit your session limit · resets 14:30 (CET)". That is a temporary,
 * expected state — the wrapper must detect it and (via a dedicated exit code)
 * let the launcher auto-close and the queue retry, instead of treating it as a
 * generic failure that pauses the window forever.
 *
 * matchesSessionLimit is the pure predicate behind that detection. The module
 * is import-side-effect-free (the streaming wrapper only runs when the file is
 * executed directly), so importing it here does NOT spawn `claude`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesSessionLimit, parseSessionLimitResetTime } from '../src/verboseClaudeRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'verboseClaudeRunner.js');

// parseSessionLimitResetTime is covered exhaustively (DST, hemisphere, rollover,
// invalid input) in tests/resetTimeParser.test.js — the single source of truth
// for that function. This file owns the matchesSessionLimit predicate, the
// ReDoS/slice guards shared by both entry points, and the structural exit-code
// contract.

describe('matchesSessionLimit — detection', () => {
  it('matches the real session-limit notice text', () => {
    assert.equal(matchesSessionLimit("You've hit your session limit · resets 14:30 (CET)"), true);
  });

  it('is case-insensitive on the exact phrase', () => {
    assert.equal(matchesSessionLimit("YOU'VE HIT YOUR SESSION LIMIT"), true);
    assert.equal(matchesSessionLimit('Hit Your Session Limit'), true);
  });

  it('matches when the phrase is embedded in a larger line', () => {
    assert.equal(matchesSessionLimit("note: you've hit your session limit, retry later"), true);
  });

  it('requires the specific "hit your session limit" phrase, not a bare "session limit"', () => {
    // The regex was deliberately narrowed from /session limit/i: a bare match
    // false-positives on reflected issue content and, paired with a forced
    // non-zero exit, could pause the whole queue for hours. These looser
    // phrasings must therefore NOT match.
    assert.equal(matchesSessionLimit('SESSION LIMIT reached'), false);
    assert.equal(matchesSessionLimit('Session Limit'), false);
    assert.equal(matchesSessionLimit('warning: approaching your session limit, please wait'), false);
  });

  it('does not match ordinary output', () => {
    assert.equal(matchesSessionLimit('Editing file src/index.js'), false);
    assert.equal(matchesSessionLimit('rate limit exceeded'), false, 'a different "limit" must not false-positive');
  });

  it('safely handles empty/nullish input without throwing', () => {
    assert.equal(matchesSessionLimit(''), false);
    assert.equal(matchesSessionLimit(null), false);
    assert.equal(matchesSessionLimit(undefined), false);
  });
});

describe('matchesSessionLimit — 500-char scan window (documented slice behaviour)', () => {
  const NOTICE = "You've hit your session limit · resets 14:30 (CET)";

  it('detects the notice when it lies within the first 500 chars', () => {
    // Notice starts at offset 100, wholly inside the 500-char window.
    const text = 'x'.repeat(100) + NOTICE + '\n' + 'y'.repeat(2000);
    assert.equal(matchesSessionLimit(text), true);
  });

  it('does NOT detect the notice when it starts beyond the first 500 chars', () => {
    // Intentional: matchesSessionLimit only scans text.slice(0, 500). A genuine
    // notice is short and prefix-positioned, so this trade-off (ReDoS safety over
    // detecting a notice buried after 500 chars of unrelated output) is by design.
    const text = 'x'.repeat(500) + NOTICE;
    assert.equal(matchesSessionLimit(text), false);
  });
});

describe('session-limit scanning — ReDoS resistance', () => {
  // Before the fix, RESET_TIME_RE used unbounded \s* runs before "(", so an input
  // with a long whitespace run that then fails to close the group forced
  // catastrophic backtracking (~13s on the payload below). The bounded quantifiers
  // plus the 500-char MAX_NOTICE_SCAN cap must keep this effectively instant.
  const BUDGET_MS = 200;

  it('parseSessionLimitResetTime handles an adversarial whitespace flood instantly', () => {
    const malicious = 'resets 12:34' + ' '.repeat(100000) + 'x';
    const start = process.hrtime.bigint();
    const r = parseSessionLimitResetTime(malicious);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(r, null, 'unterminated zone group must not parse');
    assert.ok(elapsedMs < BUDGET_MS, `parse took ${elapsedMs.toFixed(1)}ms, expected < ${BUDGET_MS}ms`);
  });

  it('matchesSessionLimit handles a very long input instantly', () => {
    const malicious = 'hit your session limit' + ' '.repeat(200000) + '(';
    const start = process.hrtime.bigint();
    const r = matchesSessionLimit(malicious);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(r, true);
    assert.ok(elapsedMs < BUDGET_MS, `match took ${elapsedMs.toFixed(1)}ms, expected < ${BUDGET_MS}ms`);
  });
});

describe('verboseClaudeRunner — exit-code signalling (structural)', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('signals SESSION_LIMIT_EXIT_CODE only when a non-zero exit coincided with the notice', () => {
    const closeBlock = src.slice(src.indexOf("child.on('close'"), src.indexOf("child.on('error'"));
    assert.ok(
      /if \(code !== 0 && sessionLimitHit\)/.test(closeBlock),
      'session-limit code is only emitted for a non-zero exit that saw the notice',
    );
    assert.ok(
      /process\.exitCode = SESSION_LIMIT_EXIT_CODE/.test(closeBlock),
      'must forward the dedicated session-limit exit code',
    );
    assert.ok(
      /process\.exitCode = code \?\? 1/.test(closeBlock),
      "otherwise it must forward claude's own exit code",
    );
  });

  it('only runs the streaming wrapper when executed directly (import stays side-effect free)', () => {
    assert.ok(
      /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(src),
      'a main-module guard must gate main() so importing the module does not spawn claude',
    );
  });
});
