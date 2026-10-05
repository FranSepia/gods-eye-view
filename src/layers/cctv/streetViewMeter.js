/**
 * Street View spend meter for the HUD.
 *
 * Every camera without its own feed draws its frame from Google Street View,
 * and those calls are billable past a monthly free tier. The server counts
 * them and caps the day (server/providers/cctv/streetViewUsage.js); this reads
 * that count onto the HUD so the spend is visible while it happens rather than
 * on next month's invoice.
 *
 * The readout hides itself entirely when no Google key is configured, because
 * then nothing can be spent and an always-zero gauge is just noise.
 */

/** How often the meter re-reads the server counter. */
export const STREETVIEW_METER_POLL_MS = 15_000;
/** Day-usage fraction at which the readout starts warning. */
const WARN_AT = 0.8;

/**
 * Compact count for the HUD ("842", "1.2K", "10K").
 * @param {number} value
 * @returns {string}
 */
export function formatMeterCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  // One decimal below 10K ("1.2K"), none above ("12K") — the line is narrow.
  return thousands < 10
    ? `${thousands.toFixed(1).replace(/\.0$/, '')}K`
    : `${Math.round(thousands)}K`;
}

/**
 * Render one usage snapshot into HUD text plus a severity level.
 *
 * @param {object|null} snapshot Server payload, or null when unavailable.
 * @returns {{visible: boolean, text: string, level: ''|'warn'|'capped'}}
 */
export function describeStreetViewUsage(snapshot) {
  if (!snapshot || !snapshot.keyConfigured) {
    return { visible: false, text: '', level: '' };
  }

  const dayCount = Number(snapshot.dayCount) || 0;
  const monthCount = Number(snapshot.monthCount) || 0;
  const dailyCap = Number(snapshot.dailyCap) || 0;
  const freeTier = Number(snapshot.freeTier) || 0;

  const today = dailyCap
    ? `${formatMeterCount(dayCount)}/${formatMeterCount(dailyCap)}`
    : formatMeterCount(dayCount);
  const month = freeTier
    ? `${formatMeterCount(monthCount)}/${formatMeterCount(freeTier)}`
    : formatMeterCount(monthCount);

  let level = '';
  if (snapshot.capped) level = 'capped';
  else if (dailyCap && dayCount >= dailyCap * WARN_AT) level = 'warn';
  else if (freeTier && monthCount >= freeTier * WARN_AT) level = 'warn';

  const suffix = snapshot.capped ? '  · CAP REACHED' : '';
  return {
    visible: true,
    text: `SV: ${today} TODAY  ${month} MO${suffix}`,
    level,
  };
}

/**
 * Start polling the server meter and writing it to the HUD.
 *
 * @param {{fetchImpl?: typeof fetch, doc?: Document,
 *   intervalMs?: number, setInterval?: Function, clearInterval?: Function}} [options]
 * @returns {{stop: () => void, refresh: () => Promise<void>}}
 */
export function createStreetViewMeter({
  fetchImpl = (...args) => globalThis.fetch(...args),
  doc = globalThis.document,
  intervalMs = STREETVIEW_METER_POLL_MS,
  setInterval: setIntervalImpl = globalThis.setInterval,
  clearInterval: clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  let timer = null;
  let stopped = false;

  const apply = (snapshot) => {
    const el = doc?.getElementById?.('hud-streetview');
    if (!el) return;
    const view = describeStreetViewUsage(snapshot);
    el.hidden = !view.visible;
    if (!view.visible) return;
    el.textContent = view.text;
    el.classList.toggle('warn', view.level === 'warn');
    el.classList.toggle('capped', view.level === 'capped');
  };

  const refresh = async () => {
    try {
      const resp = await fetchImpl('/api/cctv/streetview-usage');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!stopped) apply(await resp.json());
    } catch {
      // The meter is an observability extra: a failed read leaves the last
      // good value on screen rather than blanking it or surfacing an error.
    }
  };

  refresh();
  timer = setIntervalImpl(refresh, intervalMs);
  timer?.unref?.();

  return {
    refresh,
    /** Stop polling and clear the readout. */
    stop() {
      stopped = true;
      if (timer) clearIntervalImpl(timer);
      timer = null;
      // Optional-call throughout: callers include a layer teardown that runs
      // under a stub document in tests and under none at all on the server.
      const el = doc?.getElementById?.('hud-streetview');
      if (el) el.hidden = true;
    },
  };
}
