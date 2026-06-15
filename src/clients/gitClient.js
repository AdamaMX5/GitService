import * as github from './githubClient.js';
import * as gitea from './giteaClient.js';
import { config } from '../config.js';

const client = config.gitProvider === 'github' ? github : gitea;

export const {
  getRepos,
  getIssue,
  createIssue,
  createComment,
  closeIssue,
  listOpenIssues,
} = client;
