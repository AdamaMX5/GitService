import { timingSafeCompare } from '../utils/timingSafeCompare.js';
import { config } from '../config.js';

export function authApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !timingSafeCompare(key, config.apiKey)) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}
