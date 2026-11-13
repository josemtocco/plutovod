import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState, normalizeMovie, orderedEntries } from '../src/catalog.js';
import { movie } from './mock-pluto.js';

const mk = (ids, cat = 'A') => ids.map((i) => normalizeMovie(movie(i, `Filme ${i}`), cat));

test('mantém ativos, adiciona novos, remove inativos após a tolerância', () => {
  let r = mergeState(null, mk(['a1', 'a2', 'a3']), ['A'], { now: 't1', graceRuns: 2 });
  assert.equal(r.stats.added, 3);
  r = mergeState(r.state, mk(['a1', 'a2', 'a4']), ['A'], { now: 't2', graceRuns: 2 });
  assert.deepEqual([r.stats.added, r.stats.kept, r.stats.pending, r.stats.removed], [1, 2, 1, 0]);
  assert.ok(r.state.entries['a3@A']); // ainda mantido (1ª ausência)
  r = mergeState(r.state, mk(['a1', 'a2', 'a4']), ['A'], { now: 't3', graceRuns: 2 });
  assert.equal(r.stats.removed, 1);
  assert.equal(r.state.entries['a3@A'], undefined);
  assert.equal(r.state.entries['a1@A'].firstSeen, 't1');
});

test('aborta se o catálogo novo encolher demais', () => {
  const big = mergeState(null, mk(Array.from({ length: 40 }, (_, i) => `id${i}xx`)), ['A'], { now: 't1' });
  assert.throws(() => mergeState(big.state, mk(['id0xx']), ['A'], { now: 't2' }), /suspeito/);
});

test('ordena por categoria do site', () => {
  const fresh = [...mk(['b1'], 'B'), ...mk(['a1'], 'A')];
  const { state } = mergeState(null, fresh, ['B', 'A'], { now: 't' });
  assert.deepEqual(orderedEntries(state).map((e) => e.id), ['b1', 'a1']);
});
