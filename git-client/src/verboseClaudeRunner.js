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
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const promptFile = process.argv[2];
if (!promptFile) {
  console.error('usage: node verboseClaudeRunner.js <promptFile>');
  process.exit(1);
}

function shortInput(input) {
  const s = JSON.stringify(input ?? {});
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

let lastAssistantText = null;

function printEvent(event) {
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim()) {
        lastAssistantText = block.text.trim();
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
    console.log(line);
  }
});

child.on('close', code => {
  process.exitCode = code ?? 1;
});

child.on('error', err => {
  console.error(`Failed to start claude: ${err.message}`);
  process.exitCode = 1;
});
