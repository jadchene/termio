import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeUploadCapability, createUploadCapability } from '../electron/main/uploadCapability';

test('upload capability is sender-bound and single-use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termio-upload-capability-'));
  const filePath = path.join(root, 'upload.txt');
  fs.writeFileSync(filePath, 'test');
  try {
    const wrongSenderToken = createUploadCapability(10, [filePath]);
    assert.throws(() => consumeUploadCapability(wrongSenderToken, 11), /无效或已过期/);

    const token = createUploadCapability(10, [filePath]);
    assert.deepEqual(consumeUploadCapability(token, 10), [fs.realpathSync.native(filePath)]);
    assert.throws(() => consumeUploadCapability(token, 10), /无效或已过期/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upload capability rejects non-existent and relative paths', () => {
  assert.throws(() => createUploadCapability(10, ['relative.txt']), /绝对路径/);
  assert.throws(() => createUploadCapability(10, [path.join(os.tmpdir(), 'termio-missing-file')]), /ENOENT/);
});
