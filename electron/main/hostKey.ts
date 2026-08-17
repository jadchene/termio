import { randomUUID } from 'node:crypto';
import { utils } from 'ssh2';
import type { Session } from './types';
import { get, run } from './db';
import { safeSend } from './window';
import { registerTrustedHandle } from './ipcSecurity';
import { formatHostKeyFingerprint } from './hostFingerprint';
import { verifyHostKeyTrust } from './hostKeyTrust';

export { formatHostKeyFingerprint } from './hostFingerprint';

type StoredHostKey = {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  key_base64: string;
};

type PendingHostKeyRequest = {
  connectionId: number;
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingHostKeyRequests = new Map<string, PendingHostKeyRequest>();

const normalizeHost = (host: string): string => host.trim().toLocaleLowerCase();

const getHostKeyAlgorithm = (key: Buffer): string => {
  try {
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error) return 'unknown';
    if (Array.isArray(parsed)) return parsed[0]?.type || 'unknown';
    return parsed.type || 'unknown';
  } catch {
    return 'unknown';
  }
};

const requestHostKeyConfirmation = (
  session: Session,
  connectionId: number,
  algorithm: string,
  fingerprint: string,
  expectedFingerprint?: string,
): Promise<boolean> => new Promise<boolean>((resolve) => {
  const requestId = randomUUID();
  const timer = setTimeout(() => {
    pendingHostKeyRequests.delete(requestId);
    safeSend('ssh:host-key-verification-expired', { requestId });
    resolve(false);
  }, 60_000);
  timer.unref();
  pendingHostKeyRequests.set(requestId, { connectionId, resolve, timer });
  safeSend(expectedFingerprint !== undefined ? 'ssh:host-key-mismatch' : 'ssh:host-key-verification', {
    requestId,
    sessionId: session.id,
    name: session.name,
    host: session.host,
    port: session.port,
    algorithm,
    fingerprint,
    ...(expectedFingerprint !== undefined
      ? { expectedFingerprint, actualFingerprint: fingerprint }
      : {}),
  });
});

const saveHostKey = async (
  host: string,
  port: number,
  algorithm: string,
  fingerprint: string,
  keyBase64: string,
): Promise<void> => {
  await run(
    `INSERT INTO ssh_host_key(host, port, algorithm, fingerprint, key_base64, updated_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, port) DO UPDATE SET
       algorithm = excluded.algorithm,
       fingerprint = excluded.fingerprint,
       key_base64 = excluded.key_base64,
       updated_at = excluded.updated_at`,
    [host, port, algorithm, fingerprint, keyBase64, Date.now()],
  );
};

export const verifySessionHostKey = async (
  session: Session,
  key: Buffer,
  onMismatchRejected?: () => void,
  connectionId = session.id,
): Promise<boolean> => {
  const host = normalizeHost(session.host);
  const port = Number(session.port);
  const keyBase64 = key.toString('base64');
  const fingerprint = formatHostKeyFingerprint(key);
  const algorithm = getHostKeyAlgorithm(key);
  const stored = await get<StoredHostKey>(
    'SELECT host, port, algorithm, fingerprint, key_base64 FROM ssh_host_key WHERE host = ? AND port = ?',
    [host, port],
  );
  return verifyHostKeyTrust({
    stored: stored
      ? { fingerprint: stored.fingerprint, keyBase64: stored.key_base64 }
      : undefined,
    keyBase64,
    requestConfirmation: (expectedFingerprint) => requestHostKeyConfirmation(
      session,
      connectionId,
      algorithm,
      fingerprint,
      expectedFingerprint,
    ),
    save: () => saveHostKey(host, port, algorithm, fingerprint, keyBase64),
    onMismatchRejected,
  });
};

export const createHostVerifier = (
  session: Session,
  onMismatchRejected?: () => void,
  connectionId = session.id,
) => (
  key: Buffer,
  callback: (accepted: boolean) => void,
): void => {
  void verifySessionHostKey(session, key, onMismatchRejected, connectionId).then(callback).catch((error) => {
    console.warn('[SSH] Host key verification failed:', error);
    callback(false);
  });
};

export const registerHostKeyIpc = (): void => {
  registerTrustedHandle('ssh:host-key-verification-response', async (_, requestId: string, accepted: boolean) => {
    const pending = pendingHostKeyRequests.get(String(requestId || ''));
    if (!pending) return false;
    pendingHostKeyRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(accepted === true);
    return true;
  });
};

export const cancelPendingHostKeyRequests = (connectionId?: number): void => {
  for (const [requestId, pending] of pendingHostKeyRequests) {
    if (connectionId !== undefined && pending.connectionId !== connectionId) continue;
    clearTimeout(pending.timer);
    safeSend('ssh:host-key-verification-expired', { requestId });
    pending.resolve(false);
    pendingHostKeyRequests.delete(requestId);
  }
};
