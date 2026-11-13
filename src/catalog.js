import { itemId } from './pluto.js';

const pickCover = (item) => {
  const covers = item.covers || [];
  for (const ratio of ['2:3', '16:9']) {
    const c = covers.find((x) => x.aspectRatio === ratio && x.url);
    if (c) return c.url;
  }
  return covers.find((x) => x.url)?.url || item.featuredImage?.path || '';
};

export const entryKey = (id, category) => `${id}@${category}`;

export function normalizeMovie(item, category) {
  const id = itemId(item);
  if (!id || !item.name) return null;
  return {
    key: entryKey(id, category), id, type: 'movie', title: item.name, category,
    logo: pickCover(item), rating: item.rating || '', durationSec: Math.round((item.duration || 0) / 1000),
  };
}

export function normalizeEpisode(series, season, ep, category) {
  const id = itemId(ep);
  if (!id) return null;
  const s = String(season.number ?? 0).padStart(2, '0');
  const e = String(ep.number ?? 0).padStart(2, '0');
  return {
    key: entryKey(id, category), id, type: 'episode',
    title: `${series.name} - T${s}E${e} - ${ep.name || 'Episódio'}`,
    category, logo: pickCover(ep) || pickCover(series),
    rating: ep.rating || series.rating || '', durationSec: Math.round((ep.duration || 0) / 1000),
  };
}

/**
 * Junta o catálogo novo com o estado anterior.
 * - presentes agora: ativos (atualiza metadados, zera missCount)
 * - ausentes: missCount+1; removidos quando missCount >= graceRuns
 * - novos: adicionados com firstSeen
 */
export function mergeState(prev, fresh, categories, { now, graceRuns = 2, minKeepRatio = 0.5 } = {}) {
  const prevEntries = prev?.entries || {};
  const prevCount = Object.keys(prevEntries).length;
  if (prevCount > 20 && fresh.length < prevCount * minKeepRatio) {
    throw new Error(
      `Catálogo novo suspeito: ${fresh.length} itens contra ${prevCount} anteriores ` +
        `(mínimo ${Math.round(minKeepRatio * 100)}%). Estado anterior preservado.`
    );
  }
  const entries = {};
  const stats = { added: 0, kept: 0, pending: 0, removed: 0 };
  fresh.forEach((e, order) => {
    const old = prevEntries[e.key];
    entries[e.key] = { ...e, order, firstSeen: old?.firstSeen || now, lastSeen: now, missCount: 0 };
    if (old) stats.kept++; else stats.added++;
  });
  for (const [key, old] of Object.entries(prevEntries)) {
    if (entries[key]) continue;
    const miss = (old.missCount || 0) + 1;
    if (miss >= graceRuns) { stats.removed++; continue; }
    entries[key] = { ...old, missCount: miss };
    stats.pending++;
  }
  const used = new Set(Object.values(entries).map((e) => e.category));
  const cats = categories.filter((c) => used.has(c));
  for (const c of used) if (!cats.includes(c)) cats.push(c);
  const state = {
    meta: { lastRun: now, runs: (prev?.meta?.runs || 0) + 1 },
    categories: cats,
    entries,
  };
  return { state, stats };
}

export function orderedEntries(state) {
  const idx = new Map(state.categories.map((c, i) => [c, i]));
  return Object.values(state.entries).sort(
    (a, b) => idx.get(a.category) - idx.get(b.category) || a.order - b.order
  );
}
