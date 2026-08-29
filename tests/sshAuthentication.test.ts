import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSshAuthentication, expandPrivateKeyPath, readPrivateKey } from '../electron/main/sshAuthentication';
import type { Session } from '../electron/main/types';

const baseSession: Session = {
  id: 1,
  folder_id: null,
  name: 'key-session',
  host: 'example.test',
  port: 22,
  username: 'root',
  auth_type: 'private_key',
  password: '',
  remember_password: 0,
  private_key_path: '',
  passphrase: 'secret',
  remember_passphrase: 1,
  default_session: 0,
};

test('private-key authentication reads the selected key and disables password fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termio-key-'));
  const keyPath = path.join(directory, 'id_ed25519');
  await fs.writeFile(keyPath, 'test-private-key');
  const authentication = await buildSshAuthentication({ ...baseSession, private_key_path: keyPath });
  assert.equal(Buffer.isBuffer(authentication.privateKey), true);
  assert.equal(authentication.privateKey?.toString(), 'test-private-key');
  assert.equal(authentication.passphrase, 'secret');
  assert.equal(authentication.tryKeyboard, false);
});

test('private-key reader rejects directories and oversized files before connecting', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termio-key-invalid-'));
  await assert.rejects(readPrivateKey(directory), /不是文件/);
  const largePath = path.join(directory, 'large-key');
  await fs.writeFile(largePath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readPrivateKey(largePath), /超过 1 MiB/);
});

test('tilde private-key paths expand to the current home directory', () => {
  assert.equal(expandPrivateKeyPath('~/.ssh/id_rsa'), path.join(os.homedir(), '.ssh/id_rsa'));
});
