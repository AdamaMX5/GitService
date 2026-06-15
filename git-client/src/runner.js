import { spawn } from 'child_process';
import { config } from './config.js';

export function startClaude(issue) {
  const cwd = config.repoPaths[issue.repo];
  if (!cwd) {
    console.warn(`[runner] No local path configured for repo "${issue.repo}" — skipping issue #${issue.number}`);
    return;
  }

  const prompt = [
    `Bearbeite diesen Issue mit dem Agent Team aus der CLAUDE.md: ${issue.url}`,
    ``,
    `Team-Struktur:`,
    `- Software-Experte: implementiert den Fix/das Feature`,
    `- Test-Experte: liest den Issue, leitet Akzeptanzkriterien ab, schreibt Tests (Backend: VERIFIED, Frontend: PLAUSIBLE)`,
    `- Sicherheits-Experte: auditiert alle neuen Endpunkte und Auth-Flows`,
    `- Code-Review-Experte: gibt finale Freigabe erst nach OK von Test- und Security-Agent, dann Push nach main`,
    ``,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body,
  ].join('\n');

  console.log(`[runner] Starting Claude for ${issue.repo}#${issue.number}: ${issue.title}`);

  const child = spawn('claude', ['-p', prompt], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('close', code => {
    if (code !== 0) {
      console.warn(`[runner] Claude exited with code ${code} for ${issue.repo}#${issue.number}`);
    } else {
      console.log(`[runner] Claude finished ${issue.repo}#${issue.number}`);
    }
  });

  child.on('error', err => {
    console.error(`[runner] Failed to start Claude for ${issue.repo}#${issue.number}:`, err.message);
  });
}
