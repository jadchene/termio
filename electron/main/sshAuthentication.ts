import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectConfig } from 'ssh2';
import type { Session } from './types';

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;

export const expandPrivateKeyPath = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
};

export async function readPrivateKey(privateKeyPath: string): Promise<Buffer> {
  const expandedPath = expandPrivateKeyPath(privateKeyPath);
  if (!expandedPath) throw new Error('未配置 SSH 私钥文件');
  let stats;
  try {
    stats = await fs.stat(expandedPath);
  } catch {
    throw new Error(`无法读取 SSH 私钥文件：${expandedPath}`);
  }
  if (!stats.isFile()) throw new Error('SSH 私钥路径不是文件');
  if (stats.size <= 0) throw new Error('SSH 私钥文件为空');
  if (stats.size > MAX_PRIVATE_KEY_BYTES) throw new Error('SSH 私钥文件超过 1 MiB，已拒绝读取');
  try {
    return await fs.readFile(expandedPath);
  } catch {
    throw new Error(`无法读取 SSH 私钥文件：${expandedPath}`);
  }
}

export async function buildSshAuthentication(session: Session): Promise<Pick<ConnectConfig,
  'password' | 'privateKey' | 'passphrase' | 'tryKeyboard'>> {
  if (session.auth_type === 'private_key') {
    return {
      privateKey: await readPrivateKey(session.private_key_path),
      passphrase: session.passphrase || undefined,
      tryKeyboard: false,
    };
  }
  return {
    password: session.password,
    tryKeyboard: true,
  };
}
