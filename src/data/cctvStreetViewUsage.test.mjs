import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createStreetViewUsage,
  pacificPeriods,
  resolveDailyCap,
  STREETVIEW_DEFAULT_DAILY_CAP,
  STREETVIEW_FREE_TIER_CALLS,
} from '../../server/providers/cctv/streetViewUsage.js';
import {
  describeStreetViewUsage,
  formatMeterCount,
  createStreetViewMeter,
} from '../layers/cctv/streetViewMeter.js';

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// 2026-01-15T12:00Z is 04:00 Pacific the same day; 2026-01-15T03:00Z is still
// the 14th in Pacific. Both matter: the cap resets on Google's clock.
const NOON_UTC = Date.parse('2026-01-15T12:00:00Z');
const EARLY_UTC = Date.parse('2026-01-15T03:00:00Z');

test('periods follow the Pacific clock, not UTC', () => {
  assert.deepEqual(pacificPeriods(NOON_UTC), {
    day: '2026-01-15',
    month: '2026-01',
  });
  // 03:00 UTC is 19:00 the previous day in Los Angeles — counting on UTC days
  // would roll the cap over seven hours early.
  assert.deepEqual(pacificPeriods(EARLY_UTC), {
    day: '2026-01-14',
    month: '2026-01',
  });
});

test('the default cap can never leave the free tier', () => {
  // The whole point of the default: 31 full days still sits under the monthly
  // allowance, so an untouched install cannot be billed.
  assert.ok(STREETVIEW_DEFAULT_DAILY_CAP * 31 < STREETVIEW_FREE_TIER_CALLS);
});

test('resolveDailyCap reads the env, with 0 meaning unlimited', () => {
  assert.equal(resolveDailyCap(undefined), STREETVIEW_DEFAULT_DAILY_CAP);
  assert.equal(resolveDailyCap(''), STREETVIEW_DEFAULT_DAILY_CAP);
  assert.equal(resolveDailyCap('nonsense'), STREETVIEW_DEFAULT_DAILY_CAP);
  assert.equal(resolveDailyCap('50'), 50);
  assert.equal(resolveDailyCap('50.9'), 50);
  assert.equal(resolveDailyCap('0'), 0);
  assert.equal(resolveDailyCap('-5'), 0);
});

test('the guard stops the day at the cap and reopens the next day', (t) => {
  let now = NOON_UTC;
  const usage = createStreetViewUsage({
    cacheDir: tmpDir(t),
    now: () => now,
    env: { STREETVIEW_DAILY_CAP: '3', GOOGLE_MAPS_SERVER_API_KEY: 'k' },
  });

  for (let i = 0; i < 3; i++) {
    assert.equal(usage.allow(), true, `call ${i + 1} should be allowed`);
    usage.record();
  }
  assert.equal(usage.allow(), false, 'the fourth call is refused');
  assert.equal(usage.snapshot().capped, true);
  assert.equal(usage.snapshot().dayCount, 3);

  // Next Pacific day: the day resets, the month keeps accumulating.
  now += 24 * 60 * 60 * 1000;
  assert.equal(usage.allow(), true);
  const snapshot = usage.snapshot();
  assert.equal(snapshot.dayCount, 0);
  assert.equal(snapshot.monthCount, 3);
  assert.equal(snapshot.capped, false);
});

test('a zero cap counts without ever refusing', (t) => {
  const usage = createStreetViewUsage({
    cacheDir: tmpDir(t),
    now: () => NOON_UTC,
    env: { STREETVIEW_DAILY_CAP: '0' },
  });
  for (let i = 0; i < 50; i++) {
    assert.equal(usage.allow(), true);
    usage.record();
  }
  assert.equal(usage.snapshot().dayCount, 50);
  assert.equal(usage.snapshot().capped, false);
});

test('the month resets on a Pacific month boundary', (t) => {
  let now = NOON_UTC;
  const usage = createStreetViewUsage({
    cacheDir: tmpDir(t),
    now: () => now,
    env: {},
  });
  usage.record();
  usage.record();
  assert.equal(usage.snapshot().monthCount, 2);

  now = Date.parse('2026-02-03T12:00:00Z');
  const snapshot = usage.snapshot();
  assert.equal(snapshot.month, '2026-02');
  assert.equal(snapshot.monthCount, 0);
  assert.equal(snapshot.dayCount, 0);
});

test('the count survives a restart', (t) => {
  const dir = tmpDir(t);
  const first = createStreetViewUsage({
    cacheDir: dir,
    now: () => NOON_UTC,
    env: { STREETVIEW_DAILY_CAP: '10' },
  });
  for (let i = 0; i < 7; i++) first.record();
  first.flush();

  // A restart must not hand the user a fresh budget — that is how an
  // overnight loop would spend past the cap one restart at a time.
  const second = createStreetViewUsage({
    cacheDir: dir,
    now: () => NOON_UTC,
    env: { STREETVIEW_DAILY_CAP: '10' },
  });
  assert.equal(second.snapshot().dayCount, 7);
  assert.equal(second.snapshot().monthCount, 7);
  for (let i = 0; i < 3; i++) {
    assert.equal(second.allow(), true);
    second.record();
  }
  assert.equal(second.allow(), false);
});

test('an unreadable cache starts clean instead of throwing', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'streetview-usage.json'), '{not json', 'utf8');
  const usage = createStreetViewUsage({
    cacheDir: dir,
    now: () => NOON_UTC,
    env: {},
  });
  assert.equal(usage.snapshot().dayCount, 0);
  assert.equal(usage.allow(), true);
});

test('the snapshot reports whether a key is even configured', (t) => {
  const dir = tmpDir(t);
  const without = createStreetViewUsage({
    cacheDir: dir,
    now: () => NOON_UTC,
    env: {},
  });
  assert.equal(without.snapshot().keyConfigured, false);

  const withServerKey = createStreetViewUsage({
    cacheDir: tmpDir(t),
    now: () => NOON_UTC,
    env: { GOOGLE_MAPS_API_KEY: 'AIza-browser' },
  });
  assert.equal(withServerKey.snapshot().keyConfigured, true);
});

// ---------------------------------------------------------------------------
// HUD meter
// ---------------------------------------------------------------------------

test('formatMeterCount keeps the HUD line narrow', () => {
  assert.equal(formatMeterCount(0), '0');
  assert.equal(formatMeterCount(842), '842');
  assert.equal(formatMeterCount(1000), '1K');
  assert.equal(formatMeterCount(1234), '1.2K');
  assert.equal(formatMeterCount(10_000), '10K');
  assert.equal(formatMeterCount(12_400), '12K');
});

test('the meter hides itself when nothing can be spent', () => {
  assert.equal(describeStreetViewUsage(null).visible, false);
  assert.equal(
    describeStreetViewUsage({ keyConfigured: false, dayCount: 0 }).visible,
    false,
  );
});

test('the meter escalates from quiet to warn to capped', () => {
  const base = {
    keyConfigured: true,
    dailyCap: 300,
    freeTier: 10_000,
    monthCount: 100,
  };

  const quiet = describeStreetViewUsage({ ...base, dayCount: 42 });
  assert.equal(quiet.visible, true);
  assert.equal(quiet.level, '');
  assert.match(quiet.text, /SV: 42\/300 TODAY/);
  assert.match(quiet.text, /100\/10K MO/);

  // 80% of the daily cap is the warning line.
  assert.equal(describeStreetViewUsage({ ...base, dayCount: 239 }).level, '');
  assert.equal(
    describeStreetViewUsage({ ...base, dayCount: 240 }).level,
    'warn',
  );

  // Approaching the monthly free tier warns even on a quiet day.
  assert.equal(
    describeStreetViewUsage({ ...base, dayCount: 1, monthCount: 8000 }).level,
    'warn',
  );

  const capped = describeStreetViewUsage({
    ...base,
    dayCount: 300,
    capped: true,
  });
  assert.equal(capped.level, 'capped');
  assert.match(capped.text, /CAP REACHED/);
});

test('an uncapped meter reports the raw count without a denominator', () => {
  const view = describeStreetViewUsage({
    keyConfigured: true,
    dailyCap: 0,
    freeTier: 10_000,
    dayCount: 1500,
    monthCount: 4200,
  });
  assert.match(view.text, /SV: 1.5K TODAY/);
  assert.doesNotMatch(view.text, /\/0/);
});

test('the meter writes the HUD element and survives a failed read', async () => {
  const el = {
    hidden: true,
    textContent: '',
    _classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) el._classes.add(name);
        else el._classes.delete(name);
      },
    },
  };
  const doc = { getElementById: (id) => (id === 'hud-streetview' ? el : null) };

  let payload = {
    keyConfigured: true,
    dayCount: 250,
    dailyCap: 300,
    monthCount: 900,
    freeTier: 10_000,
  };
  let shouldFail = false;
  const fetchImpl = async () => {
    if (shouldFail) throw new Error('offline');
    return { ok: true, json: async () => payload };
  };

  const meter = createStreetViewMeter({
    fetchImpl,
    doc,
    setInterval: () => null,
    clearInterval: () => {},
  });
  await meter.refresh();
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /SV: 250\/300 TODAY/);
  assert.ok(el._classes.has('warn'));

  // A dropped read leaves the last good value on screen rather than blanking
  // the gauge — a meter that flickers to empty would read as "spent nothing".
  shouldFail = true;
  const before = el.textContent;
  await meter.refresh();
  assert.equal(el.textContent, before);
  assert.equal(el.hidden, false);

  // Stopping clears the readout: no frames flow once the layer is off, so a
  // lingering number would read as money still being spent.
  meter.stop();
  assert.equal(el.hidden, true);
});

test('stopping tolerates a document without getElementById', () => {
  // The layer teardown runs under stub documents in tests and under none on
  // the server; neither may throw out of disable().
  for (const doc of [undefined, {}, { getElementById: undefined }]) {
    const meter = createStreetViewMeter({
      fetchImpl: async () => {
        throw new Error('offline');
      },
      doc,
      setInterval: () => null,
      clearInterval: () => {},
    });
    assert.doesNotThrow(() => meter.stop());
  }
});
