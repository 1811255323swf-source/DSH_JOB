// Email composition: one message per run, HTML + plain-text alternative.
const TIER_LABEL = { 优先投: '优先投', 长期备选: '长期备选', 冲刺: '冲刺', 观察: '观察' };

export function buildSubject(dateStr, count) {
  return `C++ 后端实习机会｜${dateStr}｜${count} 个重点岗位`;
}

function fmtDate(iso) {
  if (!iso) return '未标注';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function jobToText(job, index, { brief = false } = {}) {
  const lines = [];
  lines.push(`${index + 1}. [${TIER_LABEL[job.tier] || job.tier}] ${job.company}｜${job.title}`);
  lines.push(`   地点：${job.city || job.location || '未标注'}${job.locationTier === '远程' ? '（远程）' : ''}`);
  if (brief) {
    lines.push(`   核心要求：${(job.coreRequirements || job.description || '').slice(0, 200) || '未标注'}`);
    lines.push(`   链接：${job.url}`);
    return lines.join('\n');
  }
  lines.push(`   公司规模/类型：${job.companyType || '未标注'}${job.companyMeta?.length ? `（${job.companyMeta.join('、')}）` : ''}`);
  lines.push(`   发布时间/最近确认：${job.publishOrUpdateDate || job.refreshDate || `本轮采集确认 ${fmtDate(job.collectedAt)}`}`);
  lines.push(`   链接：${job.url}`);
  lines.push(`   学历/届次：${job.educationAndCohort || job.education || '未标注'}${job.cohortTokens?.length ? `（${job.cohortTokens.join('/')}）` : ''}`);
  lines.push(`   实习时长/每周到岗：${job.durationNote && job.durationNote !== '未标注' ? job.durationNote : job.durationText || '未标注'}`);
  lines.push(`   核心技术要求：${(job.coreRequirements || job.description || '未标注').slice(0, 400)}`);
  lines.push(`   匹配点：${job.matchPoints?.length ? job.matchPoints.join('、') : '基础能力可迁移'}`);
  lines.push(`   需补强：${job.gaps?.length ? job.gaps.join('；') : '暂无明确缺口'}`);
  lines.push(`   学校/学历门槛：${job.schoolGate}`);
  lines.push(`   为什么值得关注：${job.whyWorth}`);
  return lines.join('\n');
}

export function buildEmail({ jobs, dateStr, profile, note = '' }) {
  const subject = buildSubject(dateStr, jobs.length);
  const wuhan = jobs.filter((j) => j.locationTier === '武汉').length;

  const textHeader = [
    `本轮共筛选出 ${jobs.length} 个值得重点关注的实习岗位（其中武汉 ${wuhan} 个）。`,
    note ? note : '',
    `候选人：${profile.candidate.school} ${profile.candidate.major} ${profile.candidate.degree}｜${profile.candidate.graduationYear} 届`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const text = `${textHeader}\n${jobs.map((j, i) => jobToText(j, i)).join('\n\n')}\n\n--\n本邮件由云端定时任务 cpp-intern-radar 自动生成。\n`;

  const briefText = `${textHeader}\n${jobs.map((j, i) => jobToText(j, i, { brief: true })).join('\n\n')}\n\n--\ncpp-intern-radar（纯文本简版重试）\n`;

  const rows = jobs
    .map((j, i) => {
      const tierColor = j.tier === '优先投' ? '#0a7d33' : j.tier === '冲刺' ? '#b45309' : '#1d4ed8';
      return `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 14px">
    <div style="font-size:16px;font-weight:700;margin-bottom:6px">
      ${i + 1}. ${escapeHtml(j.company)}｜${escapeHtml(j.title)}
      <span style="font-size:12px;color:#fff;background:${tierColor};border-radius:6px;padding:2px 8px;margin-left:6px">${escapeHtml(
        TIER_LABEL[j.tier] || j.tier
      )}</span>
    </div>
    <table style="font-size:13px;line-height:1.7;color:#111827;border-collapse:collapse">
      ${row('地点', `${escapeHtml(j.city || j.location || '未标注')}${j.locationTier === '远程' ? '（远程）' : ''}`)}
      ${row('公司规模/类型', escapeHtml(`${j.companyType || '未标注'}${j.companyMeta?.length ? `（${j.companyMeta.join('、')}）` : ''}`))}
      ${row('发布时间/最近确认', escapeHtml(j.publishOrUpdateDate || j.refreshDate || `本轮采集确认 ${fmtDate(j.collectedAt)}`))}
      ${row('链接', `<a href="${escapeAttr(j.url)}">${escapeHtml(j.url)}</a>`)}
      ${row(
        '学历/届次',
        escapeHtml(`${j.educationAndCohort || j.education || '未标注'}${j.cohortTokens?.length ? `（${j.cohortTokens.join('/')}）` : ''}`)
      )}
      ${row('实习时长/每周到岗', escapeHtml(j.durationNote && j.durationNote !== '未标注' ? j.durationNote : j.durationText || '未标注'))}
      ${row('核心技术要求', escapeHtml((j.coreRequirements || j.description || '未标注').slice(0, 500)))}
      ${row('匹配点', escapeHtml((j.matchPoints || []).join('、') || '基础能力可迁移'))}
      ${row('需补强', escapeHtml((j.gaps || []).join('；') || '暂无明确缺口'))}
      ${row('学校/学历门槛', escapeHtml(j.schoolGate))}
      ${row('为什么值得关注', escapeHtml(j.whyWorth))}
    </table>
  </div>`;
    })
    .join('\n');

  const html = `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827">
  <p style="font-size:14px;line-height:1.8">本轮共筛选出 <b>${jobs.length}</b> 个值得重点关注的实习岗位（其中武汉 <b>${wuhan}</b> 个）。</p>
  ${note ? `<p style="font-size:13px;color:#6b7280;line-height:1.7">${escapeHtml(note)}</p>` : ''}
  <p style="font-size:13px;color:#6b7280;line-height:1.7">候选人：${escapeHtml(profile.candidate.school)} ${escapeHtml(
    profile.candidate.major
  )} ${escapeHtml(profile.candidate.degree)}｜${profile.candidate.graduationYear} 届</p>
  ${rows}
  <p style="font-size:12px;color:#9ca3af">由云端定时任务 cpp-intern-radar 自动生成</p>
</body></html>`;

  return { subject, text, html, briefText };
}

function row(label, value) {
  return `<tr><td style="padding:2px 10px 2px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:2px 0">${value}</td></tr>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
