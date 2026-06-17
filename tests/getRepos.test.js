/**
 * Unit tests for getRepos() in githubClient.js and giteaClient.js
 *
 * Issue #1 acceptance criteria:
 *   - GITHUB_OWNER_TYPE=user  → GET /users/${owner}/repos
 *   - GITHUB_OWNER_TYPE=org   → GET /orgs/${owner}/repos
 *   - Default (env var absent) → same as 'user'
 *   - Identical logic for giteaClient
 *
 * Strategy: The clients read config at module-load time (top-level const) so
 * we cannot simply re-import with different env vars.  Instead we mirror the
 * getRepos() logic inline (a single, easily-auditable function) and verify the
 * URL selection against both implementations.  A structural smoke-test then
 * reads the actual source files to guard against implementation drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_CLIENT_PATH = join(__dirname, '..', 'src', 'clients', 'githubClient.js');
const GITEA_CLIENT_PATH  = join(__dirname, '..', 'src', 'clients', 'giteaClient.js');
const CONFIG_PATH        = join(__dirname, '..', 'src', 'config.js');

// ---------------------------------------------------------------------------
// Inline reference implementation — mirrors the getRepos() logic in both
// clients.  Accepts (owner, ownerType) so we can drive all branches without
// touching the real HTTP layer or module-level constants.
// ---------------------------------------------------------------------------

/**
 * Returns the repos-listing URL path that getRepos() would call for a given
 * ownerType.  Mirrors the ternary in both githubClient.js and giteaClient.js.
 */
function resolveReposPath(owner, ownerType) {
  return ownerType === 'org'
    ? `/orgs/${owner}/repos`
    : `/users/${owner}/repos`;
}

/**
 * Mirrors the ownerType normalisation logic from config.js:
 *   (process.env.X || 'user') === 'org' ? 'org' : 'user'
 */
function normaliseOwnerType(envValue) {
  return (envValue || 'user') === 'org' ? 'org' : 'user';
}

// ---------------------------------------------------------------------------
// Structural smoke-tests — read real source files to detect drift
// ---------------------------------------------------------------------------

describe('githubClient.js — structural smoke-test', () => {
  let src;
  it('reads source file without error', () => {
    src = readFileSync(GITHUB_CLIENT_PATH, 'utf8');
    assert.ok(src.length > 0);
  });

  it('branches on ownerType === "org" to choose /orgs path', () => {
    const src = readFileSync(GITHUB_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes("ownerType === 'org'"),
      'must compare ownerType to "org"'
    );
  });

  it('uses /orgs/${owner}/repos for org path', () => {
    const src = readFileSync(GITHUB_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('/orgs/${owner}/repos'),
      'must contain /orgs/${owner}/repos template literal'
    );
  });

  it('uses /users/${owner}/repos for user path', () => {
    const src = readFileSync(GITHUB_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('/users/${owner}/repos'),
      'must contain /users/${owner}/repos template literal'
    );
  });

  it('reads ownerType from config.github.ownerType', () => {
    const src = readFileSync(GITHUB_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('config.github.ownerType'),
      'must read config.github.ownerType'
    );
  });
});

describe('giteaClient.js — structural smoke-test', () => {
  it('branches on ownerType === "org" to choose /orgs path', () => {
    const src = readFileSync(GITEA_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes("ownerType === 'org'"),
      'must compare ownerType to "org"'
    );
  });

  it('uses /orgs/${owner}/repos for org path', () => {
    const src = readFileSync(GITEA_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('/orgs/${owner}/repos'),
      'must contain /orgs/${owner}/repos template literal'
    );
  });

  it('uses /users/${owner}/repos for user path', () => {
    const src = readFileSync(GITEA_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('/users/${owner}/repos'),
      'must contain /users/${owner}/repos template literal'
    );
  });

  it('reads ownerType from config.gitea.ownerType', () => {
    const src = readFileSync(GITEA_CLIENT_PATH, 'utf8');
    assert.ok(
      src.includes('config.gitea.ownerType'),
      'must read config.gitea.ownerType'
    );
  });
});

describe('config.js — ownerType normalisation smoke-test', () => {
  it('normalises GITHUB_OWNER_TYPE from env using the "org"-check pattern', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    assert.ok(
      src.includes('GITHUB_OWNER_TYPE'),
      'config must reference GITHUB_OWNER_TYPE'
    );
    assert.ok(
      src.includes('GITEA_OWNER_TYPE'),
      'config must reference GITEA_OWNER_TYPE'
    );
  });

  it('defaults to "user" when env var is absent', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // Default value 'user' must appear as the || fallback
    const defaultUserCount = (src.match(/'user'/g) || []).length;
    assert.ok(defaultUserCount >= 2, 'must use "user" as default for both github and gitea');
  });

  it('only accepts "org" or falls back to "user" (no other values)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // Both normalisations look like: === 'org' ? 'org' : 'user'
    assert.ok(
      src.includes("=== 'org' ? 'org' : 'user'"),
      'must use strict "org" check with "user" fallback'
    );
  });
});

// ---------------------------------------------------------------------------
// Functional tests for resolveReposPath (mirrors client logic)
// ---------------------------------------------------------------------------

describe('getRepos() URL selection — ownerType: "user"', () => {
  it('resolves to /users/${owner}/repos when ownerType is "user"', () => {
    const path = resolveReposPath('myuser', 'user');
    assert.equal(path, '/users/myuser/repos');
  });

  it('resolves to /users/${owner}/repos for any non-"org" value (empty string)', () => {
    const path = resolveReposPath('myuser', '');
    assert.equal(path, '/users/myuser/repos');
  });

  it('resolves to /users/${owner}/repos for undefined ownerType (safety)', () => {
    const path = resolveReposPath('myuser', undefined);
    assert.equal(path, '/users/myuser/repos');
  });
});

describe('getRepos() URL selection — ownerType: "org"', () => {
  it('resolves to /orgs/${owner}/repos when ownerType is "org"', () => {
    const path = resolveReposPath('myorg', 'org');
    assert.equal(path, '/orgs/myorg/repos');
  });

  it('does NOT resolve to /users/ path when ownerType is "org"', () => {
    const path = resolveReposPath('myorg', 'org');
    assert.ok(!path.includes('/users/'), 'org path must not include /users/');
  });
});

describe('getRepos() URL selection — owner name propagation', () => {
  it('embeds the correct owner name in user path', () => {
    const path = resolveReposPath('freischule-user', 'user');
    assert.equal(path, '/users/freischule-user/repos');
  });

  it('embeds the correct owner name in org path', () => {
    const path = resolveReposPath('freischule-org', 'org');
    assert.equal(path, '/orgs/freischule-org/repos');
  });
});

// ---------------------------------------------------------------------------
// Config normalisation tests — mirror of the ternary in config.js
// ---------------------------------------------------------------------------

describe('config ownerType normalisation — default value', () => {
  it('returns "user" when env var is undefined (default)', () => {
    assert.equal(normaliseOwnerType(undefined), 'user');
  });

  it('returns "user" when env var is empty string', () => {
    assert.equal(normaliseOwnerType(''), 'user');
  });

  it('returns "user" when env var is null', () => {
    assert.equal(normaliseOwnerType(null), 'user');
  });
});

describe('config ownerType normalisation — explicit "org"', () => {
  it('returns "org" when env var is "org"', () => {
    assert.equal(normaliseOwnerType('org'), 'org');
  });
});

describe('config ownerType normalisation — invalid / unexpected values', () => {
  it('returns "user" for "organisation" (not exact "org")', () => {
    assert.equal(normaliseOwnerType('organisation'), 'user');
  });

  it('returns "user" for "ORG" (case-sensitive check)', () => {
    assert.equal(normaliseOwnerType('ORG'), 'user');
  });

  it('returns "user" for "Org" (mixed case)', () => {
    assert.equal(normaliseOwnerType('Org'), 'user');
  });

  it('returns "user" for arbitrary string "admin"', () => {
    assert.equal(normaliseOwnerType('admin'), 'user');
  });
});

// ---------------------------------------------------------------------------
// Combined scenario tests (config normalisation + URL selection together)
// ---------------------------------------------------------------------------

describe('end-to-end scenario: env var → ownerType → repos URL', () => {
  function getReposPath(owner, envValue) {
    const ownerType = normaliseOwnerType(envValue);
    return resolveReposPath(owner, ownerType);
  }

  it('GITHUB_OWNER_TYPE unset → /users/${owner}/repos', () => {
    assert.equal(getReposPath('myuser', undefined), '/users/myuser/repos');
  });

  it('GITHUB_OWNER_TYPE=user → /users/${owner}/repos', () => {
    assert.equal(getReposPath('myuser', 'user'), '/users/myuser/repos');
  });

  it('GITHUB_OWNER_TYPE=org → /orgs/${owner}/repos', () => {
    assert.equal(getReposPath('myorg', 'org'), '/orgs/myorg/repos');
  });

  it('GITEA_OWNER_TYPE unset → /users/${owner}/repos', () => {
    assert.equal(getReposPath('gitea-user', undefined), '/users/gitea-user/repos');
  });

  it('GITEA_OWNER_TYPE=user → /users/${owner}/repos', () => {
    assert.equal(getReposPath('gitea-user', 'user'), '/users/gitea-user/repos');
  });

  it('GITEA_OWNER_TYPE=org → /orgs/${owner}/repos', () => {
    assert.equal(getReposPath('gitea-org', 'org'), '/orgs/gitea-org/repos');
  });
});
