import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlutoClient, itemId } from './pluto.js';
import { normalizeMovie, normalizeEpisode, mergeState, orderedEntries } from './catalog.js';
import { buildM3U, lintM3U } from './m3u.js';
import { pMap } from './http.js';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export async function collect(client, cfg, log = console) {
  const cats = await client.fetchCategories();
  log.log(`Categorias encontradas: ${cats.length}`);
  const fresh = [];
  const order = [];
  const perCat = await pMap(cats, async (cat) => {
    if (cfg.excludeCategories.includes(cat.name)) return [];
    const items = await client.fetchCategoryItems(cat);
    const out = [];
    for (const it of items) {
      if (it.type === 'movie' || (!it.type && !cfg.includeSeries)) {
        const e = normalizeMovie(it, cat.name);
        if (e) out.push(e);
      } else if (it.type === 'series' && cfg.includeSeries) {
        try {
          for (const season of await client.fetchSeasons(itemId(it))) {
            for (const ep of season.episodes || []) {
              const e = normalizeEpisode(it, season, ep, cat.name);
              if (e) out.push(e);
            }
          }
        } catch (err) {
          log.warn(`Série ${it.name}: ${err.message}`);
        }
      }
    }
    return out;
  }, cfg.concurrency);
  cats.forEach((cat, i) => {
    const list = perCat[i];
    if (!list.length) return;
    const seen = new Set();
    for (const e of list) if (!seen.has(e.key)) { seen.add(e.key); fresh.push(e); }
    if (!order.includes(cat.name)) order.push(cat.name);
  });
  return { fresh, categories: order };
}

export async function run({ root = process.cwd(), cfg, env = process.env, now = new Date().toISOString(), log = console } = {}) {
  cfg = cfg || (await readJson(join(root, 'config.json'), {}));
  const baseUrl = env.RESOLVER_BASE_URL;
  if (!baseUrl) throw new Error('Defina RESOLVER_BASE_URL (URL do Cloudflare Worker, ex.: https://pluto.seu-user.workers.dev).');

  const statePath = resolve(root, cfg.statePath);
  const prev = await readJson(statePath, null);

  const client = new PlutoClient(cfg, env, log);
  await client.boot();
  const { fresh, categories } = await collect(client, cfg, log);
  if (!fresh.length) throw new Error('Nenhum título coletado; nada foi alterado.');

  const { state, stats } = mergeState(prev, fresh, categories, { now, graceRuns: cfg.graceRuns, minKeepRatio: cfg.minKeepRatio });
  const entries = orderedEntries(state);
  const m3u = buildM3U(entries, { baseUrl, ...cfg.ssiptv, contentType: cfg.ssiptv.contentType, playlistTitle: cfg.playlistTitle });
  const lint = lintM3U(m3u);
  if (!lint.ok) throw new Error(`M3U inválida:\n${lint.errors.slice(0, 10).join('\n')}`);

  await writeAtomic(statePath, JSON.stringify(state, null, 1) + '\n');
  await writeAtomic(resolve(root, cfg.playlistPath), m3u);
  const report = { generatedAt: now, country: client.session.country, total: entries.length, categories: state.categories.length, ...stats };
  await writeAtomic(resolve(root, cfg.reportPath), JSON.stringify(report, null, 2) + '\n');
  log.log(`OK: ${entries.length} títulos em ${state.categories.length} categorias (+${stats.added} novos, ${stats.pending} pendentes, -${stats.removed} removidos)`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
