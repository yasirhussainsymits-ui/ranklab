// Vercel Edge Function — server-side Google fetch, no CORS issues
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function normHost(h) {
  return (h || '').replace(/^(https?:\/\/)?(www\d*\.)?/, '').toLowerCase().split('/')[0].split('?')[0].trim();
}
function domainMatch(a, b) {
  if (!a || !b) return false;
  const na = normHost(a), nb = normHost(b);
  if (na === nb) return true;
  if (na.endsWith('.' + nb) || nb.endsWith('.' + na)) return true;
  const ba = na.split('.').slice(-2).join('.');
  const bb = nb.split('.').slice(-2).join('.');
  return ba === bb && ba.length > 3;
}

function parseRank(html, targetDomain) {
  const target = normHost(targetDomain);
  const results = [];
  const seen = new Set();
  const SKIP = ['google.', 'googleapis.', 'gstatic.', 'ggpht.', 'googleusercontent.',
                 'youtube.', 'webcache.', 'googlevideo.', 'amp.dev', 'schema.org'];

  function add(raw) {
    const h = normHost(raw);
    if (!h || h.length < 4 || !h.includes('.') || seen.has(h)) return;
    if (SKIP.some(s => h.includes(s))) return;
    seen.add(h);
    results.push(h);
  }

  let m;

  // Pattern 1: /url?q= redirect links
  const p1 = /\/url\?[^"' ]*?q=(https?(?:%3A%2F%2F|:\/\/)[^&"' \n]+)/g;
  while ((m = p1.exec(html)) !== null) {
    try { add(new URL(decodeURIComponent(m[1])).hostname); } catch {}
  }

  // Pattern 2: data-url / jsurl attributes
  const p2 = /(?:data-url|jsurl|data-href)="(https?:\/\/[^"]+)"/g;
  while ((m = p2.exec(html)) !== null) {
    try { add(new URL(m[1]).hostname); } catch {}
  }

  // Pattern 3: direct href links (non-Google)
  const p3 = /href="(https?:\/\/[^"#\s]{8,})"/g;
  while ((m = p3.exec(html)) !== null) {
    try {
      const h = new URL(m[1]).hostname.replace(/^www\d*\./, '');
      if (!h.includes('google.') && !h.includes('gstatic.') && !h.includes('googleapis.')) add(h);
    } catch {}
  }

  // Pattern 4: <cite> display URLs
  const p4 = /<cite[^>]*>([^<]{5,100})<\/cite>/g;
  while ((m = p4.exec(html)) !== null) {
    try {
      let cite = m[1].replace(/<[^>]+>/g, '').trim();
      if (!cite.startsWith('http')) cite = 'https://' + cite;
      add(new URL(cite).hostname);
    } catch {}
  }

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
  const q      = searchParams.get('q');
  const domain = searchParams.get('domain');
  const uule   = searchParams.get('uule') || '';
  const gl     = searchParams.get('gl') || 'us';
  const hl     = searchParams.get('hl') || 'en';

  if (!q || !domain) {
    return new Response(JSON.stringify({ error: 'Missing q or domain' }), { headers: CORS, status: 400 });
  }

  try {
    const params = new URLSearchParams({ q, num: '100', gl, hl, nfpr: '1', safe: 'off', pws: '0' });
    if (uule) params.set('uule', uule);

    const res = await fetch('https://www.google.com/search?' + params, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': `${hl}-${gl.toUpperCase()},${hl};q=0.9,en;q=0.7`,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.google.com/',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    if (!res.ok) throw new Error('Google returned HTTP ' + res.status);
    const html = await res.text();

    if (html.includes('/sorry/index') || html.includes('detected unusual traffic')) {
      throw new Error('Google CAPTCHA — try again in a minute');
    }
    if (html.length < 3000) throw new Error('Empty response from Google');

    const result = parseRank(html, domain);
    return new Response(JSON.stringify(result), { headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers: CORS, status: 500 });
  }
}
