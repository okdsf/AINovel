import test from 'node:test';
import assert from 'node:assert/strict';
import {workerRecentlyConnected} from '../server/automation-routes.js';

test('a background page remains connected between minute-spaced heartbeats', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  for (const age of [0, 30_000, 45_000, 60_000, 89_999]) {
    assert.equal(workerRecentlyConnected(new Date(now - age).toISOString(), now), true);
  }
  for (const age of [90_000, 120_000, 3_600_000]) {
    assert.equal(workerRecentlyConnected(new Date(now - age).toISOString(), now), false);
  }
});

test('missing, malformed and future presence timestamps never imply a connection', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  for (const value of [null, undefined, '', 'invalid', '2026-09-15T13:00:00Z']) {
    assert.equal(workerRecentlyConnected(value, now), false);
  }
});
