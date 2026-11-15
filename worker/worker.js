// Cloudflare Worker: resolve links curtos /play/<id>.m3u8 em streams HLS da Pluto TV.
// - cria uma sessão nova (JWT) a cada reprodução, então o link na M3U nunca expira;
// - serve o master E as playlists de variante (/hls), anexando o JWT/parâmetros que a Pluto exige
//   (os manifestos da Pluto listam URLs relativas sem o token -> HTTP 401 direto no player);
// - os segmentos de vídeo continuam saindo direto da CDN da Pluto.

const BOOT = 'https://boot.pluto.tv/v4/start';
const VOD = 'https://service-vod.clusters.pluto.tv/v4/vod';
const STITCHER = 'https://cfd-v4-service-stitcher-dash-use1-1.prd.pluto.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const b64e = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

const baseHeaders = (env, extra = {}) => {
  const h = { 'user-agent': UA, origin: 'https://pluto.tv', referer: 'https://pluto.tv/', ...extra };
  if (env.FORWARDED_FOR_IP) h['x-forwarded-for'] = env.FORWARDED_FOR_IP;
  return h;
};

const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra } });

const playlist = (body, method) =>
  new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  });

function hostAllowed(hostname, env) {
  const suffixes = ['pluto.tv', ...String(env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  return suffixes.some((s) => hostname === s || hostname.endsWith(`.${s}`));
}

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

/** URLs do mesmo host herdam os parâmetros (jwt etc.) da playlist de origem quando não os têm. */
function inherit(target, base) {
  if (target.host === base.host) {
    for (const [k, v] of base.searchParams) if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  }
  return target;
}

/**
 * Reescreve URIs do manifesto: absolutas + parâmetros herdados.
 * Com `origin`, sub-playlists (.m3u8) passam pelo Worker em /hls?u=...; segmentos vão direto.
 */
export function rewrite(manifest, baseUrl, { origin = null } = {}) {
  const base = new URL(baseUrl);
  const fix = (u) => {
    const t = inherit(new URL(u, base), base);
    return origin && /\.m3u8$/i.test(t.pathname) ? `${origin}/hls?u=${b64e(t.href)}` : t.href;
  };
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${fix(u)}"`);
      return fix(t);
    })
    .join('\n');
}

export const absolutize = (manifest, baseUrl) => rewrite(manifest, baseUrl);

const redact = (s) => s.replace(/(jwt=)[^&"\s]+/g, '$1REDACTED');

export async function handleRequest(request, env = {}, f = fetch) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return text('', 204, { 'access-control-allow-methods': 'GET,HEAD,OPTIONS' });
  if (url.pathname === '/' || url.pathname === '/health') return text('pluto-br-ssiptv resolver ok\n');

  try {
    // Playlists de variante/áudio/legendas, buscadas com o JWT anexado
    if (url.pathname === '/hls') {
      let target;
      try { target = new URL(b64d(url.searchParams.get('u') || '')); } catch { return text('parâmetro u inválido\n', 400); }
      if (!/^https?:$/.test(target.protocol) || !hostAllowed(target.hostname, env)) return text('host não permitido\n', 403);
      const r = await f(target.href, { headers: baseHeaders(env) });
      if (!r.ok) return text(`Pluto respondeu HTTP ${r.status} na playlist\n`, r.status === 404 ? 404 : 502);
      const body = await r.text();
      if (!body.startsWith('#EXTM3U')) return text('Resposta da Pluto não é HLS\n', 502);
      return playlist(rewrite(body, r.url || target.href, { origin: url.origin }), request.method);
    }

    const m = url.pathname.match(/^\/(play|debug)\/([^/]+?)(?:\.m3u8)?$/);
    if (!m || !ID_RE.test(m[2])) return text('Not found\n', 404);
    const [, route, id] = m;

    const s = await boot(env, f);
    let target = stitchUrl(s, `/v2/stitch/hls/episode/${id}/master.m3u8`);
    if (route === 'play' && (url.searchParams.get('mode') || env.MODE) === 'redirect') {
      return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
    }
    let r = await f(target, { headers: baseHeaders(env) });
    if (!r.ok) {
      const path = await lookupPath(env, f, s, id);
      if (path) { target = stitchUrl(s, path); r = await f(target, { headers: baseHeaders(env) }); }
    }
    if (route === 'debug') {
      const body = await r.text();
      return text(redact(`status: ${r.status}\nurl: ${r.url || target}\n\n${body.slice(0, 3000)}\n`));
    }
    if (!r.ok) return text(`Pluto respondeu HTTP ${r.status} para ${id}\n`, r.status === 404 ? 404 : 502);
    const body = await r.text();
    if (!body.startsWith('#EXTM3U')) return text('Resposta da Pluto não é HLS\n', 502);
    return playlist(rewrite(body, r.url || target, { origin: url.origin }), request.method);
  } catch (e) {
    return text(`Erro: ${e.message}\n`, 502);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
