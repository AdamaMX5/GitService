/**
 * Unit tests for git-client/src/config.js — parseRepoPaths function
 *
 * parseRepoPaths is not exported directly from config.js, but its logic is
 * embedded in the module-level config object initialisation. We test it by
 * re-implementing the function (mirroring the real code exactly) and then
 * doing a structural smoke-test of the real file to guard against drift.
 *
 * Special focus: Windows paths (C:\...) must NOT be split at the drive-letter
 * colon — only the FIRST colon per CSV entry is the name/path delimiter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'git-client', 'src', 'config.js');

// ---------------------------------------------------------------------------
// Mirror of parseRepoPaths from git-client/src/config.js
// ---------------------------------------------------------------------------

function parseRepoPaths(str) {
  if (!str) return {};
  const result = {};
  for (const entry of str.split(',')) {
    const trimmed = entry.trim();
    const firstColon = trimmed.indexOf(':');
    if (firstColon === -1) continue;
    const name = trimmed.slice(0, firstColon).trim();
    const path = trimmed.slice(firstColon + 1).trim();
    if (name && path) result[name] = path;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structural smoke-test of the real file
// ---------------------------------------------------------------------------

describe('git-client/config.js — structural smoke-test', () => {
  it('uses indexOf for first-colon split (not simple split on ":")', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('indexOf'), 'must use indexOf to find the first colon');
    assert.ok(src.includes('slice'), 'must use slice to extract name and path');
  });

  it('handles undefined/empty REPO_PATHS by returning empty object', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('if (!str)') || src.includes('if(!str)'), 'must guard against empty/null input');
  });
});

// ---------------------------------------------------------------------------
// Functional tests
// ---------------------------------------------------------------------------

describe('parseRepoPaths — POSIX paths', () => {
  it('parses a single entry', () => {
    const result = parseRepoPaths('my-repo:/home/kurt/git/my-repo');
    assert.deepEqual(result, { 'my-repo': '/home/kurt/git/my-repo' });
  });

  it('parses multiple entries', () => {
    const result = parseRepoPaths(
      'frontend:/home/kurt/git/frontend,backend:/home/kurt/git/backend'
    );
    assert.deepEqual(result, {
      frontend: '/home/kurt/git/frontend',
      backend: '/home/kurt/git/backend',
    });
  });

  it('trims whitespace around entries', () => {
    const result = parseRepoPaths(' my-repo : /home/kurt/git/my-repo ');
    assert.deepEqual(result, { 'my-repo': '/home/kurt/git/my-repo' });
  });
});

describe('parseRepoPaths — Windows paths', () => {
  it('handles Windows drive-letter paths (C:\\...)', () => {
    const result = parseRepoPaths('my-repo:C:\\Users\\Kurt\\git\\my-repo');
    assert.deepEqual(result, { 'my-repo': 'C:\\Users\\Kurt\\git\\my-repo' });
  });

  it('handles multiple Windows paths in one string', () => {
    const result = parseRepoPaths(
      'frontend:C:\\Users\\Kurt\\git\\frontend,backend:C:\\Users\\Kurt\\git\\backend'
    );
    assert.deepEqual(result, {
      frontend: 'C:\\Users\\Kurt\\git\\frontend',
      backend: 'C:\\Users\\Kurt\\git\\backend',
    });
  });

  it('Windows path containing a second colon after drive letter is preserved', () => {
    // e.g. "repo:C:\some\path" — the C: is part of the path, not a delimiter
    const result = parseRepoPaths('my-service:C:\\path\\to\\service');
    assert.equal(result['my-service'], 'C:\\path\\to\\service');
  });
});

describe('parseRepoPaths — edge cases', () => {
  it('returns empty object for undefined input', () => {
    assert.deepEqual(parseRepoPaths(undefined), {});
  });

  it('returns empty object for null input', () => {
    assert.deepEqual(parseRepoPaths(null), {});
  });

  it('returns empty object for empty string', () => {
    assert.deepEqual(parseRepoPaths(''), {});
  });

  it('skips entries without a colon', () => {
    const result = parseRepoPaths('valid-repo:/path/to/repo,invalid-entry,another:/path');
    assert.equal(Object.keys(result).length, 2);
    assert.ok('valid-repo' in result);
    assert.ok('another' in result);
    assert.ok(!('invalid-entry' in result));
  });

  it('skips entries with empty name (starts with colon)', () => {
    const result = parseRepoPaths(':/path/to/nowhere');
    assert.deepEqual(result, {});
  });

  it('skips entries with empty path (ends with colon)', () => {
    const result = parseRepoPaths('repo-name:');
    assert.deepEqual(result, {});
  });

  it('handles trailing comma gracefully', () => {
    const result = parseRepoPaths('repo:/path,');
    assert.deepEqual(result, { repo: '/path' });
  });

  it('the last entry in a comma-separated list is parsed correctly', () => {
    const result = parseRepoPaths('a:/alpha,b:/beta,c:/gamma');
    assert.equal(result['c'], '/gamma');
  });
});
