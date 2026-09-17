// Vercel Edge Function — server-side Google fetch
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function normHost(h) {
  return String(h || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\d*\./, '')
    .toLowerCase()
    .split('/')[0].split('?')[0].split('#')[0].trim();
}

function domainMatch(parsed, target) {
  const a = normHost(parsed);
  const b = normHost(target);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  // base domain match (e.g. sub.example.com matches example.com)
  const ba = a.split('.').slice(-2).join('.');
  const bb = b.split('.').slice(-2).join('.');
  return ba === bb && ba.length > 3;
}

function parseRank(html, targetDomain) {
  const results = [];
  const seen = new Set();
  const SKIP = [
    'google.com', 'google.', 'googleapis.', 'gstatic.', 'ggpht.',
    'googleusercontent.', 'youtube.com', 'webcache.googleusercontent.',
    'googlevideo.', 'amp.dev', 'schema.org', 'w3.org', 'goo.gl'
  ];

  function add(raw) {
    try {
      const h = normHost(raw);
      if (!h || h.length < 4 || !h.includes('.')) return;
      if (seen.has(h)) return;
      if (SKIP.some(s => h === s || h.endsWith('.' + s) || h.includes(s))) return;
      seen.add(h);
      results.push(h);
    } catch {}
  }

  let m;

  // Pattern 1: Google /url?q= redirects (ads + some organic)
  const p1 = /\/url\?[^"'<>]*?[?&]q=(https?(?:%3A%2F%2F|:\/\/)[^&"'<>\s]+)/g;
  while ((m = p1.exec(html)) !== null) {
    try { add(new URL(decodeURIComponent(m[1])).hostname); } catch {}
  }

  // Pattern 2: jsname="UWckNb" — Google's organic result anchor (most reliable)
  const p2 = /jsname="UWckNb"[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((m = p2.exec(html)) !== null) {
    try { add(new URL(m[1]).hostname); } catch {}
  }

  // Pattern 3: ping attribute on result links
  const p3 = /ping="\/url\?[^"]*url=(https?[^"&]+)"/g;
  while ((m = p3.exec(html)) !== null) {
    try { add(new URL(decodeURIComponent(m[1])).hostname); } catch {}
  }

  // Pattern 4: data-url / data-href attributes
  const p4 = /data-(?:url|href|ved)="(https?:\/\/[^"]+)"/g;
  while ((m = p4.exec(html)) !== null) {
    try { add(new URL(m[1]).hostname); } catch {}
  }

  // Pattern 5: <cite> display URLs under result titles
  const p5 = /<cite(?:[^>]*)>([\s\S]{4,120}?)<\/cite>/g;
  while ((m = p5.exec(html)) !== null) {
    try {
      let cite = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
      if (cite && !cite.startsWith('http')) cite = 'https://' + cite;
      add(new URL(cite).hostname);
    } catch {}
  }

  // Pattern 6: all direct href https links (broad sweep, filters Google internally)
  const p6 = /href="(https?:\/\/[^"#\s]{8,})"/g;
  while ((m = p6.exec(html)) !== null) {
    try {
      const url = new URL(m[1]);
      const h = url.hostname.replace(/^www\d*\./, '').toLowerCase();
      if (!SKIP.some(s => h === s || h.endsWith('.' + s) || h.includes(s))) add(h);
    } catch {}
  }

  // Find target position
  for (let i = 0; i < results.length; i++) {
    if (domainMatch(results[i], targetDomain)) {
      return {
        pos: i + 1,
        total: results.length,
        top10: results.slice(0, 10),
        matched: results[i]
      };
    }
  }
  return { pos: null, total: results.length, top10: results.slice(0, 10) };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const { searchParams } = new URL(req.url);
  const q      = searchParams.get('q');
  const domain = searchParams.get('domain');
  const uule   = searchParams.get('uule') || '';
  const gl     = searchParams.get('gl') || 'us';
  const hl     = searchParams.get('hl') || 'en';
  const debug  = searchParams.get('debug') === '1';

  if (!q || !domain) {
    return new Response(JSON.stringify({ error: 'Missing q or domain' }), { headers: CORS, status: 400 });
  }

  try {
    const params = new URLSearchParams({
      q, num: '100', gl, hl, nfpr: '1', safe: 'off', pws: '0', filter: '0'
    });
    if (uule) params.set('uule', uule);

    const gurl = 'https://www.google.com/search?' + params;

    const res = await fetch(gurl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.google.com/',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    if (!res.ok) throw new Error('Google HTTP ' + res.status);
    const html = await res.text();

    if (html.includes('/sorry/index') || html.includes('detected unusual traffic')) {
      throw new Error('Google CAPTCHA — wait a minute then retry');
    }
    if (html.length < 2000) throw new Error('Empty Google response (length=' + html.length + ')');

    const result = parseRank(html, domain);

    if (debug) {
      return new Response(JSON.stringify({ ...result, htmlLen: html.length, uule, gurl }), { headers: CORS });
    }

    return new Response(JSON.stringify(result), { headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 });
  }
}
