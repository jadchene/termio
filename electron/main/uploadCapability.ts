import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CAPABILITY_TTL_MS = 2 * 60 * 1000;
const MAX_PATHS_PER_CAPABILITY = 100;
const MAX_ACTIVE_CAPABILITIES = 256;

type UploadCapability = {
  senderId: number;
  localPaths: string[];
  expiresAt: number;
};

const capabilities = new Map<string, UploadCapability>();

function purgeExpired(now = Date.now()): void {
  for (const [token, capability] of capabilities) {
    if (capability.expiresAt <= now) capabilities.delete(token);
  }
}

export function createUploadCapability(senderId: number, requestedPaths: unknown): string {
  purgeExpired();
  if (!Number.isSafeInteger(senderId) || senderId <= 0) throw new Error('无效的上传来源窗口');
  if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) throw new Error('未提供可上传的本地文件');
  if (requestedPaths.length > MAX_PATHS_PER_CAPABILITY) throw new Error(`单次最多拖入 ${MAX_PATHS_PER_CAPABILITY} 个路径`);
  if (capabilities.size >= MAX_ACTIVE_CAPABILITIES) throw new Error('待处理上传授权过多，请稍后重试');

  const localPaths = Array.from(new Set(requestedPaths.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      throw new Error('上传路径格式无效');
    }
    if (!path.isAbsolute(value)) throw new Error('上传路径必须是绝对路径');
    return fs.realpathSync.native(value);
  })));
  const token = randomUUID();
  capabilities.set(token, {
    senderId,
    localPaths,
    expiresAt: Date.now() + CAPABILITY_TTL_MS,
  });
  return token;
}

export function consumeUploadCapability(tokenInput: unknown, senderId: number): string[] {
  purgeExpired();
  if (typeof tokenInput !== 'string' || tokenInput.length > 128) throw new Error('上传授权格式无效');
  const capability = capabilities.get(tokenInput);
  capabilities.delete(tokenInput);
  if (!capability || capability.senderId !== senderId) throw new Error('上传授权无效或已过期');
  return capability.localPaths;
}
