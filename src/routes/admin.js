import { Router } from 'express';
import { authAdmin } from '../middleware/authAdmin.js';
import { generateApiKey, listApiKeys, revokeApiKey } from '../services/apiKeyService.js';
import { isValidName } from '../utils/validation.js';

const router = Router();
router.use(authAdmin);

// Create a named API key. The plaintext key is returned exactly once.
router.post('/admin/api-keys', async (req, res) => {
  const { name } = req.body;
  if (!isValidName(name)) {
    return res.status(400).json({ error: 'name must be a string between 1 and 100 characters' });
  }
  try {
    const result = await generateApiKey({ name, createdBy: req.user?.email });
    res.status(201).json(result);
  } catch (err) {
    console.error('POST /admin/api-keys error:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// List API key metadata (never exposes hashes or plaintext keys).
router.get('/admin/api-keys', async (req, res) => {
  try {
    const keys = await listApiKeys();
    res.json(keys);
  } catch (err) {
    console.error('GET /admin/api-keys error:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// Revoke an API key by id.
router.delete('/admin/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await revokeApiKey(id);
    if (!result) {
      return res.status(404).json({ error: 'API key not found' });
    }
    res.json(result);
  } catch (err) {
    console.error(`DELETE /admin/api-keys/${id} error:`, err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

export default router;
