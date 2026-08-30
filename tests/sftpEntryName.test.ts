import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSftpEntryName } from '../src/utils/sftpEntryName';

test('SFTP names are trimmed and reject path traversal', () => {
  assert.deepEqual(validateSftpEntryName(' release '), { value: 'release', error: null });
  assert.match(validateSftpEntryName('../backup').error || '', /不能包含/);
  assert.match(validateSftpEntryName('..').error || '', /不能是/);
  assert.match(validateSftpEntryName('  ').error || '', /不能为空/);
});
