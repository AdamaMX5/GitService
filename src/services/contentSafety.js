// Heuristic scanner that flags issue title/body likely to contain prompt-injection
// or otherwise malicious content before it reaches the autonomous GitClient poller.
// This is a best-effort filter, not a claim of completeness.

const PATTERNS = [
  // Prompt-injection / jailbreak phrasing
  { pattern: /ignore\b[\s\S]{0,30}?instructions?/i, reason: 'prompt-injection-phrase' },
  { pattern: /disregard\s+(the\s+)?(above|previous|prior)/i, reason: 'prompt-injection-phrase' },
  { pattern: /ignoriere\s+(alle\s+)?(vorherigen\s+)?anweisungen/i, reason: 'prompt-injection-phrase' },
  { pattern: /du\s+bist\s+jetzt/i, reason: 'prompt-injection-phrase' },
  { pattern: /you\s+are\s+now/i, reason: 'prompt-injection-phrase' },
  { pattern: /new\s+instructions?\s*:/i, reason: 'prompt-injection-phrase' },
  { pattern: /neue\s+anweisungen?\s*:/i, reason: 'prompt-injection-phrase' },
  { pattern: /act\s+as\s+an?\s+(unrestricted|jailbroken|dan)/i, reason: 'prompt-injection-phrase' },
  { pattern: /do\s+anything\s+now/i, reason: 'prompt-injection-phrase' },

  // Attempts to extract secrets / system prompt
  { pattern: /(reveal|print|show)\s+(your|the)\s+(system\s+prompt|instructions|api\s*key|password|secret)/i, reason: 'credential-exfiltration' },
  { pattern: /cat\s+\.env/i, reason: 'credential-exfiltration' },
  { pattern: /process\.env/i, reason: 'credential-exfiltration' },
  { pattern: /dump\s+credentials/i, reason: 'credential-exfiltration' },

  // Destructive command patterns
  { pattern: /rm\s+-rf/i, reason: 'destructive-command' },
  { pattern: /(force\s+push|git\s+push\s+--force|push\s+--force)/i, reason: 'destructive-command' },
  { pattern: /drop\s+table/i, reason: 'destructive-command' },
  { pattern: /drop\s+database/i, reason: 'destructive-command' },

  // Hidden/invisible unicode characters used to smuggle instructions past human review:
  // soft hyphen (U+00AD), zero-width space/joiner/non-joiner (U+200B-U+200D),
  // LRM/RLM (U+200E-U+200F), bidi embedding/override/pop-directional-formatting
  // (U+202A-U+202E), word joiner (U+2060), BOM (U+FEFF), variation selectors
  // (U+FE00-U+FE0F), and Unicode Tag characters (U+E0000-U+E007F) used in "ASCII smuggling"
  { pattern: new RegExp('[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufe00-\\ufe0f\\ufeff\\u{e0000}-\\u{e007f}]', 'u'), reason: 'hidden-unicode' },
];

/**
 * Scans issue title + body for heuristics commonly associated with prompt-injection
 * attempts or malicious/destructive instructions targeting an autonomous coding agent.
 *
 * @param {string} title
 * @param {string} body
 * @returns {{ flagged: boolean, reasons: string[] }}
 */
export function scanIssueContent(title, body) {
  const text = `${title || ''}\n${body || ''}`;
  const reasons = [];

  for (const { pattern, reason } of PATTERNS) {
    if (pattern.test(text) && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }

  return { flagged: reasons.length > 0, reasons };
}
