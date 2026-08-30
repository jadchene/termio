import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSftpState, updateSessionSftpState } from '../src/utils/sessionSftpState';

test('SFTP navigation state remains isolated by connection tab', () => {
  const first = updateSessionSftpState(new Map(), 11, (state) => ({ ...state, path: '/srv/first' }));
  const second = updateSessionSftpState(first, 22, (state) => ({ ...state, path: '/home/second' }));

  assert.equal(second.get(11)?.path, '/srv/first');
  assert.equal(second.get(22)?.path, '/home/second');
  assert.equal(first.has(22), false);
  assert.deepEqual(createSessionSftpState(), {
    path: '~',
    pathInput: '~',
    items: [],
    selectedPaths: [],
    loading: false,
  });
});
