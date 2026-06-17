import { getRepos as fetchFromProvider } from '../clients/gitClient.js';

let cache = null;
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    cache = await fetchFromProvider();
  } catch (err) {
    // error details already logged inside the client
    console.warn('[RepoCache] Background refresh failed, serving stale cache');
  } finally {
    refreshing = false;
  }
}

export async function init() {
  console.log('[RepoCache] Loading repositories on startup...');
  try {
    cache = await fetchFromProvider();
    console.log('[RepoCache] Ready.');
  } catch (err) {
    console.warn('[RepoCache] Initial load failed — cache is empty until next refresh');
  }
}

export function getRepos() {
  refresh(); // fire-and-forget background refresh
  return cache ?? [];
}
