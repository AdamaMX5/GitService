import axios from 'axios';
import { config } from '../config.js';

const http = axios.create({
  baseURL: `${config.gitea.baseUrl}/api/v1`,
  headers: {
    Authorization: `token ${config.gitea.token}`,
    'Content-Type': 'application/json',
  },
});

const owner = config.gitea.owner;
const ownerType = config.gitea.ownerType;

// Cache label name → id mappings per repo to avoid repeated API calls.
// Entries expire after LABEL_CACHE_TTL_MS to pick up label changes in Gitea.
const LABEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const labelCache = new Map(); // repo → { map: { name: id }, expiresAt: number }

async function resolveLabelIds(repo, labelNames) {
  if (!labelNames?.length) return [];

  const cached = labelCache.get(repo);
  if (!cached || Date.now() > cached.expiresAt) {
    const res = await http.get(`/repos/${owner}/${repo}/labels`);
    const map = {};
    for (const l of res.data) map[l.name] = l.id;
    labelCache.set(repo, { map, expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
  }

  const { map } = labelCache.get(repo);
  return labelNames.map(name => map[name]).filter(id => id !== undefined);
}

export async function getRepos() {
  // Gitea exposes different listing endpoints depending on whether the owner is
  // a personal user account or an organisation.
  const reposPath = ownerType === 'org'
    ? `/orgs/${owner}/repos`
    : `/users/${owner}/repos`;
  const res = await http.get(reposPath, { params: { limit: 50 } });
  return res.data.map(r => ({ name: r.name, fullName: r.full_name, url: r.html_url }));
}

export async function getIssue(repo, number) {
  const res = await http.get(`/repos/${owner}/${repo}/issues/${number}`);
  const d = res.data;
  return {
    number: d.number,
    title: d.title,
    body: d.body || '',
    state: d.state,
    creator: d.user.login,
    url: d.html_url,
  };
}

export async function createIssue(repo, { title, body, labels = [] }) {
  const labelIds = await resolveLabelIds(repo, labels);
  const res = await http.post(`/repos/${owner}/${repo}/issues`, {
    title,
    body,
    labels: labelIds,
  });
  return { number: res.data.number, url: res.data.html_url };
}

export async function createComment(repo, number, body) {
  const res = await http.post(`/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  return { id: res.data.id };
}

export async function closeIssue(repo, number) {
  await http.patch(`/repos/${owner}/${repo}/issues/${number}`, { state: 'closed' });
}

export async function listOpenIssues(repo) {
  const res = await http.get(`/repos/${owner}/${repo}/issues`, {
    params: { state: 'open', limit: 50, type: 'issues' },
  });
  return res.data.map(d => ({
    number: d.number,
    title: d.title,
    body: d.body || '',
    state: d.state,
    creator: d.user.login,
    url: d.html_url,
    repo,
  }));
}
