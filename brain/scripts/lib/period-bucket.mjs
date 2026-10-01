// period-bucket.mjs — pure period bucketing for brain-metrics (issue #324/M9,
// design D8). No I/O, no process access — a pure function of its two inputs.

/**
 * ISO 8601 week number (1-53) for a UTC Date, per the "week containing the
 * year's first Thursday" rule. Standard algorithm: shift to the nearest
 * Thursday (ISO weeks start Monday), then count weeks from that year's
 * January 1st.
 *
 * @param {Date} date  A valid Date (UTC fields only are read).
 * @returns {{ isoYear: number, isoWeek: number }}
 */
function isoWeekOf(date) {
  // Copy, normalized to UTC midnight, so day-of-week math never sees local tz.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay(): 0=Sunday..6=Saturday. ISO day: 1=Monday..7=Sunday.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Move to the Thursday of this ISO week — the ISO week's year is defined by
  // whichever calendar year that Thursday falls in.
  d.setUTCDate(d.getUTCDate() + (4 - isoDay));
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

/**
 * Bucket an ISO timestamp into a period key.
 *
 *   month → 'YYYY-MM'    (UTC calendar month)
 *   week  → 'YYYY-Www'   (ISO 8601 week, year-of-week — not calendar year)
 *
 * Fail-closed (design D2 policy applies at the caller): an unparseable
 * timestamp or an unrecognized period throws rather than silently
 * misbucketing a merge into the wrong period.
 *
 * @param {string} iso     An ISO 8601 timestamp (e.g. `%cI` git format).
 * @param {'month'|'week'} [period]  Defaults to 'month'.
 * @returns {string}
 */
export function bucketOf(iso, period = 'month') {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`bucketOf: invalid date "${iso}" — cannot bucket an unparseable timestamp`);
  }

  if (period === 'month') {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  if (period === 'week') {
    const { isoYear, isoWeek } = isoWeekOf(date);
    return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
  }

  throw new Error(`bucketOf: unrecognized period "${period}" — expected 'month' or 'week'`);
}
