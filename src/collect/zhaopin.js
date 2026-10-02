// 智联招聘 collector: server-rendered search page + detail page enrichment.
import { fetchText, stripTags, decodeEntities, absoluteUrl } from '../lib/http.js';

const BASE = 'https://sou.zhaopin.com/';
const PUA = /[\uE000-\uF8FF]/g;

export function buildSearchUrl(kw, cityCode) {
  return `${BASE}?jl=${encodeURIComponent(cityCode)}&kw=${encodeURIComponent(kw)}`;
}

/** Parse the SSR search page into raw job cards (no detail yet). */
export function parseSearchPage(html, meta = {}) {
  const items = [];
  const chunks = String(html).split(/<div class="joblist-box__item[\s"]/).slice(1);
  for (const chunk of chunks) {
    const titleTag = chunk.match(/<a[^>]*class="jobinfo__name"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleTag) continue;
    const tagHtml = titleTag[0];
    const href = (tagHtml.match(/href="([^"]+)"/) || [])[1] || '';
    const title = cleanText(titleTag[1]);
    if (!title) continue;

    const salary = cleanText((chunk.match(/class="jobinfo__salary"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const [jobPart, companyPart] = splitAtCompany(chunk);

    const jobTags = allMatches(jobPart, /joblist-box__item-tag[^>]*>([\s\S]*?)<\/div>/g);
    const infoItems = allMatches(jobPart, /jobinfo__other-info-item[^>]*>([\s\S]*?)<\/div>/g);
    let city = '';
    let experience = '';
    let education = '';
    for (const raw of infoItems) {
      const t = cleanText(raw);
      if (!t) continue;
      if (/经验|应届|在校/.test(t)) experience = experience || t;
      else if (/本科|硕士|博士|大专|中专|学历不限|不限/.test(t)) education = education || t;
      else city = city || t;
    }

    const companyTitle = (companyPart.match(/<a[^>]*class="companyinfo__name[^"]*"[^>]*title="([^"]*)"/) ||
      companyPart.match(/<a[^>]*title="([^"]*)"[^>]*class="companyinfo__name/) || [])[1];
    const companyText = cleanText(
      (companyPart.match(/<a[^>]*class="companyinfo__name[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || ''
    );
    const companyTags = allMatches(companyPart, /joblist-box__item-tag[^>]*>([\s\S]*?)<\/div>/g);
    const companyUrl = (companyPart.match(/href="([^"]*companydetail[^"]*)"/) || [])[1] || '';

    items.push({
      source: 'zhaopin',
      sourceLabel: '智联招聘',
      title,
      url: normalizeDetailUrl(href),
      company: cleanText(companyTitle || companyText),
      companyUrl: companyUrl ? absoluteUrl(companyUrl, BASE) : '',
      salary,
      city,
      experience,
      education,
      tags: [...jobTags, ...companyTags].map(cleanText).filter(Boolean),
      companyMeta: companyTags.map(cleanText).filter(Boolean),
      query: meta.query || '',
      queryCity: meta.city || '',
      collectedAt: meta.collectedAt || new Date().toISOString(),
    });
  }
  return items;
}

/** Extract the human-readable parts of a detail page. */
export function parseDetailPage(html) {
  const text = stripTags(html);
  const descStart = text.indexOf('职位描述');
  const descEnd = text.indexOf('工作地点', descStart >= 0 ? descStart : 0);
  const description = descStart >= 0 ? text.slice(descStart, descEnd > descStart ? descEnd : descStart + 4000) : '';

  const months = (text.match(/总实习月数\s*([0-9]+\s*个月)/) || [])[1] || '';
  const daysPerWeek = (text.match(/周实习天数\s*([0-9]+\s*天)/) || [])[1] || '';
  const companyBlurb = text.slice(text.indexOf('公司介绍'), text.indexOf('公司介绍') + 700);
  return {
    description: decodeEntities(description).slice(0, 4000),
    durationText: [months, daysPerWeek].filter(Boolean).join(' / '),
    months: months.replace(/\s/g, ''),
    daysPerWeek: daysPerWeek.replace(/\s/g, ''),
    companyBlurb: companyBlurb.slice(0, 700),
  };
}

function splitAtCompany(chunk) {
  const i = chunk.indexOf('companyinfo');
  return i < 0 ? [chunk, ''] : [chunk.slice(0, i), chunk.slice(i)];
}

function normalizeDetailUrl(href) {
  if (!href) return '';
  const url = href.startsWith('//') ? `https:${href}` : href;
  return url.replace(/^http:/, 'https:');
}

function allMatches(text, re) {
  return [...String(text).matchAll(re)].map((m) => m[1]);
}

function cleanText(s) {
  return stripTags(s || '').replace(PUA, '').replace(/^[-–—\s|]+$/, '').trim();
}

export async function collectZhaopin(queries, options = {}) {
  const { fetchImpl, log = () => {}, timeoutMs = 25000, delayMs = 600, maxPages = 1 } = options;
  const out = [];
  for (const q of queries) {
    for (const [city, code] of Object.entries(q.city || {})) {
      for (let page = 0; page < maxPages; page++) {
        const url = `${buildSearchUrl(q.kw, code)}&p=${page + 1}`;
        try {
          const { text } = await fetchText(url, { fetchImpl, timeoutMs, retries: 1, label: `zhaopin:${q.kw}/${city}` });
          const items = parseSearchPage(text, {
            query: q.kw,
            city,
            collectedAt: new Date().toISOString(),
          });
          log(`  [智联] ${q.kw} @ ${city} → ${items.length} 条`);
          out.push(...items);
        } catch (err) {
          log(`  [智联] ${q.kw} @ ${city} 采集失败：${err.message}`);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  return out;
}

export async function enrichZhaopinDetail(item, options = {}) {
  const { fetchImpl, timeoutMs = 25000 } = options;
  if (!item.url) return item;
  try {
    const { text } = await fetchText(item.url, { fetchImpl, timeoutMs, retries: 1, label: `zhaopin-detail:${item.title}` });
    return { ...item, ...parseDetailPage(text), detailFetched: true };
  } catch (err) {
    return { ...item, detailFetched: false, detailError: err.message };
  }
}
