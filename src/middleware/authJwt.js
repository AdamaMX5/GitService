import { importSPKI, jwtVerify } from 'jose';
import axios from 'axios';
import { config } from '../config.js';

let publicKey = null;

export async function initJwtMiddleware() {
  const res = await axios.get(`${config.authServiceUrl}/jwt/public-key`);
  publicKey = await importSPKI(res.data.public_key, 'RS256');
  console.log(`JWT public key loaded from AuthService (algorithm: ${res.data.algorithm})`);
}

export function getPublicKey() {
  return publicKey;
}

// Map a jose jwtVerify rejection to a specific 401 message via its error `.code`.
export function mapJwtError(err) {
  switch (err?.code) {
    case 'ERR_JWT_EXPIRED':
      return 'Token expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'Invalid token signature';
    case 'ERR_JWT_INVALID':
    case 'ERR_JWS_INVALID':
      return 'Malformed token';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return 'Token validation failed';
    default:
      return 'Invalid or expired JWT';
  }
}

export function authJwt(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  if (!publicKey) {
    return res.status(503).json({ error: 'JWT public key not yet available' });
  }
  const token = authHeader.slice(7);
  jwtVerify(token, publicKey, { algorithms: ['RS256'] })
    .then(({ payload }) => {
      req.user = payload;
      next();
    })
    .catch((err) => res.status(401).json({ error: mapJwtError(err) }));
}
