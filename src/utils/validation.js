// Repo names must be safe slug-like identifiers — no path traversal characters.
// Allows alphanumeric, hyphens, underscores, and dots (e.g. "my-repo", "org.repo").
export const REPO_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

// Issue numbers must be positive integers.
export const NUMBER_RE = /^\d{1,9}$/;

// Maximum comment / issue body length (64 KiB is generous but bounded).
export const MAX_BODY_LENGTH = 65_536;

export function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

export function isValidNumber(number) {
  return typeof number === 'string' && NUMBER_RE.test(number);
}

export function isValidBody(body) {
  return typeof body === 'string' && body.length > 0 && body.length <= MAX_BODY_LENGTH;
}

// API key labels must be non-empty strings of at most 100 characters.
export function isValidName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 100;
}
