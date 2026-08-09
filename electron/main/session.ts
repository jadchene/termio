import { Client } from 'ssh2';
import keytar from 'keytar';
import { Session } from './types';
import { get } from './db';
import { sshStateMap, sftpMap, sftpBatchControlMap, connectionSessionMap, connectionHomeMap, cwdOutputTailMap, lastKnownCwdMap, KEYTAR_SERVICE, remoteMetricsSnapshotMap, remoteMetricsPayloadMap, sharedState } from './state';

export function toKeytarAccount(sessionId: number): string {
  return `session:${sessionId}`;
}

export async function getSessionPasswordFromKeytar(sessionId: number): Promise<string | null> {
  return keytar.getPassword(KEYTAR_SERVICE, toKeytarAccount(sessionId));
}

export async function setSessionPasswordToKeytar(sessionId: number, password: string): Promise<void> {
  await keytar.setPassword(KEYTAR_SERVICE, toKeytarAccount(sessionId), password);
}

export async function deleteSessionPasswordFromKeytar(sessionId: number): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, toKeytarAccount(sessionId));
}

export function toPublicSession(session: Session): Session {
  return {
    ...session,
    password: '',
  };
}

export async function hydrateSessionPassword(session: Session): Promise<Session> {
  if (session.remember_password !== 1) {
    return { ...session, password: '' };
  }
  const fromKeytar = await getSessionPasswordFromKeytar(session.id);
  if (fromKeytar != null) {
    return { ...session, password: fromKeytar };
  }
  return { ...session, password: String(session.password || '') };
}

export async function loadSession(sessionId: number): Promise<Session> {
  const session = await get<Session>('SELECT * FROM session WHERE id = ?', [sessionId]);
  if (!session) {
    throw new Error('会话不存在');
  }
  return hydrateSessionPassword(session);
}

export async function getSessionForConnection(connectionId: number): Promise<Session> {
  const mapped = connectionSessionMap.get(connectionId);
  if (mapped) return mapped;
  return loadSession(connectionId);
}

export function requireConnected(connectionId: number) {
  if (!sshStateMap.has(connectionId)) {
    throw new Error('SSH 未连接');
  }
}

export async function cleanupConnectionState(connectionId: number, expectedClient?: Client) {
  if (expectedClient && sshStateMap.get(connectionId)?.client !== expectedClient) return false;
  const batchClientsToClose = new Set<any>();
  for (const [, control] of sftpBatchControlMap) {
    if (control.connectionId === connectionId) {
      control.cancelled = true;
      if (control.client && control.ownsClient) {
        batchClientsToClose.add(control.client);
        control.client = undefined;
      }
      for (const client of control.clients || []) batchClientsToClose.add(client);
      control.clients = [];
    }
  }
  await Promise.all(Array.from(batchClientsToClose, async (it) => it.end().catch(() => null)));
  const sshState = sshStateMap.get(connectionId);
  if (sshState) {
    try {
      sshState.client.end();
    } catch {
      // Ignore close errors.
    }
  }
  sshStateMap.delete(connectionId);
  connectionSessionMap.delete(connectionId);
  connectionHomeMap.delete(connectionId);
  cwdOutputTailMap.delete(connectionId);
  lastKnownCwdMap.delete(connectionId);
  remoteMetricsSnapshotMap.delete(connectionId);
  remoteMetricsPayloadMap.delete(connectionId);
  if (sharedState.metricsSessionId === connectionId) {
    sharedState.metricsSessionId = null;
  }
  const sftp = sftpMap.get(connectionId);
  if (sftp) {
    try {
      await sftp.end();
    } catch {
      // Ignore close errors.
    }
    sftpMap.delete(connectionId);
  }
  return true;
}
