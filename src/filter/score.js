// Scoring / filtering engine: turns raw postings into ranked, annotated opportunities
// tailored to a non-985/211 undergraduate (2028 cohort) targeting C++/Linux/network/infra work.
import { createHash } from 'node:crypto';
import { daysSince } from '../lib/time.js';

const STALE_DAYS = Number(process.env.STALE_DAYS || 400); // 超过这个天数未刷新的岗位视为过期
const AGING_DAYS = Number(process.env.AGING_DAYS || 180); // 老于这个天数但未过期的岗位降权并提示

const LARGE_COMPANY_HINTS = [
  '10000人以上', '1000-9999人', '已上市', '已融资', '世界500强', '上市公司',
  '字节跳动', '阿里巴巴', '腾讯', '百度', '华为', '美团', '京东', '网易', '小米', '拼多多',
  '快手', '滴滴', '蚂蚁', '快手', '中兴', '大疆', '商汤', '旷视', 'OPPO', 'vivo', '荣耀',
];
const SME_HINTS = [
  '0-20人', '20-99人', '100-499人', '500-999人', '民营', '创业', 'A轮', 'B轮', 'C轮',
  '天使轮', '初创', '中小', '专精特新', '瞪羚', '独角兽',
];
const SKILL_PATTERNS = {
  'C++': /C\+\+|C／C\+\+|C语言|cpp/i,
  '数据结构与算法': /数据结构|算法|STL/i,
  Linux: /Linux|Unix|国产操作系统|麒麟|统信/i,
  'Socket 网络编程': /socket|网络编程|套接字/i,
  '多线程/线程池': /多线程|线程池|并发|pthread|std::thread/i,
  'epoll/IO 多路复用': /epoll|select|poll|IO多路复用|I\/O多路复用|Reactor|Proactor/i,
  'TCP/IP': /TCP|UDP|IP协议|协议栈|三次握手/i,
  '数据库': /数据库|MySQL|PostgreSQL|SQL|Redis|存储引擎/i,
  'Linux 系统编程': /系统编程|系统调用|POSIX|进程间通信|IPC|共享内存/i,
  '网络服务端': /服务端|后端|网关|服务器开发|高并发服务/i,
};
const GAP_LIBRARY = [
  { need: /Reactor|Proactor|IO多路复用|epoll/i, gap: 'Reactor 模型与 epoll ET/LT 实战（写一个万级并发回显服务器）' },
  { need: /TCP|UDP|协议栈|三次握手/i, gap: 'TCP 三次握手/四次挥手、拥塞控制与抓包分析（wireshark + tcpdump）' },
  { need: /MySQL|数据库|SQL|存储引擎/i, gap: 'MySQL 索引与事务 + 手写一个简易 KV 存储' },
  { need: /Redis|缓存/i, gap: 'Redis 常用数据结构与缓存穿透/雪崩处理' },
  { need: /多线程|线程池|并发/i, gap: '线程池实现与 C++11 并发编程（mutex/condition_variable/atomic）' },
  { need: /STL|模板|C\+\+11|C\+\+14|C\+\+17/i, gap: '现代 C++（智能指针、移动语义、模板）与 STL 源码级理解' },
  { need: /Qt|MFC|界面/i, gap: 'Qt 基础控件与信号槽（工业软件/工具类岗位常见要求）' },
  { need: /音视频|RTSP|RTP|H\.264|流媒体/i, gap: 'RTSP/RTP 流媒体协议与 FFmpeg 基础' },
  { need: /Kubernetes|k8s|容器|Docker/i, gap: 'Docker/Kubernetes 基础与容器网络模型' },
  { need: /CUDA|GPU|推理|算子|AI Infra|模型部署/i, gap: 'CUDA 编程入门与 ONNX/TensorRT 推理流程' },
  { need: /驱动|内核|kernel|设备树/i, gap: 'Linux 内核模块与字符设备驱动入门' },
  { need: /DPDK|RDMA|高速网络/i, gap: 'DPDK 无锁收包与用户态协议栈概念' },
  { need: /Go|Golang/i, gap: 'Go 语言基础（部分基础架构团队混用 Go）' },
  { need: /嵌入式|单片机|STM32|MCU/i, gap: '嵌入式 Linux 交叉编译与串口/CAN 通信基础' },
];

export function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function jobIdentity(job) {
  const key = [normText(job.company).toLowerCase(), normText(job.title).toLowerCase(), normText(job.city).slice(0, 6)]
    .join('|')
    .replace(/\s+/g, '');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function urlIdentity(job) {
  const clean = String(job.url || '').split('?')[0].replace(/\/$/, '');
  return clean ? createHash('sha1').update(clean).digest('hex').slice(0, 16) : '';
}

export function jobText(job) {
  return normText(
    [job.title, job.company, job.city, (job.tags || []).join(' '), (job.companyMeta || []).join(' '), job.description, job.location]
      .filter(Boolean)
      .join(' ')
  );
}

function countHits(text, list) {
  const hits = [];
  for (const term of list) {
    if (text.includes(term)) hits.push(term);
  }
  return hits;
}

/** Hard filters: the brief's explicit exclusions. */
export function hardExcluded(job, keywords) {
  const title = normText(job.title);
  const text = jobText(job);
  const titleHit = keywords.negative.hardExclude.find((t) => title.includes(t));
  if (titleHit) return `标题命中排除词「${titleHit}」`;
  // Description dominated by an excluded function (e.g. pure QA / pure ops postings).
  const desc = normText(job.description).slice(0, 1500);
  if (desc) {
    const dq = keywords.negative.hardExclude.filter((t) => desc.includes(t));
    if (dq.length >= 3) return `描述多次命中排除词（${dq.slice(0, 3).join('、')}）`;
  }
  if (/招[聘募]?对象[：:]?\s*(社招|社会招聘)/.test(text)) return '明确社招';
  const yearsExp = text.match(/([3-9]|[1-9][0-9])\s*年以上(工作)?经验/);
  if (yearsExp) return `要求 ${yearsExp[1]} 年以上经验`;
  // Staleness: the brief only wants freshly posted / still-open roles.
  const age = postingAgeDays(job);
  if (age !== null && age > STALE_DAYS) return `信息过期（${age} 天未刷新）`;
  return '';
}

/** Age of the posting in days, from refresh/publish date when available. */
export function postingAgeDays(job, now = new Date()) {
  const raw = job.refreshDate || job.publishOrUpdateDate || '';
  if (!raw) return null;
  const iso = String(raw).replace(/\//g, '-');
  const days = daysSince(iso, now);
  return days === null ? null : days;
}

export function scoreJob(job, profile, keywords) {
  const w = keywords.weights;
  const text = jobText(job);
  const title = normText(job.title);
  const reasons = [];
  let score = 0;

  // --- language affinity: this candidate is a C++ person; a Java/Python-only role is off-target ---
  const cxxAffinity = /C\+\+|C／C\+\+|C语言|\bC\/C\+\+\b|cpp/i.test(`${title} ${text}`);
  const titleCxx = /C\+\+|C／C\+\+|C语言|cpp/i.test(title);
  const competingLang = /(Java|Python|Golang|Go语言|PHP|C#|\.NET|Android|iOS|前端)/i.test(title);
  if (competingLang && !titleCxx) {
    score -= 8;
    reasons.push('标题主语言非 C++（方向偏离）');
  }
  if (!cxxAffinity) {
    score -= 6;
    reasons.push('JD 未明确 C/C++');
  } else if (titleCxx) {
    score += 3;
  }

  // --- freshness: brief asks for newly posted / still-open roles ---
  const age = postingAgeDays(job);
  if (age !== null) {
    if (age <= 90) {
      score += 2;
      reasons.push(`信息较新（${age} 天内刷新）`);
    } else if (age > AGING_DAYS) {
      score -= 5;
      reasons.push(`发布/刷新已 ${age} 天，投递前建议先确认是否仍在招`);
    }
  }

  const strong = countHits(text, keywords.direction.strong);
  const medium = countHits(text, keywords.direction.medium);
  const weak = countHits(text, keywords.direction.weak);
  const titleStrong = countHits(title, keywords.direction.strong);
  score += strong.length * w.directionStrong + medium.length * w.directionMedium + weak.length * w.directionWeak;
  score += titleStrong.length * w.directionStrong; // direction in the title counts double
  if (titleStrong.length) reasons.push(`岗位名直接命中方向：${titleStrong.slice(0, 4).join('、')}`);
  else if (strong.length) reasons.push(`JD 命中方向关键词：${strong.slice(0, 4).join('、')}`);

  // Location
  const cityText = normText(job.city || job.location || '');
  let locationTier = 'other';
  if (/远程|remote|线上/i.test(cityText) || /远程办公|可远程/.test(text)) {
    score += w.remote;
    locationTier = '远程';
    reasons.push('支持远程，不受地域限制');
  } else if (cityText.includes(profile.locationPriority[0])) {
    score += w.cityTop;
    locationTier = '武汉';
    reasons.push('武汉本地岗位（地点优先）');
  } else if (profile.locationPriority.slice(2).some((c) => cityText.includes(c))) {
    score += w.cityListed;
    locationTier = '其他重点城市';
  }

  // Internship signals / cohort
  if (/实习|intern/i.test(title)) {
    score += w.internshipTitleBonus;
    reasons.push('标题即为实习岗');
  }
  const cohortTokens = [...new Set((text.match(/20(2[5-9])届/g) || []).map((s) => s))];
  const cohortFriendly = /20(27|28)届|不限届次|届次不限|在校生|大二|大三|本科在读/.test(text);
  const only2026 = /20(25|26)届/.test(text) && !/20(27|28)届/.test(text) && !/不限届次|在校生|大二|大三/.test(text);
  const only2027 = /2027届/.test(text) && !/2028届|不限届次|在校生|大二|大三|2027届及以后/.test(text);
  if (cohortFriendly) {
    score += w.cohortMatchBonus;
    reasons.push(`届次友好：${cohortTokens.length ? cohortTokens.join('/') : '面向在校生'}`);
  }
  if (only2026) {
    score -= 3;
    reasons.push('仅提到 2025/2026 届，届次可能不匹配');
  }
  if (only2027) {
    score -= 2;
    reasons.push('标注 2027 届，投递前需确认是否接受 2028 届（日常实习通常可放宽）');
  }

  // Company type
  const companyMetaText = normText([(job.companyMeta || []).join(' '), (job.tags || []).join(' '), job.company, job.companyBlurb].join(' '));
  const largeHit = countHits(companyMetaText, LARGE_COMPANY_HINTS);
  const smeHit = countHits(companyMetaText, SME_HINTS);
  let companyType = '未标注';
  if (largeHit.length && !/上市公司$/.test(largeHit.join())) {
    score += w.largeCompanyPenalty;
    companyType = `偏大厂/大公司（${largeHit.slice(0, 2).join('、')}）`;
  }
  if (smeHit.length) {
    score += w.smeBonus;
    companyType = companyType === '未标注' ? `中小/成长型（${smeHit.slice(0, 2).join('、')}）` : companyType;
    if (companyType.startsWith('中小')) reasons.push(`公司类型符合偏好：${smeHit.slice(0, 2).join('、')}`);
  }

  // School / degree gate
  const gateHigh = countHits(text, keywords.schoolGate.high);
  const gateLow = countHits(text, keywords.schoolGate.low);
  let schoolGate = '未明确';
  if (gateHigh.length) {
    score += w.schoolGateHighPenalty;
    schoolGate = `门槛偏高：${gateHigh.slice(0, 3).join('、')}`;
  } else if (gateLow.length) {
    score += w.schoolGateLowBonus;
    schoolGate = `本科友好：${gateLow.slice(0, 3).join('、')}`;
    reasons.push(`学历门槛友好（${gateLow.slice(0, 2).join('、')}）`);
  }

  // Duration vs the ~1 month winter window
  const monthsNum = Number(String(job.months || '').replace(/[^0-9]/g, '')) || 0;
  const daysNum = Number(String(job.daysPerWeek || '').replace(/[^0-9]/g, '')) || 0;
  let durationNote = '未标注';
  let durationConflict = false;
  if (monthsNum || daysNum) {
    durationNote = [monthsNum ? `${monthsNum} 个月` : '', daysNum ? `每周 ${daysNum} 天` : ''].filter(Boolean).join(' / ');
    if (monthsNum >= 6 && daysNum >= 3) {
      durationNote += '（长期，与寒假约 1 个多月短期计划冲突，建议按长期实习准备）';
      durationConflict = true;
    } else if (monthsNum && monthsNum <= 3) {
      durationNote += '（时长较短，与寒假计划兼容）';
    }
  }

  // Candidate fit
  const matchPoints = [];
  const gaps = [];
  for (const [skill, re] of Object.entries(SKILL_PATTERNS)) {
    if (re.test(text)) matchPoints.push(skill);
  }
  const candidateOwned = new Set(profile.currentSkills);
  const matchOwned = matchPoints.filter((m) => candidateOwned.has(m));
  if (matchPoints.length) score += Math.min(matchPoints.length, 6);
  for (const g of GAP_LIBRARY) {
    if (gaps.length >= 3) break;
    if (g.need.test(text)) gaps.push(g.gap);
  }
  if (!gaps.length && matchPoints.length < 4) gaps.push('补齐 TCP/Reactor/数据库（当前正在补的四项）');

  // Tier
  const directionScore = strong.length * 2 + titleStrong.length * 3 + medium.length;
  const ownedSkillCount = [...new Set(matchOwned)].length;
  let tier = '观察';
  if (score >= 22 && directionScore >= 6 && cxxAffinity && ownedSkillCount >= 2) tier = '优先投';
  else if (score >= 14 && cxxAffinity) tier = '长期备选';
  else if (directionScore >= 8 && cxxAffinity) tier = '冲刺';
  if (gateHigh.length && directionScore >= 8) tier = '冲刺';
  if (tier === '优先投' && durationConflict) tier = '长期备选';

  return {
    ...job,
    id: jobIdentity(job),
    urlId: urlIdentity(job),
    score,
    directionScore,
    tier,
    locationTier,
    companyType,
    schoolGate,
    durationNote,
    durationConflict,
    matchPoints: [...new Set(matchPoints)],
    matchedSkills: [...new Set(matchOwned)],
    gaps: [...new Set(gaps)].slice(0, 3),
    reasons: [...new Set(reasons)].slice(0, 5),
    cohortTokens,
    whyWorth: buildWhyWorth({ reasons, tier, locationTier, companyType, schoolGate, durationNote, score }),
  };
}

function buildWhyWorth({ reasons, tier, locationTier, companyType, schoolGate, durationNote, score }) {
  const bits = [];
  if (reasons.length) bits.push(reasons.slice(0, 3).join('；'));
  if (locationTier === '武汉') bits.push('地点在武汉');
  else if (locationTier === '远程') bits.push('可远程');
  if (companyType !== '未标注') bits.push(companyType);
  if (schoolGate.startsWith('本科友好')) bits.push(schoolGate);
  if (durationNote !== '未标注') bits.push(`时长：${durationNote}`);
  bits.push(`综合评分 ${score}（${tier}）`);
  return bits.join('；');
}

/** Cross-platform duplicate collapse: same company+title keeps the richest record. */
export function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = `${normText(job.company).toLowerCase().replace(/\s/g, '')}::${normText(job.title)
      .toLowerCase()
      .replace(/[\s()（）\[\]【】\-—/]/g, '')}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, job);
      continue;
    }
    const richness = (j) => (j.description ? 2 : 0) + (j.durationNote && j.durationNote !== '未标注' ? 1 : 0) + (j.salary ? 1 : 0) + (j.url ? 1 : 0);
    const winner = richness(job) > richness(prev) ? job : prev;
    const loser = winner === job ? prev : job;
    winner.altSources = [...new Set([...(winner.altSources || []), loser.sourceLabel || loser.source].filter(Boolean))];
    byKey.set(key, winner);
  }
  return [...byKey.values()];
}

/** Keep 武汉 first, then score. */
export function rankJobs(jobs, profile) {
  const order = new Map(profile.locationPriority.map((c, i) => [c, i]));
  return [...jobs].sort((a, b) => {
    const ca = order.has(a.locationTier) ? order.get(a.locationTier) : 99;
    const cb = order.has(b.locationTier) ? order.get(b.locationTier) : 99;
    if (a.locationTier === '武汉' && b.locationTier !== '武汉') return -1;
    if (b.locationTier === '武汉' && a.locationTier !== '武汉') return 1;
    if (ca !== cb) return ca - cb;
    return b.score - a.score;
  });
}

export function selectForReport(jobs, { min = 6, target = 10 } = {}) {
  const ranked = [...jobs];
  const priority = ranked.filter((j) => j.tier === '优先投');
  const stretch = ranked.filter((j) => j.tier === '冲刺');
  const longTerm = ranked.filter((j) => j.tier === '长期备选');
  const picked = [...priority];
  const largeCount = () => picked.filter((j) => /偏大厂/.test(j.companyType)).length;
  for (const j of longTerm) {
    if (picked.length >= target) break;
    picked.push(j);
  }
  for (const j of stretch) {
    if (picked.length >= target) break;
    if (/偏大厂/.test(j.companyType) && largeCount() >= 1) continue;
    picked.push(j);
  }
  if (picked.length < min) {
    for (const j of ranked) {
      if (picked.length >= min) break;
      if (!picked.includes(j) && j.tier !== '观察') picked.push(j);
    }
  }
  return picked.slice(0, target);
}
