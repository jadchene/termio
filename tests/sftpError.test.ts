import assert from 'node:assert/strict';
import test from 'node:test';
import { isSilentSftpError } from '../src/utils/sftpError';

test('SFTP connection-state errors do not interrupt the user with alerts', () => {
  assert.equal(isSilentSftpError({ code: 'NOT_CONNECTED', message: 'SSH 未连接' }), true);
  assert.equal(isSilentSftpError({ code: 'CONNECTION_CLOSED', message: 'Connection lost' }), true);
  assert.equal(isSilentSftpError({ code: 'CANCELLED', message: 'Operation cancelled' }), true);
});

test('actionable SFTP errors still show alerts', () => {
  assert.equal(isSilentSftpError({ code: 'NOT_FOUND', message: 'No such file' }), false);
  assert.equal(isSilentSftpError({ code: 'PERMISSION_DENIED', message: 'Permission denied' }), false);
  assert.equal(isSilentSftpError({ code: 'UNKNOWN', message: 'Unexpected error' }), false);
});
