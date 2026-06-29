import { jwtVerify } from 'jose';
import { getPublicKey } from './authJwt.js';

// Admin endpoints require a valid Bearer JWT (RS256) whose roles include 'ADMIN'.
// Mirrors the JWT branch of authCli.js.
export function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const publicKey = getPublicKey();
  if (!publicKey) {
    return res.status(503).json({ error: 'JWT public key not yet available' });
  }
  const token = authHeader.slice(7);
  jwtVerify(token, publicKey, { algorithms: ['RS256'] })
    .then(({ payload }) => {
      const roles = Array.isArray(payload.roles) ? payload.roles : [];
      if (roles.includes('ADMIN')) {
        req.user = payload;
        return next();
      }
      res.status(403).json({ error: 'ADMIN role required' });
    })
    .catch(() => res.status(401).json({ error: 'Invalid or expired JWT' }));
}
