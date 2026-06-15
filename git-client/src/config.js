import 'dotenv/config';

// Parses "repo-name:/path/to/dir,other-repo:/other/path" into { 'repo-name': '/path/to/dir', ... }
// Splits on the FIRST colon per entry so Windows paths like C:\... are handled correctly.
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

export const config = {
  gitServiceUrl: process.env.GIT_SERVICE_URL || 'https://git.freischule.info',
  gitServiceApiKey: process.env.GIT_SERVICE_API_KEY || '',
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'https://auth.freischule.info',
  repoPaths: parseRepoPaths(process.env.REPO_PATHS),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '60', 10),
};
