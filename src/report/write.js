// Report writer: JSON (machine) + Markdown (human), Beijing-time file names.
import fs from 'node:fs';
import path from 'node:path';
import { beijingStamp, beijingDateString } from '../lib/time.js';

export function writeReport({ outDir, runAt = new Date(), collected, scored, selected, mail, errors = [], stats = {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = beijingStamp(runAt);
  const base = path.join(outDir, `report-${stamp}`);
  const payload = {
    runAt: runAt.toISOString(),
    beijingDate: beijingDateString(runAt),
    stats,
    collectedCount: collected.length,
    scoredCount: scored.length,
    selectedCount: selected.length,
    mail: mail || null,
    errors,
    selected: selected.map((j) => ({
      tier: j.tier,
      score: j.score,
      company: j.company,
      title: j.title,
      city: j.city,
      url: j.url,
      source: j.sourceLabel || j.source,
      companyType: j.companyType,
      schoolGate: j.schoolGate,
      durationNote: j.durationNote,
      matchPoints: j.matchPoints,
      gaps: j.gaps,
      whyWorth: j.whyWorth,
      publishOrUpdateDate: j.publishOrUpdateDate || j.refreshDate || '',
    })),
    allScored: scored.map((j) => ({
      title: j.title,
      company: j.company,
      city: j.city,
      score: j.score,
      tier: j.tier,
      url: j.url,
      excluded: j.excludedReason || '',
    })),
  };
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const md = renderMarkdown(payload, selected);
  fs.writeFileSync(`${base}.md`, md, 'utf8');
  return { jsonPath: `${base}.json`, mdPath: `${base}.md`, stamp };
}

function renderMarkdown(payload, selected) {
  const lines = [];
  lines.push(`# C++ 实习机会扫描报告（${payload.beijingDate}）`);
  lines.push('');
  lines.push(
    `- 运行时间（北京）：${new Date(payload.runAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
  );
  lines.push(`- 采集原始岗位：${payload.collectedCount}｜进入打分：${payload.scoredCount}｜入选：${payload.selectedCount}`);
  if (payload.stats?.bySource) {
    lines.push(`- 来源分布：${Object.entries(payload.stats.bySource).map(([k, v]) => `${k} ${v}`).join('，')}`);
  }
  if (payload.mail) {
    lines.push(
      `- 邮件：${payload.mail.sent ? '✅ 已发送' : payload.mail.draft ? '📝 已存入 Gmail 草稿' : '❌ 未发送'}${
        payload.mail.messageId ? `（id: ${payload.mail.messageId}）` : ''
      }${payload.mail.error ? `｜原因：${payload.mail.error}` : ''}`
    );
  }
  lines.push('');
  lines.push('## 本轮重点岗位');
  lines.push('');
  for (const [i, j] of selected.entries()) {
    lines.push(`### ${i + 1}. ${j.company}｜${j.title}　\`${j.tier}\`（评分 ${j.score}）`);
    lines.push('');
    lines.push(`- 地点：${j.city || '未标注'}${j.locationTier === '远程' ? '（远程）' : ''}`);
    lines.push(`- 公司类型/规模：${j.companyType || '未标注'}`);
    lines.push(`- 学历/届次：${j.educationAndCohort || j.education || '未标注'}`);
    lines.push(`- 时长/每周到岗：${j.durationNote && j.durationNote !== '未标注' ? j.durationNote : '未标注'}`);
    lines.push(`- 发布时间/确认：${j.publishOrUpdateDate || j.refreshDate || `本轮采集确认`}`);
    lines.push(`- 链接：${j.url}`);
    lines.push(`- 核心要求：${(j.coreRequirements || j.description || '').slice(0, 300) || '未标注'}`);
    lines.push(`- 匹配点：${(j.matchPoints || []).join('、') || '基础能力可迁移'}`);
    lines.push(`- 需补强：${(j.gaps || []).join('；') || '暂无'}`);
    lines.push(`- 学校门槛：${j.schoolGate}`);
    lines.push(`- 为什么值得关注：${j.whyWorth}`);
    lines.push('');
  }
  if (payload.errors?.length) {
    lines.push('## 运行告警');
    lines.push('');
    for (const e of payload.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  return lines.join('\n');
}

export { beijingStamp };
