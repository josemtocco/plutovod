import { randomUUID } from 'node:crypto';
import { fetchRetry, UA } from './http.js';

const qs = (o) => new URLSearchParams(o).toString();
export const itemId = (i) => i && (i.id || i._id);

export class PlutoClient {
  constructor(cfg, env = process.env, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.bootUrl = env.PLUTO_BOOT_URL || 'https://boot.pluto.tv/v4/start';
    this.vodUrl = (env.PLUTO_VOD_URL || 'https://service-vod.clusters.pluto.tv/v4/vod').replace(/\/+$/, '');
    this.session = null;
  }

  headers(extra = {}) {
    const h = {
      'user-agent': UA,
      accept: 'application/json',
      origin: 'https://pluto.tv',
      referer: 'https://pluto.tv/',
      ...extra,
    };
    if (this.cfg.forwardedForIp) h['x-forwarded-for'] = this.cfg.forwardedForIp;
    return h;
  }

  async boot() {
    const params = qs({
      appName: 'web', appVersion: '9.0.0-0', deviceVersion: '124.0.0', deviceModel: 'web',
      deviceMake: 'chrome', deviceType: 'web', clientID: randomUUID(), clientModelNumber: '1.0.0',
      serverSideAds: 'false', drmCapabilities: 'widevine:L3', blockingMode: '',
      notificationVersion: '1', appLaunchCount: '', lastAppLaunchDate: '',
    });
    const res = await fetchRetry(`${this.bootUrl}?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`boot falhou: HTTP ${res.status}`);
    const d = await res.json();
    if (!d.sessionToken) throw new Error('boot sem sessionToken');
    const country = d.session?.countryCode || d.countryCode || null;
    this.session = { token: d.sessionToken, country };
    if (this.cfg.requireCountry && country && country !== this.cfg.country) {
      throw new Error(
        `A Pluto respondeu para o país "${country}", esperado "${this.cfg.country}". ` +
          'Configure forwardedForIp com um IP brasileiro ou use um runner no Brasil.'
      );
    }
    if (!country) this.log.warn?.('Aviso: boot não informou o país; não foi possível confirmar BR.');
    return this.session;
  }

  async get(path, retry401 = true) {
    if (!this.session) await this.boot();
    const res = await fetchRetry(`${this.vodUrl}${path}`, {
      headers: this.headers({ authorization: `Bearer ${this.session.token}` }),
    });
    if (res.status === 401 && retry401) {
      this.session = null;
      return this.get(path, false);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
    return res.json();
  }

  /** Todas as categorias (paginadas), com os primeiros itens de cada uma. */
  async fetchCategories() {
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= 50; page++) {
      const d = await this.get(
        `/categories?${qs({ includeItems: 'true', offset: '1000', page: String(page), sort: 'number:asc' })}`
      );
      const fresh = (d.categories || []).filter((c) => !seen.has(itemId(c)));
      if (!fresh.length) break;
      for (const c of fresh) { seen.add(itemId(c)); out.push(c); }
    }
    return out;
  }

  /** Itens de uma categoria; segue paginando ("carregar mais") até acabar. */
  async fetchCategoryItems(cat) {
    const items = [...(cat.items || [])];
    const seen = new Set(items.map(itemId));
    const size = this.cfg.categoryPageSize;
    if (items.length < size) return items;
    for (let page = 2; page <= 200; page++) {
      let d;
      try {
        d = await this.get(`/categories/${itemId(cat)}/items?${qs({ offset: String(size), page: String(page) })}`);
      } catch (e) {
        this.log.warn?.(`Paginação da categoria "${cat.name}" parou na página ${page}: ${e.message}`);
        break;
      }
      const more = (d.items || []).filter((i) => !seen.has(itemId(i)));
      if (!more.length) break;
      for (const i of more) { seen.add(itemId(i)); items.push(i); }
    }
    return items;
  }

  async fetchSeasons(seriesId) {
    const d = await this.get(`/series/${seriesId}/seasons`);
    return d.seasons || [];
  }
}
