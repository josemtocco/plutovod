// Cloudflare Worker: resolve links curtos /play/<id>.m3u8 em streams HLS da Pluto TV.
// Cria uma sessão nova (JWT) a cada reprodução, então o link na M3U nunca expira.

const BOOT = 'https://boot.pluto.tv/v4/start';
const VOD = 'https://service-vod.clusters.pluto.tv/v4/vod';
const STITCHER = 'https://cfd-v4-service-stitcher-dash-use1-1.prd.pluto.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const baseHeaders = (env, extra = {}) => {
  const h = { 'user-agent': UA, origin: 'https://pluto.tv', referer: 'https://pluto.tv/', ...extra };
  if (env.FORWARDED_FOR_IP) h['x-forwarded-for'] = env.FORWARDED_FOR_IP;
  return h;
};

const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra } });

async function boot(env, f) {
  const p = new URLSearchParams({
    appName: 'web', appVersion: '9.0.0-0', deviceVersion: '124.0.0', deviceModel: 'web', deviceMake: 'chrome',
    deviceType: 'web', clientID: crypto.randomUUID(), clientModelNumber: '1.0.0', serverSideAds: 'false',
    drmCapabilities: 'widevine:L3', blockingMode: '', notificationVersion: '1', appLaunchCount: '', lastAppLaunchDate: '',
  });
  const r = await f(`${env.PLUTO_BOOT_URL || BOOT}?${p}`, { headers: baseHeaders(env, { accept: 'application/json' }) });
  if (!r.ok) throw new Error(`boot HTTP ${r.status}`);
  const d = await r.json();
  if (!d.sessionToken) throw new Error('boot sem sessionToken');
  return { token: d.sessionToken, params: d.stitcherParams || '', stitcher: d.servers?.stitcher || STITCHER };
}

function stitchUrl(s, path) {
  const q = new URLSearchParams(String(s.params).replace(/^\?/, ''));
  q.set('jwt', s.token);
  return `${s.stitcher.replace(/\/+$/, '')}${path}?${q}`;
}

async function lookupPath(env, f, s, id) {
  const vod = (env.PLUTO_VOD_URL || VOD).replace(/\/+$/, '');
  const r = await f(`${vod}/items?ids=${encodeURIComponent(id)}`, {
    headers: baseHeaders(env, { accept: 'application/json', authorization: `Bearer ${s.token}` }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const item = Array.isArray(d) ? d[0] : d.items?.[0] || d;
  const paths = item?.stitched?.paths || [];
  return (paths.find((p) => /m3u8|hls/i.test(p.path || '')) || paths[0])?.path || null;
}

/** Torna absolutas as URIs relativas do master (o master passa a ser servido pelo Worker). */
export function absolutize(manifest, baseUrl) {
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${new URL(u, baseUrl).href}"`);
      return new URL(t, baseUrl).href;
    })
    .join('\n');
}

export async function handleRequest(request, env = {}, f = fetch) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return text('', 204, { 'access-control-allow-methods': 'GET,HEAD,OPTIONS' });
  if (url.pathname === '/' || url.pathname === '/health') return text('pluto-br-ssiptv resolver ok\n');
  const m = url.pathname.match(/^\/play\/([^/]+?)(?:\.m3u8)?$/);
  if (!m || !ID_RE.test(m[1])) return text('Not found\n', 404);
  const id = m[1];
  try {
    const s = await boot(env, f);
    let target = stitchUrl(s, `/v2/stitch/hls/episode/${id}/master.m3u8`);
    if ((url.searchParams.get('mode') || env.MODE) === 'redirect') {
      return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
    }
    let r = await f(target, { headers: baseHeaders(env) });
    if (!r.ok) {
      const path = await lookupPath(env, f, s, id);
      if (path) { target = stitchUrl(s, path); r = await f(target, { headers: baseHeaders(env) }); }
    }
    if (!r.ok) return text(`Pluto respondeu HTTP ${r.status} para ${id}\n`, r.status === 404 ? 404 : 502);
    const body = await r.text();
    if (!body.startsWith('#EXTM3U')) return text('Resposta da Pluto não é HLS\n', 502);
    const out = absolutize(body, r.url || target);
    return new Response(request.method === 'HEAD' ? null : out, {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return text(`Erro: ${e.message}\n`, 502);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
