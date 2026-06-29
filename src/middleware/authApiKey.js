import { verifyApiKey } from '../services/apiKeyService.js';

export async function authApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key && await verifyApiKey(key)) return next();
  return res.status(401).json({ error: 'Invalid or missing API key' });
}
