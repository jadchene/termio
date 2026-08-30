import assert from 'node:assert/strict';
import test from 'node:test';
import { clampContextMenuPosition } from '../src/utils/contextMenuPosition';

test('keeps a context menu inside the bottom-right viewport edge', () => {
  assert.deepEqual(
    clampContextMenuPosition(995, 795, 1000, 800, 148, 168, 8),
    { left: 844, top: 624 },
  );
});

test('keeps a context menu away from the top-left viewport edge', () => {
  assert.deepEqual(
    clampContextMenuPosition(-10, 2, 1000, 800),
    { left: 8, top: 8 },
  );
});
