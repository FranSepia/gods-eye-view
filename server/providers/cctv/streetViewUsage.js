import fs from 'node:fs';
import path from 'node:path';

/**
 * Street View Static usage meter and spend guard.
 *
 * Street View is the fallback frame for every camera with no feed of its own —
 * which is EVERY camera in the Mexico pack — and the frame routes carry
 * `Cache-Control: no-store`, so one visible camera is one billable Google
 * request per refresh (10s active, 60s idle). Twenty cameras left on screen
 * overnight is tens of thousands of calls. Google does not stop at the free
 * tier; it bills past it.
 *
 * So this module does two things:
 *   1. Counts requests actually SENT to Street View, per Pacific day and
 *      Pacific month (the clock Google Maps Platform resets quotas on).
 *   2. Refuses the call once the day's cap is reached, so the ceiling holds
 *      even when nobody configured the quota in the Cloud console. A refused
 *      call is not an error — the frame route falls through to the synthetic
 *      placeholder exactly as it does when no key is configured at all.
 *
 * The count is a conservative upper bound: a request is counted when it is
 * sent, not when it returns an image, because a caller deciding whether to
 * spend money should err toward over-reporting.
 */

/** Street View Static calls included free each month (Google, 2026). */
export const STREETVIEW_FREE_TIER_CALLS = 10_000;
/**
 * Default daily ceiling. 300/day x 31 days = 9,300, which stays under the
 * 10,000 free tier in every month — so a default install cannot be billed for
 * Street View no matter how long the app is left open.
 */
export const STREETVIEW_DEFAULT_DAILY_CAP = 300;
/** Coalesce disk writes; the counter is updated far faster than it is read. */
const PERSIST_DEBOUNCE_MS = 2000;

/**
 * Current date in Google's quota timezone, as {day:'YYYY-MM-DD', month:'YYYY-MM'}.
 * Maps Platform resets daily quotas at midnight Pacific, so counting on UTC
 * days would roll over at the wrong moment and misreport the cap.
 *
 * @param {number} epochMs
 * @returns {{day: string, month: string}}
 */
export function pacificPeriods(epochMs) {
  // en-CA renders ISO-shaped YYYY-MM-DD, which slices cleanly.
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
  return { day, month: day.slice(0, 7) };
}

/**
 * Resolve the daily cap from the environment.
 * A non-positive value disables the guard (counting continues).
 *
 * @param {string|undefined} raw
 * @returns {number} Cap, or 0 when disabled.
 */
export function resolveDailyCap(raw) {
  if (raw === undefined || String(raw).trim() === '') {
    return STREETVIEW_DEFAULT_DAILY_CAP;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return STREETVIEW_DEFAULT_DAILY_CAP;
  if (value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Create the usage meter.
 *
 * @param {{cacheDir?: string, now?: () => number, env?: object}} [options]
 * @returns {{record: () => void, allow: () => boolean, snapshot: () => object,
 *   flush: () => void}}
 */
export function createStreetViewUsage({
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const file = path.join(cacheDir, 'streetview-usage.json');
  /** @type {{day: string, month: string, dayCount: number, monthCount: number}} */
  let state = { day: '', month: '', dayCount: 0, monthCount: 0 };
  let persistTimer = null;
  let dirty = false;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state = {
        day: String(parsed.day || ''),
        month: String(parsed.month || ''),
        dayCount: Number(parsed.dayCount) || 0,
        monthCount: Number(parsed.monthCount) || 0,
      };
    }
  } catch {
    // No prior file, or an unreadable one: start the period at zero. Losing a
    // count is safe in the honest direction — the cap simply allows the
    // remainder of today again, never more than a full day's worth.
  }

  /** Roll the day/month buckets forward when the Pacific clock has moved on. */
  const rollPeriods = () => {
    const { day, month } = pacificPeriods(now());
    if (state.day !== day) {
      state.day = day;
      state.dayCount = 0;
      dirty = true;
    }
    if (state.month !== month) {
      state.month = month;
      state.monthCount = 0;
      dirty = true;
    }
  };

  const writeNow = () => {
    if (!dirty) return;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state), 'utf8');
      dirty = false;
    } catch {
      // A read-only cache dir must not break frame serving; the counter then
      // lives only in memory for this process.
    }
  };

  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeNow();
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the process open for a counter write.
    persistTimer.unref?.();
  };

  return {
    /** Whether another Street View request is within today's cap. */
    allow() {
      rollPeriods();
      const cap = resolveDailyCap(env.STREETVIEW_DAILY_CAP);
      return cap === 0 || state.dayCount < cap;
    },

    /** Count one request sent to Street View. */
    record() {
      rollPeriods();
      state.dayCount += 1;
      state.monthCount += 1;
      dirty = true;
      schedulePersist();
    },

    /** Serializable view for the HUD meter. */
    snapshot() {
      rollPeriods();
      const cap = resolveDailyCap(env.STREETVIEW_DAILY_CAP);
      const keyConfigured = Boolean(
        env.GOOGLE_MAPS_SERVER_API_KEY || env.GOOGLE_MAPS_API_KEY,
      );
      return {
        day: state.day,
        month: state.month,
        dayCount: state.dayCount,
        monthCount: state.monthCount,
        dailyCap: cap,
        freeTier: STREETVIEW_FREE_TIER_CALLS,
        // What the meter exists to answer: is anything being spent, and is the
        // guard the thing holding it back?
        capped: cap > 0 && state.dayCount >= cap,
        keyConfigured,
        timezone: 'America/Los_Angeles',
      };
    },

    /** Write immediately (tests, shutdown). */
    flush() {
      writeNow();
    },
  };
}
