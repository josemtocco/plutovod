// Servidor Pluto simulado (boot + VOD + stitcher HLS) para testes sem internet.
import http from 'node:http';

export const movie = (id, name, extra = {}) => ({
  id, name, type: 'movie', duration: 5400000, rating: '14',
  covers: [{ aspectRatio: '2:3', url: `https://img.test/${id}.jpg` }], ...extra,
});

export function startMock() {
  const st = { token: 'tok123', country: 'BR', categories: [], series: {}, bootCalls: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = u.pathname;
    if (p === '/boot') {
      st.bootCalls++;
      return json({ sessionToken: st.token, stitcherParams: 'appName=web&deviceId=abc', servers: { stitcher: st.url }, session: { countryCode: st.country } });
    }
    if (p.startsWith('/vod/')) {
      if (req.headers.authorization !== `Bearer ${st.token}`) return json({ error: 'unauthorized' }, 401);
      if (p === '/vod/categories') {
        const page = Number(u.searchParams.get('page') || 1);
        const slice = st.categories.slice((page - 1) * 2, page * 2).map((c) => ({ id: c.id, name: c.name, items: c.items.slice(0, 100) }));
        return json({ categories: slice });
      }
      let m = p.match(/^\/vod\/categories\/([^/]+)\/items$/);
      if (m) {
        const c = st.categories.find((x) => x.id === m[1]);
        const page = Number(u.searchParams.get('page') || 1);
        return json({ items: c ? c.items.slice((page - 1) * 100, page * 100) : [] });
      }
      m = p.match(/^\/vod\/series\/([^/]+)\/seasons$/);
      if (m) return st.series[m[1]] ? json({ seasons: st.series[m[1]] }) : json({}, 404);
      return json({}, 404);
    }
    m: {
      const m = p.match(/^\/v2\/stitch\/hls\/episode\/([^/]+)\/(master\.m3u8|720\/playlist\.m3u8)$/);
      if (!m) break m;
      if (u.searchParams.get('jwt') !== st.token) { res.writeHead(401); return res.end('no jwt'); }
      if (m[1].startsWith('dead')) { res.writeHead(404); return res.end('gone'); }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      if (m[2] === 'master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720/playlist.m3u8?jwt=' + st.token + '\n');
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n/seg/1.ts?jwt=' + st.token + '\n#EXT-X-ENDLIST\n');
    }
    if (p === '/seg/1.ts') {
      const b = Buffer.alloc(2048, 0x47);
      res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'video/mp2t' });
      return res.end(b);
    }
    res.writeHead(404); res.end('nf');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    st.url = `http://127.0.0.1:${server.address().port}`;
    resolve({ st, url: st.url, close: () => new Promise((r) => server.close(r)) });
  }));
}
