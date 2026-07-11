/**
 * Real (executable) unit tests for parseSessionLimitResetTime in
 * verboseClaudeRunner.js.
 *
 * When Claude exhausts its session quota it prints e.g.
 * "You've hit your session limit · resets 23:20 (Europe/Berlin)". Parsing that
 * reset time lets the queue pause exactly until the quota returns (plus a
 * buffer) instead of always waiting the fixed fallback delay.
 *
 * Contract under test (see the source doc comment):
 *  - 24h and 12h (am/pm) clock formats both parse.
 *  - Only IANA zone identifiers (containing "/") are accepted; bare
 *    abbreviations like CET/PST are rejected (ambiguous via Intl).
 *  - The result is always the NEXT future instant matching that wall-clock time
 *    in the named zone (rolls to tomorrow when the time already passed today).
 *  - Malformed / missing text and unresolvable zones return null; never throws.
 *
 * A referenceDate is injected so "today vs tomorrow" is deterministic. Assertions
 * check the invariant that matters — the returned instant, read back in the
 * target zone, shows the requested wall-clock HH:MM and lies in the future —
 * which stays correct across DST and hemisphere without hardcoding UTC offsets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionLimitResetTime } from '../src/verboseClaudeRunner.js';

// The wall-clock date+time the given instant shows in `zone` (24h, HH:MM).
function zoneParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  let hour = g('hour');
  if (hour === '24') hour = '00'; // some engines render midnight as 24
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hm: `${hour}:${g('minute')}` };
}

// 02:00 in Europe/Berlin (CEST, summer) — a fixed, DST-defined reference so the
// "already passed today → tomorrow" rollover is deterministic.
const REF_SUMMER = new Date('2026-07-11T00:00:00Z');

describe('parseSessionLimitResetTime — 24h and 12h formats', () => {
  it('parses a 24h time in an IANA zone', () => {
    const r = parseSessionLimitResetTime('resets 23:20 (Europe/Berlin)', REF_SUMMER);
    assert.ok(r instanceof Date);
    assert.equal(zoneParts(r, 'Europe/Berlin').hm, '23:20');
    assert.ok(r.getTime() > REF_SUMMER.getTime(), 'must be in the future');
  });

  it('parses a 12h pm time to the same instant as its 24h equivalent', () => {
    const pm = parseSessionLimitResetTime('resets 11:20pm (Europe/Berlin)', REF_SUMMER);
    const h24 = parseSessionLimitResetTime('resets 23:20 (Europe/Berlin)', REF_SUMMER);
    assert.equal(pm.getTime(), h24.getTime());
    assert.equal(zoneParts(pm, 'Europe/Berlin').hm, '23:20');
  });

  it('maps 12:xxam to 00:xx (midnight)', () => {
    const r = parseSessionLimitResetTime('resets 12:15am (Europe/Berlin)', REF_SUMMER);
    assert.equal(zoneParts(r, 'Europe/Berlin').hm, '00:15');
  });

  it('maps 12:xxpm to 12:xx (noon)', () => {
    const r = parseSessionLimitResetTime('resets 12:00pm (America/New_York)', REF_SUMMER);
    assert.equal(zoneParts(r, 'America/New_York').hm, '12:00');
  });

  it('extracts the notice embedded in a fuller session-limit line', () => {
    const r = parseSessionLimitResetTime(
      "You've hit your session limit · resets 09:00 (Australia/Sydney)",
      REF_SUMMER,
    );
    assert.equal(zoneParts(r, 'Australia/Sydney').hm, '09:00');
    assert.ok(r.getTime() > REF_SUMMER.getTime());
  });
});

describe('parseSessionLimitResetTime — day rollover', () => {
  it('rolls to the NEXT day when the reset time already passed today', () => {
    // At 02:00 Berlin, 01:30 today is already past → must resolve to tomorrow.
    const r = parseSessionLimitResetTime('resets 01:30 (Europe/Berlin)', REF_SUMMER);
    const today = zoneParts(REF_SUMMER, 'Europe/Berlin').date;
    const got = zoneParts(r, 'Europe/Berlin');
    assert.equal(got.hm, '01:30');
    assert.notEqual(got.date, today, 'must not be today (already passed)');
    assert.ok(r.getTime() > REF_SUMMER.getTime());
  });

  it('stays TODAY when the reset time is still ahead', () => {
    const r = parseSessionLimitResetTime('resets 23:45 (Europe/Berlin)', REF_SUMMER);
    const today = zoneParts(REF_SUMMER, 'Europe/Berlin').date;
    assert.equal(zoneParts(r, 'Europe/Berlin').date, today);
  });
});

describe('parseSessionLimitResetTime — DST correctness', () => {
  it('honors winter (CET) wall-clock time', () => {
    const refWinter = new Date('2026-01-15T08:00:00Z');
    const r = parseSessionLimitResetTime('resets 20:00 (Europe/Berlin)', refWinter);
    assert.equal(zoneParts(r, 'Europe/Berlin').hm, '20:00');
  });

  it('honors summer (CEST) wall-clock time on a fall-back day', () => {
    const refFall = new Date('2026-10-25T00:30:00Z'); // Berlin DST ends this day
    const r = parseSessionLimitResetTime('resets 05:00 (Europe/Berlin)', refFall);
    assert.equal(zoneParts(r, 'Europe/Berlin').hm, '05:00');
  });

  it('never throws on a spring-forward non-existent local time', () => {
    // 02:30 on 2026-03-29 does not exist in Berlin (clocks jump 02:00→03:00).
    const refSpring = new Date('2026-03-29T00:30:00Z');
    let r;
    assert.doesNotThrow(() => { r = parseSessionLimitResetTime('resets 02:30 (Europe/Berlin)', refSpring); });
    assert.ok(r instanceof Date && r.getTime() > refSpring.getTime(), 'still yields a future instant');
  });
});

describe('parseSessionLimitResetTime — rejects unusable input (returns null, never throws)', () => {
  it('rejects bare (non-IANA) zone abbreviations', () => {
    assert.equal(parseSessionLimitResetTime('resets 14:30 (CET)', REF_SUMMER), null);
    assert.equal(parseSessionLimitResetTime('resets 14:30 (PST)', REF_SUMMER), null);
  });

  it('rejects an IANA-shaped but unresolvable zone without throwing', () => {
    let r;
    assert.doesNotThrow(() => { r = parseSessionLimitResetTime('resets 14:30 (Foo/Bar)', REF_SUMMER); });
    assert.equal(r, null);
  });

  it('rejects text with no reset timestamp', () => {
    assert.equal(parseSessionLimitResetTime('You have hit your session limit', REF_SUMMER), null);
    assert.equal(parseSessionLimitResetTime('no reset info here', REF_SUMMER), null);
  });

  it('rejects out-of-range hour/minute', () => {
    assert.equal(parseSessionLimitResetTime('resets 25:00 (Europe/Berlin)', REF_SUMMER), null);
    assert.equal(parseSessionLimitResetTime('resets 14:99 (Europe/Berlin)', REF_SUMMER), null);
  });

  it('returns null for empty / nullish input', () => {
    assert.equal(parseSessionLimitResetTime('', REF_SUMMER), null);
    assert.equal(parseSessionLimitResetTime(null, REF_SUMMER), null);
    assert.equal(parseSessionLimitResetTime(undefined, REF_SUMMER), null);
  });
});
