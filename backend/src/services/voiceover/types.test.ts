import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineSignature } from './types.js';

test('timelineSignature orders segments by index regardless of input order', () => {
  const a = timelineSignature([
    { index: 2, version: 1 },
    { index: 0, version: 3 },
    { index: 1, version: 2 },
  ]);
  assert.equal(a, '0:3,1:2,2:1');
});

test('timelineSignature treats a missing version as version 1', () => {
  assert.equal(timelineSignature([{ index: 0 }, { index: 1, version: 1 }]), '0:1,1:1');
});

test('timelineSignature changes when any segment version changes', () => {
  const before = timelineSignature([{ index: 0, version: 1 }, { index: 1, version: 1 }]);
  const after = timelineSignature([{ index: 0, version: 1 }, { index: 1, version: 2 }]);
  assert.notEqual(before, after);
});

test('timelineSignature does not mutate its input', () => {
  const input = [{ index: 1 }, { index: 0 }];
  timelineSignature(input);
  assert.deepEqual(input, [{ index: 1 }, { index: 0 }]);
});

test('timelineSignature of an empty timeline is an empty string', () => {
  assert.equal(timelineSignature([]), '');
});
