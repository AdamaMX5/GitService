import axios from 'axios';
import { config } from './config.js';
import { getAccessToken } from './auth.js';

export async function fetchOpenIssues() {
  // Prefer API-key auth when configured (standalone mode).
  // Otherwise use the GITCLIENT JWT obtained from the AuthService.
  const headers = config.gitServiceApiKey
    ? { 'X-API-Key': config.gitServiceApiKey }
    : { Authorization: `Bearer ${await getAccessToken()}` };

  const res = await axios.get(`${config.gitServiceUrl}/issues`, { headers });
  return res.data;
}
