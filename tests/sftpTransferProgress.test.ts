import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSftpTransferPercent, finalizeSftpTransferProgress } from '../src/utils/sftpTransferProgress';

test('multiple-file SFTP progress uses completed item count', () => {
  assert.equal(calculateSftpTransferPercent({
    totalCount: 10,
    completedCount: 5,
    transferred: 90,
    total: 100,
  }), 50);
  assert.equal(calculateSftpTransferPercent({
    totalCount: 10,
    completedCount: 6,
    transferred: 1,
    total: 100,
  }), 60);
});

test('single-file SFTP progress keeps byte-based percentage', () => {
  assert.equal(calculateSftpTransferPercent({
    totalCount: 1,
    completedCount: 0,
    transferred: 25,
    total: 100,
  }), 25);
});

test('completed SFTP progress reaches 100 before the row is removed', () => {
  assert.deepEqual(finalizeSftpTransferProgress({
    totalCount: 1,
    completedCount: 0,
    transferred: 63,
    total: 100,
  }), {
    totalCount: 1,
    completedCount: 1,
    transferred: 100,
    total: 100,
    percent: 100,
  });
});
