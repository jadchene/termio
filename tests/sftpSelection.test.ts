import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSftpContextTargets } from '../src/utils/sftpSelection';

test('right-clicking an item in the current selection targets the full selection', () => {
  assert.deepEqual(
    resolveSftpContextTargets('/srv/b', ['/srv/a', '/srv/b', '/srv/c']),
    ['/srv/a', '/srv/b', '/srv/c'],
  );
});

test('right-clicking outside the current selection targets only that item', () => {
  assert.deepEqual(
    resolveSftpContextTargets('/srv/d', ['/srv/a', '/srv/b']),
    ['/srv/d'],
  );
});
