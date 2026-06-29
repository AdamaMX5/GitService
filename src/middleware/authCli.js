import { jwtVerify } from 'jose';
import { getPublicKey } from './authJwt.js';
import { verifyApiKey } from '../services/apiKeyService.js';

// CLI endpoints accept either a valid API key or a JWT with the GITCLIENT role.
// API key is used by standalone gts installations; GITCLIENT JWT is used by the GitClient daemon.
export async function authCli(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && await verifyApiKey(apiKey)) return next();

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const publicKey = getPublicKey();
    if (!publicKey) {
      return res.status(503).json({ error: 'JWT public key not yet available' });
    }
    const token = authHeader.slice(7);
    jwtVerify(token, publicKey, { algorithms: ['RS256'] })
      .then(({ payload }) => {
        const roles = Array.isArray(payload.roles) ? payload.roles : [];
        if (roles.includes('GITCLIENT')) {
          req.user = payload;
          return next();
        }
        res.status(403).json({ error: 'GITCLIENT role required' });
      })
      .catch(() => res.status(401).json({ error: 'Invalid or expired JWT' }));
    return;
  }

  res.status(401).json({ error: 'Valid API key or GITCLIENT JWT required' });
}
