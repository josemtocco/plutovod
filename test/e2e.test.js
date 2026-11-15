import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, movie } from './mock-pluto.js';
import { handleRequest, absolutize } from '../worker/worker.js';
import { run } from '../src/build.js';
import { verify, checkStream } from '../src/verify.js';
import { parseM3U } from '../src/m3u.js';

const silent = { log() {}, warn() {}, error() {} };

function startWorker(env) {
  const server = http.createServer(async (req, res) => {
    const r = await handleRequest(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

const bigCategory = Array.from({ length: 130 }, (_, i) => movie(`big${String(i).padStart(3, '0')}x`, `Grande ${i}`));

test('fluxo completo: coleta paginada -> M3U -> Worker -> reprodução', async () => {
  const mock = await startMock();
  const root = await mkdtemp(join(tmpdir(), 'pluto-'));
  const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  cfg.includeSeries = true;
  const worker = await startWorker({ PLUTO_BOOT_URL: `${mock.url}/boot`, PLUTO_VOD_URL: `${mock.url}/vod`, ALLOWED_HOSTS: '127.0.0.1' });
  const env = { PLUTO_BOOT_URL: `${mock.url}/boot`, PLUTO_VOD_URL: `${mock.url}/vod`, RESOLVER_BASE_URL: worker.url };
  try {
    mock.st.categories = [
      { id: 'c1', name: 'Ação', items: [movie('act0001', 'Ação 1'), movie('act0002', 'Ação 2'), movie('dead001', 'Quebrado'), { id: 'ser0001', name: 'Série X', type: 'series' }] },
      { id: 'c2', name: 'Drama', items: [movie('dra0001', 'Drama 1')] },
      { id: 'c3', name: 'Muitos', items: bigCategory },
    ];
    mock.st.series.ser0001 = [{ number: 1, episodes: [{ _id: 'epi0001', name: 'Piloto', number: 1, duration: 1000 }] }];

    const rep = await run({ root, cfg, env, now: 'r1', log: silent });
    assert.equal(rep.total, 3 + 1 + 1 + 130); // inclui episódio e as 130 de "Muitos" (paginação)
    const m3u = await readFile(join(root, cfg.playlistPath), 'utf8');
    const items = parseM3U(m3u);
    assert.deepEqual([...new Set(items.map((i) => i.attrs['group-title']))], ['Ação', 'Drama', 'Muitos']);
    assert.ok(items.every((i) => i.attrs['content-type'] === 'video'));
    assert.ok(m3u.includes('#EXTSIZE:medium'));

    // reprodução real via Worker (testa só 3 itens bons + o quebrado)
    assert.equal((await checkStream(`${worker.url}/play/act0001.m3u8`)).ok, true);
    assert.equal((await checkStream(`${worker.url}/play/epi0001.m3u8`)).ok, true);
    const dead = await checkStream(`${worker.url}/play/dead001.m3u8`);
    assert.equal(dead.ok, false);
    assert.equal(dead.stage, 'master');
    const v = await verify({ root, cfg, all: true, log: silent });
    assert.equal(v.total, 135);
    assert.equal(v.ok, 134); // só "Quebrado" falha

    // atualização: um filme sai, um novo entra
    mock.st.categories[0].items = [movie('act0001', 'Ação 1'), movie('act0003', 'Ação 3 (novo)'), movie('dead001', 'Quebrado'), { id: 'ser0001', name: 'Série X', type: 'series' }];
    let r2 = await run({ root, cfg, env, now: 'r2', log: silent });
    assert.equal(r2.added, 1);
    assert.equal(r2.pending, 1);
    r2 = await run({ root, cfg, env, now: 'r3', log: silent });
    assert.equal(r2.removed, 1);
    const ids = parseM3U(await readFile(join(root, cfg.playlistPath), 'utf8')).map((i) => i.url);
    assert.ok(ids.some((u) => u.includes('act0003')));
    assert.ok(!ids.some((u) => u.includes('act0002')));

    // catálogo vazio não destrói a lista
    mock.st.categories = [];
    await assert.rejects(run({ root, cfg, env, now: 'r4', log: silent }), /Nenhum título/);
    assert.ok((await readFile(join(root, cfg.playlistPath), 'utf8')).includes('act0003'));

    // país errado é rejeitado
    mock.st.country = 'US';
    await assert.rejects(run({ root, cfg, env, now: 'r5', log: silent }), /país "US"/);
  } finally {
    await worker.close();
    await mock.close();
  }
});

test('Worker: ID inválido, modo redirect e manifesto absoluto', async () => {
  const mock = await startMock();
  const env = { PLUTO_BOOT_URL: `${mock.url}/boot`, PLUTO_VOD_URL: `${mock.url}/vod`, ALLOWED_HOSTS: '127.0.0.1' };
  try {
    assert.equal((await handleRequest(new Request('http://w/play/../../etc'), env)).status, 404);
    assert.equal((await handleRequest(new Request('http://w/play/a.m3u8'), env)).status, 404);
    const red = await handleRequest(new Request('http://w/play/abc1234.m3u8?mode=redirect'), env);
    assert.equal(red.status, 302);
    assert.match(red.headers.get('location'), /\/v2\/stitch\/hls\/episode\/abc1234\/master\.m3u8\?.*jwt=tok123/);
    const ok = await handleRequest(new Request('http://w/play/abc1234.m3u8'), env);
    const master = await ok.text();
    assert.match(master, /^#EXTM3U[\s\S]*http:\/\/w\/hls\?u=/);
    // a variante passa pelo Worker e o JWT é anexado
    const u = master.match(/hls\?u=(\S+)/)[1];
    const dec = Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    assert.match(dec, /\/720\/playlist\.m3u8\?.*jwt=tok123/);
    // sem o Worker (link direto sem token) a Pluto simulada responde 401, como no erro real
    assert.equal((await fetch(`${mock.url}/v2/stitch/hls/episode/abc1234/720/playlist.m3u8`)).status, 401);
    const variant = await handleRequest(new Request(`http://w/hls?u=${u}`), env);
    assert.equal(variant.status, 200);
    assert.match(await variant.text(), /seg\/1\.ts\?.*jwt=tok123/);
    // SSRF: host fora da lista é bloqueado
    const evil = Buffer.from('https://evil.example/x.m3u8').toString('base64url');
    assert.equal((await handleRequest(new Request(`http://w/hls?u=${evil}`), env)).status, 403);
    // debug mostra o manifesto sem expor o JWT
    const dbg = await (await handleRequest(new Request('http://w/debug/abc1234'), env)).text();
    assert.match(dbg, /status: 200/);
    assert.ok(!dbg.includes('tok123'));
    assert.equal(absolutize('#EXT-X-MEDIA:URI="a.m3u8"\nb.m3u8', 'https://h/x/m.m3u8'), '#EXT-X-MEDIA:URI="https://h/x/a.m3u8"\nhttps://h/x/b.m3u8');
  } finally {
    await mock.close();
  }
});
