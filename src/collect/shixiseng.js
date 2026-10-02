// 实习僧 collector: SSR search page cards + plain-text detail page enrichment.
// Note: the search page obfuscates part of the title with a custom font (private-use glyphs),
// so the exact title/description is taken from the detail page.
import { fetchText, stripTags, decodeEntities } from '../lib/http.js';

const BASE = 'https://www.shixiseng.com';
const PUA = /[\uE000-\uF8FF]/g;

export function buildSearchUrl(keyword, city) {
  const params = new URLSearchParams({ keyword, type: 'intern' });
  if (city) params.set('city', city);
  return `${BASE}/interns?${params.toString()}`;
}

export function parseSearchPage(html, meta = {}) {
  const items = [];
  const chunks = String(html).split(/<div data-intern-id="/).slice(1);
  for (const chunk of chunks) {
    const id = (chunk.match(/^(inn_[a-z0-9]+)"/) || [])[1];
    if (!id) continue;
    const title = cleanText(
      (chunk.match(/class="title ellipsis font"[^>]*>([\s\S]*?)<\/a>/) || [])[1] ||
        (chunk.match(/<a[^>]*class="title[^"]*"[^>]*title="([^"]*)"/) || [])[1] ||
        ''
    );
    const href = (chunk.match(/href="(https:\/\/www\.shixiseng\.com\/intern\/inn_[^"]+)"/) || [])[1] || `${BASE}/intern/${id}`;
    const city = cleanText((chunk.match(/class="city ellipsis"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const fontSpans = [...chunk.matchAll(/<span class="font"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => cleanText(m[1]));
    const daysPerWeek = fontSpans.find((t) => /天/.test(t)) || '';
    const months = fontSpans.find((t) => /个月|月/.test(t)) || '';
    const companyPart = chunk.slice(chunk.indexOf('intern-detail__company'));
    const company =
      cleanText((companyPart.match(/<a[^>]*title="([^"]+)"/) || [])[1] || '') ||
      cleanText((companyPart.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const tags = [...companyPart.matchAll(/<span[^>]*>([^<]{2,20})<\/span>/g)]
      .map((m) => cleanText(m[1]))
      .filter((t) => t && !/天|个月|周/.test(t))
      .slice(0, 8);

    items.push({
      source: 'shixiseng',
      sourceLabel: '实习僧',
      id,
      title: title.replace(/[+]+/g, '++'),
      url: href.split('?')[0],
      company,
      city,
      daysPerWeek,
      months,
      tags,
      query: meta.keyword || '',
      queryCity: meta.city || '',
      collectedAt: meta.collectedAt || new Date().toISOString(),
    });
  }
  return items;
}

export function parseDetailPage(html) {
  const text = stripTags(html);
  const title = decodeEntities((String(html).match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').split('实习招聘')[0].trim();
  const refresh = (text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*刷新/) || [])[1] || '';
  const deadline = (text.match(/截止日期：\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const descStart = text.indexOf('职位描述');
  const descEnd = text.indexOf('投递要求', descStart >= 0 ? descStart : 0);
  const description = descStart >= 0 ? text.slice(descStart, descEnd > descStart ? descEnd : descStart + 4000) : '';
  const degree = (text.match(/(本科|硕士|博士|大专|不限)\s*(\d+天／周|\d+天\/周)/) || [])[1] || '';
  const perWeek = (text.match(/(\d+天[／/]周)/) || [])[1] || '';
  const duration = (text.match(/实习\s*(\d+\s*个月)/) || [])[1] || '';
  const location = (text.match(/工作地点：\s*([^\s]{2,30})/) || [])[1] || '';
  return {
    titleClean: title,
    description: decodeEntities(description).slice(0, 4000),
    refreshDate: refresh,
    deadline,
    degree,
    daysPerWeek: perWeek || '',
    months: duration || '',
    location,
    detailFetched: true,
  };
}

function cleanText(s) {
  return stripTags(s || '').replace(PUA, '').trim();
}

export async function collectShixiseng(queries, options = {}) {
  const { fetchImpl, log = () => {}, timeoutMs = 25000, delayMs = 600, pages = 1 } = options;
  const out = [];
  for (const q of queries) {
    for (let page = 1; page <= pages; page++) {
      const url = `${buildSearchUrl(q.keyword, q.city)}${page > 1 ? `&page=${page}` : ''}`;
      try {
        const { text } = await fetchText(url, { fetchImpl, timeoutMs, retries: 1, label: `shixiseng:${q.keyword}/${q.city || '全国'}` });
        const items = parseSearchPage(text, { keyword: q.keyword, city: q.city || '全国', collectedAt: new Date().toISOString() });
        log(`  [实习僧] ${q.keyword} @ ${q.city || '全国'} → ${items.length} 条`);
        out.push(...items);
      } catch (err) {
        log(`  [实习僧] ${q.keyword} @ ${q.city || '全国'} 采集失败：${err.message}`);
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}

export async function enrichShixisengDetail(item, options = {}) {
  const { fetchImpl, timeoutMs = 25000 } = options;
  if (!item.url) return item;
  try {
    const { text } = await fetchText(item.url, { fetchImpl, timeoutMs, retries: 1, label: `shixiseng-detail:${item.id}` });
    const detail = parseDetailPage(text);
    return { ...item, ...detail, title: detail.titleClean || item.title };
  } catch (err) {
    return { ...item, detailFetched: false, detailError: err.message };
  }
}
