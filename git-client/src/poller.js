import axios from 'axios';
import { config } from './config.js';

export async function fetchOpenIssues() {
  const headers = config.gitServiceApiKey
    ? { 'X-API-Key': config.gitServiceApiKey }
    : {};

  const res = await axios.get(`${config.gitServiceUrl}/issues`, { headers });
  return res.data;
}
