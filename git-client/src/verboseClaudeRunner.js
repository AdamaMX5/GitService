#!/usr/bin/env node
// Standalone entry point invoked from the generated Windows launcher .bat
// (see launchWindows in runner.js). Wraps `claude -p --verbose
// --output-format stream-json`, reading the prompt from the file given as
// argv[2], and re-prints each streamed event as a short human-readable line.
//
// Why this exists: plain `claude -p --verbose` with the default text output
// format prints NOTHING until the run is fully finished — verified against a
// real `claude` invocation, the flag has no effect on print-mode's text
// format. Only `--output-format stream-json` actually streams per-turn
// events, but those are raw JSON lines, unreadable in a plain console window.
// This script turns them back into plain text so the launcher window shows
// live progress instead of a blank screen followed by one final line.
//
// Exits with claude's own exit code so the calling .bat's `errorlevel` check
// still reflects the real outcome (tool-use/text formatting failures here
// must never mask or change that exit code).
//
// The module is import-side-effect-free: the streaming wrapper only runs when
// this file is executed directly (see the main-module guard at the bottom), so
// unit tests can import matchesSessionLimit without spawning `claude`.
import { spawn } from 'node:child_process';
import { createReadStream, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SESSION_LIMIT_EXIT_CODE } from './exitCodes.js';

// Claude prints e.g. "You've hit your session limit · resets 14:30 (CET)" when
// the session quota is exhausted. That is a temporary, expected state (not a
// real failure), so we detect it and signal it up via a distinct exit code the
// launcher/queue can react to (retry later) instead of pausing forever.
// Narrow phrase ("hit your session limit") rather than a bare "session limit":
// the broader match false-positives on reflected issue content, which — paired
// with a forced non-zero exit — could pause the whole queue for hours.
const SESSION_LIMIT_RE = /hit your session limit/i;

// Captures "resets 11:20pm (Europe/Berlin)" / "resets 23:20 (Europe/Berlin)":
// hour, minute, optional am/pm, and a parenthesised zone. All quantifiers are
// bounded (no unbounded \s* before "(") to avoid catastrophic backtracking on
// long whitespace runs; 60 chars covers any real IANA zone identifier.
const RESET_TIME_RE = /resets\s{1,4}(\d{1,2}):(\d{2})\s{0,4}([ap]m)?\s{0,4}\(([^)]{1,60})\)/i;

// A genuine session-limit notice is short; scanning arbitrarily long input is
// both pointless and a ReDoS vector, so both entry points cap at 500 chars.
const MAX_NOTICE_SCAN = 500;

// Pure predicate: true when `text` contains Claude's session-limit notice.
export function matchesSessionLimit(text) {
  return !!text && SESSION_LIMIT_RE.test(text.slice(0, MAX_NOTICE_SCAN));
}

// Reads the wall-clock components of `instant` as seen in the given IANA zone.
function zoneParts(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(instant);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value, 10);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some engines render midnight as 24
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour, minute: get('minute'), second: get('second'),
  };
}

// Converts a wall-clock time (interpreted in `zone`) to the matching UTC Date.
// Two-phase: guess the instant as if the wall clock were UTC, see how that
// instant actually reads in the zone, then correct by the observed offset.
function wallClockToUtc(year, month, day, hour, minute, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const p = zoneParts(new Date(naive), zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - naive;
  return new Date(naive - offset);
}

// Pure function: parses Claude's "resets HH:MM(am/pm) (Zone)" notice into the
// next future Date that matches that wall-clock time in the named zone, or null
// if the text has no parsable timestamp. Only IANA identifiers (containing "/",
// e.g. Europe/Berlin) are accepted — bare abbreviations like CET/PST cannot be
// resolved reliably via Intl, so we bail rather than guess. Never throws.
export function parseSessionLimitResetTime(text, referenceDate = new Date()) {
  if (!text) return null;
  const m = RESET_TIME_RE.exec(text.slice(0, MAX_NOTICE_SCAN));
  if (!m) return null;
  const zone = m[4].trim();
  if (!zone.includes('/')) return null;

  try {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const ampm = m[3] ? m[3].toLowerCase() : null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;

    // Today's date as seen in the target zone (RangeError here on a bad zone).
    const today = zoneParts(referenceDate, zone);
    let candidate = wallClockToUtc(today.year, today.month, today.day, hour, minute, zone);
    if (candidate.getTime() <= referenceDate.getTime()) {
      const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      candidate = wallClockToUtc(
        tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(),
        hour, minute, zone,
      );
    }
    return candidate;
  } catch {
    return null;
  }
}

function shortInput(input) {
  const s = JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function main() {
  let sessionLimitHit = false;
  let resetAt = null;
  let lastAssistantText = null;

  const checkSessionLimit = (text) => {
    if (matchesSessionLimit(text)) {
      sessionLimitHit = true;
      const parsed = parseSessionLimitResetTime(text);
      if (parsed) resetAt = parsed;
    }
  };

  const promptFile = process.argv[2];
  if (!promptFile) {
    console.error('usage: node verboseClaudeRunner.js <promptFile>');
    process.exit(1);
  }

  function printEvent(event) {
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          lastAssistantText = block.text.trim();
          checkSessionLimit(lastAssistantText);
          console.log(lastAssistantText);
        } else if (block.type === 'tool_use') {
          console.log(`→ ${block.name} ${shortInput(block.input)}`);
        }
      }
    } else if (event.type === 'result') {
      console.log('');
      console.log('='.repeat(50));
      // The final assistant text block was already printed above as it streamed
      // in — only print event.result here if it differs (e.g. an error result).
      if (event.result && event.result !== lastAssistantText) {
        checkSessionLimit(event.result);
        console.log(event.result);
      }
    }
  }

  const child = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const promptStream = createReadStream(promptFile);
  promptStream.on('error', err => {
    console.error(`Failed to read prompt file: ${err.message}`);
    process.exitCode = 1;
    child.kill();
  });
  // EPIPE if claude exits before fully consuming stdin — not our failure to report.
  child.stdin.on('error', () => {});
  promptStream.pipe(child.stdin);

  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    try {
      printEvent(JSON.parse(line));
    } catch {
      // Not a JSON event line — print verbatim rather than silently dropping it.
      // The session-limit notice may arrive here (raw) rather than as a parsed
      // stream-json event, so both paths must be checked.
      checkSessionLimit(line);
      console.log(line);
    }
  });

  child.on('close', code => {
    // A non-zero exit that coincided with the session-limit notice is reported as
    // the dedicated code so the launcher retries instead of pausing on an error.
    if (code !== 0 && sessionLimitHit) {
      process.exitCode = SESSION_LIMIT_EXIT_CODE;
      // Hand the parsed reset time to runner.js via a fixed-name file in the
      // prompt's tmpDir (runner reads then deletes it). Best-effort: a write
      // failure just falls back to the queue's fixed retry delay.
      if (resetAt) {
        try {
          writeFileSync(
            join(dirname(promptFile), 'session-limit-reset-at.json'),
            JSON.stringify({ resetAtIso: resetAt.toISOString() }),
          );
        } catch {
          // best-effort — nothing to do if the file can't be written
        }
      }
    } else {
      process.exitCode = code ?? 1;
    }
  });

  child.on('error', err => {
    console.error(`Failed to start claude: ${err.message}`);
    process.exitCode = 1;
  });
}

// Only run the streaming wrapper when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
