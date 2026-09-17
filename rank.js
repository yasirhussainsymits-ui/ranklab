// Vercel Edge Function — runs on Vercel's servers, no CORS issues
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function normHost(h) {
  return (h || '').replace(/^www\d*\./, '').toLowerCase().trim();
}
function domainMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  const ba = a.split('.').slice(-2).join('.');
  const bb = b.split('.').slice(-2).join('.');
  return ba === bb && ba.length > 3;
}

function parseRank(html, targetDomain) {
  const target = normHost(targetDomain);
  const results = [];
  const seen = new Set();
  const SKIP = ['google.', 'googleapis.', 'gstatic.', 'ggpht.', 'googleusercontent.', 'youtube.', 'webcache.'];

  function add(host) {
    const h = normHost(host);
    if (!h || h.length < 4 || !h.includes('.') || seen.has(h)) return;
    if (SKIP.some(s => h.includes(s))) return;
    seen.add(h);
    results.push(h);
  }

  // Pattern 1: Google redirect links /url?q=https://...
  const urlqRx = /\/url\?[^"']*?q=(https?%3A%2F%2F[^&"'\s]+|https?:\/\/[^&"'\s]+)/g;
  let m;
  while ((m = urlqRx.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(m[1]);
      add(new URL(decoded).hostname);
    } catch {}
  }

  // Pattern 2: Direct href="https://..." links
  const hrefRx = /href="(https?:\/\/(?!(?:www\.)?google\.|googleapis\.|gstatic\.)[^"#\s]+)"/g;
  while ((m = hrefRx.exec(html)) !== null) {
    try { add(new URL(m[1]).hostname); } catch {}
  }

  // Pattern 3: data-url attributes
  const dataRx = /data-(?:url|href)="(https?:\/\/[^"]+)"/g;
  while ((m = dataRx.exec(html)) !== null) {
    try { add(new URL(m[1]).hostname); } catch {}
  }

  // Find position of target domain
  for (let i = 0; i < results.length; i++) {
    if (domainMatch(results[i], target)) {
      return { pos: i + 1, total: results.length, top5: results.slice(0, 5) };
    }
  }
  return { pos: null, total: results.length, top5: results.slice(0, 5) };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const domain = searchParams.get('domain');
  const uule = searchParams.get('uule') || '';
  const gl = searchParams.get('gl') || 'us';
  const hl = searchParams.get('hl') || 'en';

  if (!q || !domain) {
    return new Response(JSON.stringify({ error: 'Missing q or domain' }), { headers: CORS, status: 400 });
  }

  try {
    const params = new URLSearchParams({ q, num: '100', gl, hl, nfpr: '1', safe: 'off' });
    if (uule) params.set('uule', uule);

    const res = await fetch('https://www.google.com/search?' + params, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
      }
    });

    if (!res.ok) throw new Error('Google returned HTTP ' + res.status);

    const html = await res.text();

    if (html.includes('/sorry/index') || html.includes('detected unusual traffic') || html.length < 2000) {
      throw new Error('Google CAPTCHA — try again in a minute');
    }

    const result = parseRank(html, domain);
    return new Response(JSON.stringify(result), { headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 });
  }
}
