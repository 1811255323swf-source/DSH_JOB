// De-duplication ledger: remembers every posting that has already been reported/emailed
// so that each run only mails genuinely new opportunities.
import fs from 'node:fs';
import path from 'node:path';
import { jobIdentity, urlIdentity, normText } from '../filter/score.js';

const EMPTY = { version: 1, updatedAt: null, entries: {} };

export function ledgerPath(rootDir) {
  return path.join(rootDir, 'state', 'sent-jobs.json');
}

export function loadLedger(rootDir) {
  const file = ledgerPath(rootDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { ...EMPTY };
    return { ...EMPTY, ...parsed, entries: parsed.entries || {} };
  } catch {
    return { ...EMPTY };
  }
}

export function saveLedger(rootDir, ledger) {
  const file = ledgerPath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { ...ledger, version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

export function ledgerKeys(job) {
  const keys = [`id:${job.id}`];
  const u = urlIdentity(job);
  if (u) keys.push(`url:${u}`);
  const coarse = `${normText(job.company).toLowerCase().replace(/\s/g, '')}|${normText(job.title).toLowerCase().replace(/\s/g, '')}`;
  keys.push(`ct:${coarse}`);
  return keys;
}

export function isSeen(ledger, job) {
  return ledgerKeys(job).some((k) => ledger.entries[k]);
}

export function markSeen(ledger, job, meta = {}) {
  const stamp = new Date().toISOString();
  for (const key of ledgerKeys(job)) {
    if (!ledger.entries[key]) {
      ledger.entries[key] = {
        company: job.company,
        title: job.title,
        city: job.city,
        url: job.url,
        tier: job.tier,
        firstSeenAt: stamp,
        ...meta,
      };
    }
  }
  return ledger;
}

export function splitNewSeen(jobs, ledger) {
  const fresh = [];
  const seen = [];
  for (const job of jobs) (isSeen(ledger, job) ? seen : fresh).push(job);
  return { fresh, seen };
}
