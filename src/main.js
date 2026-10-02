#!/usr/bin/env node
// cpp-intern-radar — cloud-scheduled internship radar for a C++/Linux/network-oriented
// undergraduate. Collects postings, scores them against the candidate profile, de-dupes
// against everything already reported, and mails genuinely new high-value roles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectZhaopin, enrichZhaopinDetail } from './collect/zhaopin.js';
import { collectShixiseng, enrichShixisengDetail } from './collect/shixiseng.js';
import { scoreJob, dedupeJobs, rankJobs, selectForReport, hardExcluded, normText } from './filter/score.js';
import { loadLedger, saveLedger, splitNewSeen, markSeen } from './dedupe/ledger.js';
import { buildEmail } from './mail/compose.js';
import { sendMail, buildRawMessage } from './mail/smtp.js';
import { appendDraft } from './mail/imap-draft.js';
import { writeReport } from './report/write.js';
import { beijingDateString, beijingStamp } from './lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIREMENT_HEADINGS = /(任职资格|任职要求|岗位要求|职位要求|任职条件|我们希望你|要求如下|资格要求)/;

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    task: 'scan',
    dryRun: false,
    outDir: path.join(ROOT, 'output'),
    root: ROOT,
    limit: Number(process.env.RESULT_LIMIT || 10),
    min: Number(process.env.RESULT_MIN || 6),
    enrich: Number(process.env.ENRICH_LIMIT || 60),
    mail: true,
    log: () => {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--min') args.min = Number(argv[++i]);
    else if (a === '--enrich') args.enrich = Number(argv[++i]);
    else if (a === '--no-mail') args.mail = false;
    else if (a === '--curated') args.curated = path.resolve(argv[++i]);
    else if (a === '--curated-only') args.curatedOnly = true;
    else if (a === '--dump-mail') args.dumpMail = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function extractRequirements(description) {
  const text = normText(description);
  if (!text) return '';
  const m = text.match(REQUIREMENT_HEADINGS);
  if (m && typeof m.index === 'number') {
    return text.slice(m.index, m.index + 700).replace(REQUIREMENT_HEADINGS, '').trim();
  }
  return text.slice(0, 500);
}

/** Normalise a raw posting from any collector into the common shape. */
export function normalizeJob(raw) {
  const isSx = raw.source === 'shixiseng';
  const education = isSx ? raw.degree || '' : raw.education || '';
  const description = raw.description || '';
  const cohortTokens = [...new Set(((description + ' ' + (raw.title || '')).match(/20(2[5-9])届/g) || []))];
  return {
    ...raw,
    company: normText(raw.company),
    title: normText(raw.title),
    city: normText(raw.city || raw.location || ''),
    education,
    months: raw.months || '',
    daysPerWeek: raw.daysPerWeek || '',
    durationText: raw.durationText || [raw.months, raw.daysPerWeek].filter(Boolean).join(' / '),
    coreRequirements: extractRequirements(description),
    publishOrUpdateDate: raw.publishOrUpdateDate || raw.refreshDate || '',
    educationAndCohort: [
      education || '学历未标注',
      cohortTokens.length ? cohortTokens.join('/') : raw.deadline ? `届次未明确（截止 ${raw.deadline}）` : '届次未明确',
    ].join('；'),
    collectedAt: raw.collectedAt || new Date().toISOString(),
  };
}

/** Cheap pre-filter so we only spend detail-page requests on plausible roles. */
export function preFilter(jobs, keywords) {
  return jobs.filter((job) => {
    if (hardExcluded(job, keywords)) return false;
    const text = `${job.title} ${(job.tags || []).join(' ')} ${job.query || ''}`;
    const hit =
      keywords.direction.strong.some((t) => text.includes(t)) || keywords.direction.medium.some((t) => text.includes(t));
    return hit;
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runScan(args, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const profile = readJson(path.join(ROOT, 'config', 'profile.json'));
  const keywords = readJson(path.join(ROOT, 'config', 'keywords.json'));
  const sources = readJson(path.join(ROOT, 'config', 'sources.json'));
  const errors = [];
  const runAt = deps.now || new Date();

  log(`▶ cpp-intern-radar 扫描开始（北京时间 ${beijingDateString(runAt)}）`);

  if (args.curatedOnly && !args.curated) {
    throw new Error('--curated-only 必须与 --curated <清单文件> 一起使用');
  }

  if (args.dryRun) {
    const plan = [
      `智联招聘：${sources.zhaopin.queries.length} 组关键词/城市组合`,
      `实习僧：${sources.shixiseng.queries.length} 组关键词/城市组合`,
      `富化上限：${args.enrich} 个详情页｜结果目标：${args.min}-${args.limit} 个`,
      `去重台账：${path.join(args.root, 'state', 'sent-jobs.json')}`,
      `邮件：${args.mail ? '启用（GMAIL_USER/GMAIL_APP_PASSWORD）' : '关闭'}`,
    ];
    for (const p of plan) log(`  · ${p}`);
    return { dryRun: true, plan };
  }

  // ---------- 1. collect ----------
  let raw = [];
  if (args.curatedOnly) {
    // Hand-verified round: skip the network entirely. The curated file already carries the
    // researched postings, so a cloud first run is deterministic and finishes in seconds —
    // a GitHub runner abroad may not be able to reach 智联/实习僧 listing pages at all.
    const parsed = JSON.parse(fs.readFileSync(args.curated, 'utf8'));
    raw = (Array.isArray(parsed) ? parsed : parsed.jobs || []).map((j) => ({ ...j, curated: true }));
    log(`  清单模式（--curated-only）：跳过联网采集，直接使用 ${raw.length} 个已核实岗位`);
  } else {
    if (sources.zhaopin.enabled) {
      raw = raw.concat(await collectZhaopin(sources.zhaopin.queries, { fetchImpl, log }));
    }
    if (sources.shixiseng.enabled) {
      // 实习僧 titles are font-obfuscated, so always enrich them before trusting text.
      raw = raw.concat(await collectShixiseng(sources.shixiseng.queries, { fetchImpl, log }));
    }
  }
  log(`  采集原始条目：${raw.length}`);

  // ---------- 2. pre-filter + enrich ----------
  const normalized = raw.map(normalizeJob);
  // collapse repeat cards collected by several keyword queries so the enrichment
  // budget is spent on distinct postings
  const seenUrls = new Set();
  const unique = normalized.filter((j) => {
    const key = (j.url || `${j.company}|${j.title}`).split('?')[0];
    if (seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
  const plausible = args.curatedOnly ? unique : preFilter(unique, keywords);
  log(`  去重后候选：${unique.length}，方向初筛后：${plausible.length}`);

  // rank both sources by an early keyword signal (武汉 first), then interleave so one
  // source cannot starve the other of detail-page budget
  const quickScore = (j) => {
    const hay = `${j.title} ${(j.tags || []).join(' ')} ${j.query || ''}`;
    let s =
      keywords.direction.strong.filter((t) => hay.includes(t)).length * 3 +
      keywords.direction.medium.filter((t) => hay.includes(t)).length;
    if (/武汉/.test(j.city || '')) s += 5;
    return s;
  };
  const byQuick = (list) => [...list].sort((a, b) => quickScore(b) - quickScore(a));
  const sxRanked = byQuick(plausible.filter((j) => j.source === 'shixiseng'));
  const zpRanked = byQuick(plausible.filter((j) => j.source === 'zhaopin'));
  let enriched;
  if (args.curatedOnly) {
    log('  清单模式：跳过详情页富化（核实内容已随清单提供）');
    enriched = plausible;
  } else {
    const sxQuota = Math.min(sxRanked.length, Math.ceil(args.enrich / 2));
    const zpQuota = Math.max(0, Math.min(zpRanked.length, args.enrich - sxQuota));
    const toEnrich = [...zpRanked.slice(0, zpQuota), ...sxRanked.slice(0, sxQuota)];
    log(`  进入详情富化：${toEnrich.length}（智联 ${zpQuota}，实习僧 ${sxQuota}）`);

    enriched = await mapLimit(toEnrich, deps.concurrency || 4, async (job) => {
      try {
        if (job.source === 'zhaopin') return normalizeJob(await enrichZhaopinDetail(job, { fetchImpl }));
        return normalizeJob(await enrichShixisengDetail(job, { fetchImpl }));
      } catch (err) {
        errors.push(`富化失败 ${job.company}/${job.title}：${err.message}`);
        return job;
      }
    });
  }

  // ---------- 3. score ----------
  const scoredAll = enriched.map((job) => {
    const scored = scoreJob(job, profile, keywords);
    const reason = hardExcluded(job, keywords);
    if (reason) return { ...scored, excludedReason: reason };
    return scored;
  });
  const excluded = scoredAll.filter((j) => j.excludedReason);
  const kept = scoredAll.filter((j) => !j.excludedReason);
  log(`  打分完成：保留 ${kept.length}，排除 ${excluded.length}`);

  // ---------- 4. cross-platform dedupe + rank ----------
  const deduped = dedupeJobs(kept);
  const ranked = rankJobs(deduped, profile);
  let selected;
  if (args.curated) {
    // A hand-verified round: the file holds the postings that were researched and
    // confirmed manually, so it takes precedence over automatic selection.
    const parsedCurated = JSON.parse(fs.readFileSync(args.curated, 'utf8'));
    const curatedRaw = Array.isArray(parsedCurated) ? parsedCurated : parsedCurated.jobs || [];
    if (!Array.isArray(parsedCurated) && parsedCurated.note) args.mailNote = parsedCurated.note;
    const CURATED_WINS = [
      'tier',
      'score',
      'schoolGate',
      'durationNote',
      'matchPoints',
      'gaps',
      'whyWorth',
      'companyType',
      'locationTier',
      'coreRequirements',
      'educationAndCohort',
      'publishOrUpdateDate',
      'companyMeta',
      'description',
    ];
    const curatedScored = curatedRaw.map((j) => {
      const scored = scoreJob(normalizeJob({ ...j, curated: true }), profile, keywords);
      const overrides = {};
      for (const key of CURATED_WINS) if (j[key] !== undefined) overrides[key] = j[key];
      return { ...scored, ...overrides };
    });
    selected = curatedScored.filter((j) => !hardExcluded(j, keywords));
    log(`  使用人工核实清单：${selected.length} 个岗位（${args.curated}）`);
  } else {
    selected = selectForReport(ranked.filter((j) => j.tier !== '观察'), { min: args.min, target: args.limit });
  }

  // ---------- 5. de-dupe against previously reported jobs ----------
  const ledger = loadLedger(args.root);
  const { fresh, seen } = splitNewSeen(selected, ledger);
  log(`  与历史台账去重：新岗位 ${fresh.length}，已推送过 ${seen.length}`);

  const stats = {
    bySource: kept.reduce((acc, j) => {
      const k = j.sourceLabel || j.source;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    byTier: deduped.reduce((acc, j) => {
      acc[j.tier] = (acc[j.tier] || 0) + 1;
      return acc;
    }, {}),
    wuhan: deduped.filter((j) => j.locationTier === '武汉').length,
    priority: deduped.filter((j) => j.tier === '优先投').length,
  };

  let mailResult = null;
  const shouldMail = args.mail && fresh.length > 0 && (deps.sendMailImpl || process.env.GMAIL_APP_PASSWORD);
  if (args.mail && fresh.length === 0) {
    log('  本轮没有新岗位，跳过邮件（符合「至少有 1 个新岗位才发信」规则）');
    mailResult = { sent: false, skipped: true, reason: 'no-new-jobs' };
  } else if (args.mail && !shouldMail) {
    log('  缺少 GMAIL_APP_PASSWORD，无法发送邮件，仅生成本地报告');
    mailResult = { sent: false, skipped: true, reason: 'missing-credentials' };
  }

  const dateStr = beijingDateString(runAt);
  const composed = buildEmail({ jobs: fresh, dateStr, profile, note: args.mailNote || '' });
  if (args.dumpMail) {
    fs.mkdirSync(path.dirname(args.dumpMail), { recursive: true });
    fs.writeFileSync(args.dumpMail, `主题：${composed.subject}\n\n${composed.text}\n`, 'utf8');
    log(`  邮件预览已写入：${args.dumpMail}`);
  }

  if (shouldMail) {
    mailResult = await deliverMail({ composed, fresh, args, log, profile });
  }

  // ---------- 6. report ----------
  const report = writeReport({
    outDir: args.outDir,
    runAt,
    collected: normalized,
    scored: scoredAll,
    selected,
    mail: mailResult,
    errors,
    stats,
  });
  log(`  报告已写入：${report.mdPath}`);

  // ---------- 7. ledger (only mark what was actually reported by mail) ----------
  if (mailResult?.sent || mailResult?.draft) {
    for (const job of fresh) markSeen(ledger, job, { notifiedAt: new Date().toISOString(), channel: mailResult.sent ? 'smtp' : 'draft' });
    const file = saveLedger(args.root, ledger);
    log(`  台账已更新：${file}（累计 ${Object.keys(ledger.entries).length} 条键）`);
  } else if (args.mail === false) {
    log('  未发信（--no-mail），台账保持不变');
  }

  return { report, selected, fresh, seen, mailResult, stats, composed };
}

async function deliverMail({ composed, fresh, args, log }) {
  const user = process.env.GMAIL_USER || '1811255323swf@gmail.com';
  const password = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.MAIL_TO || user;
  const fromName = process.env.MAIL_FROM_NAME || 'C++ 实习雷达';
  const sendImpl = globalThis.__testSendMailImpl || sendMail;

  const raw = buildRawMessage({ from: user, fromName, to, subject: composed.subject, text: composed.text, html: composed.html });
  log(`  发送邮件 → ${to}｜主题：${composed.subject}`);
  let result = await sendImpl({ user, password, to, rawMessage: raw });
  const transcriptTail = (result.transcript || []).slice(-3).join(' | ');
  if (result.ok) {
    log(`  ✅ 发送成功（服务器确认）：${transcriptTail}`);
    return { sent: true, messageId: result.messageId || '', status: result.status, transcript: result.transcript, attempts: 1 };
  }
  // Connection-level failures (blocked 465, TLS reset) get a second chance on 587 + STARTTLS;
  // protocol/auth failures go straight to the plain-text retry.
  const connIssue = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|连接超时|socket hang up|EPIPE/i.test(
    `${result.error || ''} ${result.status || ''}`
  );
  log(`  ⚠️ 首次发送失败：${result.error || result.status}${connIssue ? '（连接层问题，改用 587 + STARTTLS）' : ''}，用纯文本简版重试一次`);

  const rawBrief = buildRawMessage({
    from: user,
    fromName,
    to,
    subject: composed.subject,
    text: composed.briefText,
    html: `<pre style="font-family:ui-monospace,Consolas,monospace;font-size:13px;white-space:pre-wrap">${composed.briefText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</pre>`,
  });
  result = await sendImpl(
    connIssue
      ? { user, password, to, rawMessage: rawBrief, port: 587, useStartTls: true }
      : { user, password, to, rawMessage: rawBrief }
  );
  if (result.ok) {
    log(`  ✅ 纯文本简版重试成功：${(result.transcript || []).slice(-3).join(' | ')}`);
    return { sent: true, messageId: result.messageId || '', status: result.status, transcript: result.transcript, attempts: 2, plainTextFallback: true };
  }
  log(`  ❌ 重试仍失败：${result.error || result.status}，改为写入 Gmail 草稿`);

  const draft = await appendDraft({ user, password, rawMessage: raw });
  if (draft.ok) {
    log('  📝 已写入 Gmail 草稿箱（[Gmail]/Drafts）');
    return { sent: false, draft: true, draftMailbox: draft.draftMailbox, error: result.error || result.status, attempts: 2 };
  }
  log(`  ❌ 草稿写入也失败：${draft.error}`);
  return {
    sent: false,
    draft: false,
    error: `SMTP：${result.error || result.status}；IMAP 草稿：${draft.error}`,
    attempts: 2,
    jobs: fresh.map((j) => ({ company: j.company, title: j.title, city: j.city, requirements: j.coreRequirements, url: j.url })),
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`cpp-intern-radar\n\n用法：\n  node src/main.js --task scan [--dry-run] [--limit 10] [--min 6] [--enrich 60] [--no-mail] [--out dir]\n  node src/main.js --task scan --curated data/round-YYYY-MM-DD.json [--curated-only]\n    人工核实清单轮：--curated-only 表示完全不联网（跳过采集与详情富化），\n    云端首轮发信建议用它，秒级完成且不受 GitHub runner 网络位置影响。\n\n环境变量：\n  GMAIL_USER / GMAIL_APP_PASSWORD / MAIL_TO / MAIL_FROM_NAME\n`);
    return 0;
  }
  if (args.task === 'collect-only') args.mail = false;
  try {
    const result = await runScan(args);
    if (result?.dryRun) return 0;
    const failures = (result.report && result.report.errors?.length) || 0;
    if (result.mailResult && result.mailResult.sent === false && result.mailResult.skipped !== true) return 1;
    return failures > 3 ? 1 : 0;
  } catch (err) {
    console.error(`✖ 运行失败：${err.stack || err.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
