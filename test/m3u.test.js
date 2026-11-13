import test from 'node:test';
import assert from 'node:assert/strict';
import { buildM3U, lintM3U, parseM3U, playUrl } from '../src/m3u.js';

const entries = [
  { id: 'abc123', title: 'Filme, "Teste"', category: 'Ação, Aventura', logo: 'https://i/x.jpg' },
  { id: 'def456', title: 'Outro', category: 'Drama', logo: '' },
];

test('M3U tem content-type="video", #EXTSIZE:medium e grupos', () => {
  const t = buildM3U(entries, { baseUrl: 'https://w.dev/', contentType: 'video', extSize: 'medium' });
  assert.match(t, /^#EXTM3U\n/);
  assert.equal((t.match(/#EXTSIZE:medium/g) || []).length, 2);
  assert.match(t, /content-type="video"/);
  assert.match(t, /group-title="Ação  Aventura"/);
  assert.ok(t.includes('https://w.dev/play/abc123.m3u8'));
  assert.ok(lintM3U(t).ok);
  const p = parseM3U(t);
  assert.equal(p.length, 2);
  assert.equal(p[0].attrs['group-title'], 'Ação  Aventura');
});

test('links são curtos', () => {
  assert.ok(playUrl('https://w.dev', '60d9fd1c89632c0013eb2155').length < 80);
});

test('lint detecta erros', () => {
  assert.equal(lintM3U('#EXTM3U\n#EXTINF:-1 group-title="A",T\nftp://x\n').ok, false);
  assert.equal(lintM3U('nada').ok, false);
});
