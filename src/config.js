import 'dotenv/config';

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  gitProvider: process.env.GIT_PROVIDER || 'gitea',
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: process.env.GITHUB_OWNER || '',
    // 'user' → /users/:owner/repos, 'org' → /orgs/:owner/repos
    ownerType: (process.env.GITHUB_OWNER_TYPE || 'user') === 'org' ? 'org' : 'user',
  },
  gitea: {
    baseUrl: process.env.GITEA_BASE_URL || '',
    token: process.env.GITEA_TOKEN || '',
    owner: process.env.GITEA_OWNER || '',
    // 'user' → /users/:owner/repos, 'org' → /orgs/:owner/repos
    ownerType: (process.env.GITEA_OWNER_TYPE || 'user') === 'org' ? 'org' : 'user',
  },
  mongo: {
    uri: required('MONGODB_URI'),
    dbName: process.env.MONGODB_DB || 'gitservice',
  },
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'https://auth.freischule.info',
  email: {
    serviceUrl: process.env.EMAIL_SERVICE_URL || '',
    apiKey: process.env.EMAIL_SERVICE_API_KEY || '',
    from: process.env.EMAIL_FROM || 'gitservice@flussmark.de',
    replyTo: process.env.EMAIL_REPLY_TO || 'gitservice@flussmark.de',
    adminEmail: process.env.ADMIN_EMAIL || '',
  },
};
