import axios from 'axios';
import { config } from '../config.js';

const http = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

const owner = config.github.owner;

export async function getRepos() {
  const res = await http.get(`/orgs/${owner}/repos`, { params: { per_page: 100, type: 'all' } });
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
  const res = await http.post(`/repos/${owner}/${repo}/issues`, { title, body, labels });
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
    params: { state: 'open', per_page: 100 },
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
