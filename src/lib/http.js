// HTTP helpers: timeout + limited retries + browser-ish UA (zero dependencies)
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchText(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    headers = {},
    fetchImpl = globalThis.fetch,
    retryDelayMs = 800,
    label = url,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': DEFAULT_UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
      });
      const text = await res.text();
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
      return { status: res.status, text, url: res.url || url };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const isLast = attempt === retries;
      if (!isLast) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw new Error(`fetchText failed after ${retries + 1} attempts: ${label} :: ${lastError?.message || lastError}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strip tags & decode the handful of entities the job sites actually emit.
// Private-use-area glyphs (font obfuscation used by e.g. 实习僧) carry no meaning here.
export function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // NOTE: several Chinese job sites emit numeric entities without the trailing
    // semicolon (e.g. 实习僧 renders "&#xe5a3</a>"), so the ";" must be optional.
    .replace(/&#(\d+);?/g, (_, d) => {
      const code = Number(d);
      return code > 31 && code < 65536 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 31 && code < 65536 ? String.fromCodePoint(code) : ' ';
    });
}

export function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
