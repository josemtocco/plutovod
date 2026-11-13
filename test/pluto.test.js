import test from 'node:test';
import assert from 'node:assert/strict';
import { PlutoClient } from '../src/pluto.js';

test('X-Forwarded-For: secret (env) tem prioridade sobre config', () => {
  const a = new PlutoClient({ forwardedForIp: '1.1.1.1' }, { FORWARDED_FOR_IP: '2.2.2.2' });
  assert.equal(a.headers()['x-forwarded-for'], '2.2.2.2');
  const b = new PlutoClient({ forwardedForIp: '1.1.1.1' }, {});
  assert.equal(b.headers()['x-forwarded-for'], '1.1.1.1');
  const c = new PlutoClient({ forwardedForIp: '' }, {});
  assert.equal(c.headers()['x-forwarded-for'], undefined);
});
