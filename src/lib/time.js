// Beijing-time helpers. The runner may sit in any timezone (GitHub Actions = UTC),
// so every human-facing date is computed explicitly against Asia/Shanghai.
const BEIJING_OFFSET_MINUTES = 8 * 60;

export function beijingNow(now = new Date()) {
  return new Date(now.getTime() + (BEIJING_OFFSET_MINUTES + now.getTimezoneOffset()) * 60_000);
}

export function beijingDateString(now = new Date()) {
  const d = beijingNow(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function beijingStamp(now = new Date()) {
  const d = beijingNow(now);
  const date = beijingDateString(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${date}-${hh}${mm}${ss}`;
}

// "最近 7 天内" style freshness judgement used by the report to prefer new postings.
export function daysSince(isoOrText, now = new Date()) {
  if (!isoOrText) return null;
  const t = Date.parse(isoOrText);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}
