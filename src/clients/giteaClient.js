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

// Cache label name → id mappings per repo to avoid repeated API calls
const labelCache = new Map();

async function resolveLabelIds(repo, labelNames) {
  if (!labelNames?.length) return [];
  if (!labelCache.has(repo)) {
    const res = await http.get(`/repos/${owner}/${repo}/labels`);
    const map = {};
    for (const l of res.data) map[l.name] = l.id;
    labelCache.set(repo, map);
  }
  const map = labelCache.get(repo);
  return labelNames.map(name => map[name]).filter(id => id !== undefined);
}

export async function getRepos() {
  const res = await http.get(`/orgs/${owner}/repos`, { params: { limit: 50 } });
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
