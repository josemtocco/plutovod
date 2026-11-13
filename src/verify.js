import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseM3U, lintM3U } from './m3u.js';
import { fetchRetry, UA, pMap } from './http.js';

const get = (url, headers = {}) =>
  fetchRetry(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow' }, { retries: 1, timeoutMs: 25000 });

const firstUri = (text) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

/** Testa se o link realmente entrega vídeo: manifesto -> variante -> 1º segmento. */
export async function checkStream(url) {
  const t0 = Date.now();
  const fail = (stage, detail) => ({ ok: false, stage, detail, ms: Date.now() - t0 });
  try {
    const r1 = await get(url);
    if (!r1.ok) return fail('master', `HTTP ${r1.status}`);
    const master = await r1.text();
    if (!master.startsWith('#EXTM3U')) return fail('master', 'não é HLS (#EXTM3U ausente)');
    let mediaText = master;
    let mediaUrl = r1.url || url;
    if (master.includes('#EXT-X-STREAM-INF')) {
      const variant = firstUri(master.slice(master.indexOf('#EXT-X-STREAM-INF')));
      if (!variant) return fail('variant', 'sem variante');
      mediaUrl = new URL(variant, r1.url || url).href;
      const r2 = await get(mediaUrl);
      if (!r2.ok) return fail('variant', `HTTP ${r2.status}`);
      mediaText = await r2.text();
      mediaUrl = r2.url || mediaUrl;
    }
    if (!mediaText.includes('#EXTINF')) return fail('variant', 'playlist sem segmentos');
    const seg = firstUri(mediaText.slice(mediaText.indexOf('#EXTINF')).split('\n').slice(1).join('\n'));
    if (!seg) return fail('segment', 'segmento não encontrado');
    const r3 = await get(new URL(seg, mediaUrl).href, { range: 'bytes=0-2047' });
    if (r3.status !== 200 && r3.status !== 206) return fail('segment', `HTTP ${r3.status}`);
    const bytes = (await r3.arrayBuffer()).byteLength;
    if (bytes < 100) return fail('segment', `segmento vazio (${bytes} bytes)`);
    return { ok: true, stage: 'segment', detail: `${bytes} bytes`, ms: Date.now() - t0 };
  } catch (e) {
    return fail('network', e.message);
  }
}

function sample(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export async function verify({ root = process.cwd(), cfg, all = false, n, log = console } = {}) {
  cfg = cfg || JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  const text = await readFile(join(root, cfg.playlistPath), 'utf8');
  const lint = lintM3U(text);
  if (!lint.ok) throw new Error(`M3U inválida: ${lint.errors.slice(0, 5).join(' | ')}`);
  const items = parseM3U(text);
  const chosen = all ? items : sample(items, n ?? cfg.verify.sample);
  const results = await pMap(chosen, async (it) => ({ title: it.title, url: it.url, ...(await checkStream(it.url)) }), 4);
  const okCount = results.filter((r) => r.ok).length;
  const ratio = results.length ? okCount / results.length : 0;
  results.filter((r) => !r.ok).forEach((r) => log.warn(`FALHOU [${r.stage}] ${r.title}: ${r.detail}`));
  log.log(`Reprodução: ${okCount}/${results.length} OK (${Math.round(ratio * 100)}%)`);
  return { ratio, total: results.length, ok: okCount, results, minSuccess: cfg.verify.minSuccess };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = process.argv.includes('--all');
  const nArg = process.argv.find((a) => a.startsWith('--sample='));
  verify({ all, n: nArg ? Number(nArg.split('=')[1]) : undefined })
    .then(async (r) => {
      await writeFile('playlist/verify.json', JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2));
      if (r.ratio < r.minSuccess) { console.error(`Abaixo do mínimo (${r.minSuccess * 100}%)`); process.exit(1); }
    })
    .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
