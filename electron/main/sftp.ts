import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import SftpClient from 'ssh2-sftp-client';
import { Session, SftpProgressPayload, SftpBatchControl, UploadTask, DownloadTask } from './types';
import { readSettings } from './settings';
import { sshStateMap, sftpMap, sftpBatchControlMap, sftpProgressThrottleMap, DEFAULT_TRANSFER_CONCURRENCY, connectionHomeMap } from './state';
import { getSessionForConnection, requireConnected } from './session';
import { safeSend } from './window';
import { createHostVerifier } from './hostKey';
import { createSftpTransferChannel } from './sftpChannel';
import {
  allocateUniqueLocalPath,
  createTemporaryDownloadPath,
  sanitizeLocalFileName,
} from './downloadPath';
import { toSftpErrorPayload } from './sftpError';

export function toSftpPath(input: string): string {
  return (input || '.').replace(/\\/g, '/');
}

export function buildRemotePath(parent: string, name: string): string {
  const raw = toSftpPath(parent || '~');
  if (raw === '/') return `/${name}`;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return name;
  return `${normalized}/${name}`;
}

export function createBatchId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emitSftpProgress(payload: SftpProgressPayload) {
  safeSend('sftp:progress', payload);
}

export function emitSftpBatchError(payload: {
  sessionId: number;
  batchId: string;
  direction: 'upload' | 'download';
  name: string;
  error: string;
}) {
  const normalized = toSftpErrorPayload(payload.error);
  const event = { ...payload, errorCode: normalized.code, error: normalized.message };
  console.error('[sftp:batch-error]', event);
  safeSend('sftp:batch-error', event);
}

export function emitSftpProgressMaybe(payload: SftpProgressPayload, force = false) {
  const key = `${payload.sessionId}:${payload.batchId}:${payload.index}`;
  if (force) {
    emitSftpProgress(payload);
    sftpProgressThrottleMap.set(key, { at: Date.now(), transferred: payload.transferred, total: payload.total });
    return;
  }
  const now = Date.now();
  const prev = sftpProgressThrottleMap.get(key);
  if (!prev) {
    emitSftpProgress(payload);
    sftpProgressThrottleMap.set(key, { at: now, transferred: payload.transferred, total: payload.total });
    return;
  }
  const total = Math.max(0, payload.total || 0);
  const isDone = total > 0 && payload.transferred >= total;
  if (isDone) {
    emitSftpProgress(payload);
    sftpProgressThrottleMap.delete(key);
    return;
  }
  const prevPercent = prev.total > 0 ? Math.floor((prev.transferred / prev.total) * 100) : 0;
  const nextPercent = total > 0 ? Math.floor((payload.transferred / total) * 100) : 0;
  const percentChanged = nextPercent > prevPercent;
  const elapsed = now - prev.at;
  if (percentChanged || elapsed >= 120) {
    emitSftpProgress(payload);
    sftpProgressThrottleMap.set(key, { at: now, transferred: payload.transferred, total });
    return;
  }
  sftpProgressThrottleMap.set(key, { at: prev.at, transferred: payload.transferred, total });
}

export class SftpBatchCancelledError extends Error {
  constructor() {
    super('SFTP 传输已取消');
    this.name = 'SftpBatchCancelledError';
  }
}

export function assertBatchNotCancelled(control: SftpBatchControl) {
  if (control.cancelled) {
    throw new SftpBatchCancelledError();
  }
}

export function isBatchCancelledError(error: unknown): boolean {
  return error instanceof SftpBatchCancelledError;
}

export async function runWithConcurrency(
  taskCount: number,
  concurrency: number,
  worker: (index: number, workerIndex: number) => Promise<void>,
): Promise<void> {
  if (taskCount <= 0) return;
  const limit = Math.max(1, Math.min(taskCount, concurrency));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async (_, workerIndex) => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= taskCount) break;
      await worker(index, workerIndex);
    }
  });
  await Promise.all(runners);
}

export function isHandshakeLossError(error: unknown): boolean {
  const message = String(error || '').toLowerCase();
  return message.includes('connection lost before handshake') || message.includes('handshake');
}

export async function createWorkerSftpClients(
  connectionId: number,
  session: Session,
  desired: number,
  onDegrade?: (actual: number, desiredTotal: number) => void,
): Promise<any[]> {
  const target = Math.max(0, desired);
  if (target === 0) return [];
  const clients: any[] = [];
  for (let i = 0; i < target; i += 1) {
    try {
      const transport = sshStateMap.get(connectionId)?.client;
      const client = transport
        ? await createSftpTransferChannel(transport)
        : await createStandaloneSftp(session);
      clients.push(client);
    } catch (error) {
      try {
        const fallbackClient = await createStandaloneSftp(session);
        clients.push(fallbackClient);
        console.warn('[SFTP] Shared transport channel unavailable; using a standalone worker connection:', error);
      } catch (fallbackError) {
        onDegrade?.(clients.length, target);
        if (clients.length === 0 && !isHandshakeLossError(fallbackError)) {
          console.warn('[SFTP] Additional worker unavailable:', fallbackError);
        }
        break;
      }
    }
  }
  return clients;
}

export function getDefaultDownloadDir(): string {
  const settings = readSettings();
  const configured = String(settings.behavior.defaultDownloadDir || '').trim();
  return configured || app.getPath('downloads');
}

export async function ensureUniqueLocalPath(targetDir: string, fileName: string): Promise<string> {
  return allocateUniqueLocalPath(targetDir, fileName, new Set<string>());
}

export function isSftpDir(attrs: any): boolean {
  if (!attrs) return false;
  if (typeof attrs.isDirectory === 'function') return attrs.isDirectory();
  if (typeof attrs.isDirectory === 'boolean') return attrs.isDirectory;
  if (attrs.type === 'd') return true;
  if (typeof attrs.mode === 'number') return (attrs.mode & 0o170000) === 0o040000;
  return false;
}

const MAX_TRANSFER_TASKS = 10_000;
const MAX_TRANSFER_ENTRIES = 20_000;
const MAX_SINGLE_FILE_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_TOTAL_TRANSFER_BYTES = 500 * 1024 * 1024 * 1024;
const MAX_TRANSFER_DEPTH = 64;

type TransferBudget = {
  entries: number;
  totalBytes: number;
};

function addTransferTask<T extends { size: number }>(tasks: T[], task: T, budget: TransferBudget): void {
  if (!Number.isSafeInteger(task.size) || task.size < 0 || task.size > MAX_SINGLE_FILE_BYTES) {
    throw new Error('单个传输文件大小超过限制');
  }
  if (tasks.length >= MAX_TRANSFER_TASKS) throw new Error(`单次传输最多包含 ${MAX_TRANSFER_TASKS} 个文件`);
  if (budget.totalBytes + task.size > MAX_TOTAL_TRANSFER_BYTES) throw new Error('单次传输总大小超过限制');
  budget.totalBytes += task.size;
  tasks.push(task);
}

function countTransferEntry(budget: TransferBudget, depth: number): void {
  if (depth > MAX_TRANSFER_DEPTH) throw new Error('传输目录层级超过限制');
  budget.entries += 1;
  if (budget.entries > MAX_TRANSFER_ENTRIES) throw new Error(`单次传输最多遍历 ${MAX_TRANSFER_ENTRIES} 个目录项`);
}

export async function collectUploadTasks(
  localPath: string,
  remoteDir: string,
  tasks: UploadTask[],
  shouldCancel?: () => boolean,
  budget: TransferBudget = { entries: 0, totalBytes: 0 },
) {
  if (shouldCancel?.()) throw new SftpBatchCancelledError();
  const stat = await fs.promises.stat(localPath);
  if (!stat.isDirectory()) {
    addTransferTask(tasks, {
      localPath,
      remotePath: buildRemotePath(remoteDir, path.basename(localPath)),
      name: path.basename(localPath),
      size: stat.size,
    }, budget);
    return;
  }

  const rootRemoteDir = buildRemotePath(remoteDir, path.basename(localPath));
  const walk = async (currentLocalDir: string, currentRemoteDir: string, depth: number) => {
    countTransferEntry(budget, depth);
    if (shouldCancel?.()) throw new SftpBatchCancelledError();
    const entries = await fs.promises.readdir(currentLocalDir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldCancel?.()) throw new SftpBatchCancelledError();
      const localChild = path.join(currentLocalDir, entry.name);
      const remoteChild = buildRemotePath(currentRemoteDir, entry.name);
      if (entry.isDirectory()) {
        await walk(localChild, remoteChild, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await fs.promises.stat(localChild);
      addTransferTask(tasks, {
        localPath: localChild,
        remotePath: remoteChild,
        name: path.relative(localPath, localChild).replace(/\\/g, '/'),
        size: fileStat.size,
      }, budget);
    }
  };

  await walk(localPath, rootRemoteDir, 0);
}

export async function ensureRemoteDirExists(client: any, remoteDir: string): Promise<void> {
  if (!remoteDir || remoteDir === '.' || remoteDir === '/') return;
  const normalized = toSftpPath(remoteDir).replace(/\/+$/, '') || '/';
  if (normalized === '/') return;
  let normalizedExistsType: any = false;
  try {
    normalizedExistsType = await client.exists(normalized);
  } catch {
    // Continue to create path when existence check is unavailable.
  }
  if (normalizedExistsType === 'd') return;
  if (normalizedExistsType && normalizedExistsType !== false) {
    throw new Error(`目标路径不是目录: ${normalized}`);
  }

  const isAbs = normalized.startsWith('/');
  const segments = normalized.split('/').filter(Boolean);
  let current = isAbs ? '/' : '';
  for (const segment of segments) {
    current = current === '/' ? `/${segment}` : current ? `${current}/${segment}` : segment;
    let existsType: any = false;
    try {
      existsType = await client.exists(current);
    } catch {
      existsType = false;
    }
    if (existsType === 'd') continue;
    if (existsType && existsType !== false) {
      throw new Error(`目标路径不是目录: ${current}`);
    }
    try {
      await client.mkdir(current, false);
    } catch (error) {
      const afterCreate = await client.exists(current).catch(() => false);
      if (afterCreate !== 'd') throw error;
    }
  }
}

export async function ensureRemoteDirsForUploadTasks(client: any, tasks: UploadTask[]): Promise<void> {
  const dirs = Array.from(
    new Set(
      tasks
        .map((task) => toSftpPath(path.posix.dirname(task.remotePath)))
        .filter((dir) => !!dir && dir !== '.'),
    ),
  );
  dirs.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const dir of dirs) {
    await ensureRemoteDirExists(client, dir);
  }
}

export async function collectDownloadTasks(
  client: any,
  remotePath: string,
  localPath: string,
  tasks: DownloadTask[],
  displayRootPath: string,
  displayRootName: string,
  reservedPaths: Set<string>,
  shouldCancel?: () => boolean,
  budget: TransferBudget = { entries: 0, totalBytes: 0 },
  depth = 0,
) {
  countTransferEntry(budget, depth);
  if (shouldCancel?.()) throw new SftpBatchCancelledError();
  const attrs = await client.stat(remotePath);
  const normalizedCurrent = remotePath.replace(/\/+$/, '');
  const normalizedRoot = displayRootPath.replace(/\/+$/, '');
  const rel = normalizedCurrent.startsWith(`${normalizedRoot}/`)
    ? normalizedCurrent.slice(normalizedRoot.length + 1)
    : '';
  const displayName = rel ? `${displayRootName}/${rel}` : displayRootName;
  if (!isSftpDir(attrs)) {
    addTransferTask(tasks, {
      remotePath,
      localPath,
      name: displayName,
      size: Number(attrs?.size || 0),
    }, budget);
    return;
  }

  await fs.promises.mkdir(localPath, { recursive: true });
  const items = await client.list(remotePath);
  for (const item of items) {
    if (shouldCancel?.()) throw new SftpBatchCancelledError();
    if (item.name === '.' || item.name === '..') continue;
    const childRemote = buildRemotePath(remotePath, item.name);
    const childLocal = await allocateUniqueLocalPath(localPath, item.name, reservedPaths);
    if (item.type === 'd') {
      await collectDownloadTasks(
        client,
        childRemote,
        childLocal,
        tasks,
        displayRootPath,
        displayRootName,
        reservedPaths,
        shouldCancel,
        budget,
        depth + 1,
      );
      continue;
    }
    addTransferTask(tasks, {
      remotePath: childRemote,
      localPath: childLocal,
      name: `${displayRootName}/${childRemote.replace(/\/+$/, '').slice(normalizedRoot.length + 1)}`,
      size: Number(item.size || 0),
    }, budget);
  }
}

export async function resolveRemotePath(client: any, input: string): Promise<string> {
  const normalized = toSftpPath(input || '.').trim();
  if (!normalized || normalized === '.') {
    const cwd = await client.cwd().catch(() => '.');
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : '.';
  }
  if (normalized === '~' || normalized.startsWith('~/')) {
    const home = await client.cwd().catch(() => '.');
    const safeHome = typeof home === 'string' && home.trim() ? home.trim() : '.';
    if (normalized === '~') return safeHome;
    return buildRemotePath(safeHome, normalized.slice(2));
  }
  return normalized;
}

export async function getOrCreateSftp(connectionId: number, session: Session): Promise<any> {
  const old = sftpMap.get(connectionId);
  if (old) {
    try {
      await old.cwd();
      return old;
    } catch {
      try {
        await old.end();
      } catch {
        // Ignore close errors.
      }
      sftpMap.delete(connectionId);
    }
  }
  const client = new SftpClient();
  await client.connect({
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    readyTimeout: 20000,
    hostVerifier: createHostVerifier(session),
  });
  const rawClient = (client as any)?.client;
  if (rawClient && typeof rawClient.setMaxListeners === 'function') {
    // Concurrent transfers can temporarily attach >10 listeners on ssh2 Client.
    rawClient.setMaxListeners(64);
  }
  const cwd = await client.cwd().catch(() => '');
  if (cwd && typeof cwd === 'string') {
    connectionHomeMap.set(connectionId, cwd.trim());
  }
  sftpMap.set(connectionId, client);
  return client;
}

export async function createStandaloneSftp(session: Session): Promise<any> {
  const client = new SftpClient();
  await client.connect({
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    readyTimeout: 20000,
    hostVerifier: createHostVerifier(session),
  });
  const rawClient = (client as any)?.client;
  if (rawClient && typeof rawClient.setMaxListeners === 'function') {
    rawClient.setMaxListeners(64);
  }
  return client;
}

export async function runSftpUploadBatch(payload: { sessionId: number; remoteDir: string; localPaths: string[] }): Promise<boolean> {
  if (!payload.localPaths.length) return false;
  const connectionId = payload.sessionId;
  requireConnected(connectionId);
  const session = await getSessionForConnection(connectionId);
  const client = await createStandaloneSftp(session);
  const remoteDir = await resolveRemotePath(client, payload.remoteDir);
  const batchId = createBatchId();
  const control: SftpBatchControl = {
    sessionId: payload.sessionId,
    connectionId,
    cancelled: false,
    client,
    clients: [client],
    ownsClient: true,
  };
  sftpBatchControlMap.set(batchId, control);
  emitSftpProgressMaybe(
    {
      sessionId: payload.sessionId,
      batchId,
      direction: 'upload',
      index: 0,
      totalCount: 0,
      completedCount: 0,
      name: '准备中',
      transferred: 0,
      total: 0,
    },
    true,
  );
  const tasks: UploadTask[] = [];
  const transferBudget: TransferBudget = { entries: 0, totalBytes: 0 };
  let successCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  try {
    for (const localPath of payload.localPaths) {
      assertBatchNotCancelled(control);
      await collectUploadTasks(localPath, remoteDir, tasks, () => control.cancelled, transferBudget);
    }
    assertBatchNotCancelled(control);
    if (tasks.length > 0) {
      emitSftpProgressMaybe(
        {
        sessionId: payload.sessionId,
        batchId,
        direction: 'upload',
        index: 0,
        totalCount: tasks.length,
        completedCount,
        name: tasks[0].name,
        transferred: 0,
        total: tasks[0].size || 0,
        },
        true,
      );
      await ensureRemoteDirsForUploadTasks(client, tasks);
    }
    const concurrency = Math.max(1, Math.min(DEFAULT_TRANSFER_CONCURRENCY, tasks.length || 1));
    const extraClients = await createWorkerSftpClients(connectionId, session, concurrency - 1, (actual, desired) => {
      console.warn(`[SFTP] Upload concurrency degraded: ${actual + 1}/${desired + 1}`);
    });
    const workerClients = [client, ...extraClients];
    control.clients = workerClients;
    await runWithConcurrency(tasks.length, workerClients.length, async (index, workerIndex) => {
      assertBatchNotCancelled(control);
      const task = tasks[index];
      const workerClient = workerClients[workerIndex];
      try {
        await workerClient.fastPut(task.localPath, task.remotePath, {
          step: (transferred: number, _chunk: number, total: number) => {
            if (control.cancelled) return;
            emitSftpProgressMaybe({
              sessionId: payload.sessionId,
              batchId,
              direction: 'upload',
              index,
              totalCount: tasks.length,
              completedCount,
              name: task.name,
              transferred,
              total: total || task.size || 0,
            });
          },
        });
        assertBatchNotCancelled(control);
        successCount += 1;
        completedCount += 1;
        emitSftpProgressMaybe(
          {
            sessionId: payload.sessionId,
            batchId,
            direction: 'upload',
            index,
            totalCount: tasks.length,
            completedCount,
            name: task.name,
            transferred: task.size,
            total: task.size,
          },
          true,
        );
      } catch (error) {
        if (isBatchCancelledError(error) || control.cancelled) return;
        failedCount += 1;
        completedCount += 1;
        emitSftpBatchError({
          sessionId: payload.sessionId,
          batchId,
          direction: 'upload',
          name: task.name,
          error: `fastPut 失败: ${String(error)}`,
        });
        emitSftpProgressMaybe(
          {
            sessionId: payload.sessionId,
            batchId,
            direction: 'upload',
            index,
            totalCount: tasks.length,
            completedCount,
            name: task.name,
            transferred: 0,
            total: task.size,
          },
          true,
        );
      }
    });
  } catch (error) {
    if (isBatchCancelledError(error) || control.cancelled) {
      safeSend('sftp:batch-complete', {
        sessionId: payload.sessionId,
        batchId,
        direction: 'upload',
        totalCount: tasks.length,
        successCount,
        failedCount,
        cancelled: true,
      });
      return false;
    }
    failedCount += 1;
    emitSftpBatchError({
      sessionId: payload.sessionId,
      batchId,
      direction: 'upload',
      name: 'batch',
      error: `上传批次失败: ${String(error)}`,
    });
  } finally {
    const clients = new Set<any>([...(control.clients || []), ...(control.client ? [control.client] : [])]);
    if (control.ownsClient) await Promise.all(Array.from(clients, async (it) => it.end().catch(() => null)));
    control.client = undefined;
    control.clients = [];
    sftpBatchControlMap.delete(batchId);
    for (const [key] of sftpProgressThrottleMap) {
      if (key.includes(`:${batchId}:`)) sftpProgressThrottleMap.delete(key);
    }
  }
  safeSend('sftp:batch-complete', {
    sessionId: payload.sessionId,
    batchId,
    direction: 'upload',
    totalCount: tasks.length,
    successCount,
    failedCount,
    cancelled: control.cancelled,
  });
  return !control.cancelled && (successCount > 0 || tasks.length === 0);
}

export async function runSftpDownloadBatch(payload: { sessionId: number; remotePaths: string[]; localDir?: string }): Promise<boolean> {
  if (!payload.remotePaths.length) return false;
  const connectionId = payload.sessionId;
  requireConnected(connectionId);
  const session = await getSessionForConnection(connectionId);
  const client = await createStandaloneSftp(session);
  const batchId = createBatchId();
  const control: SftpBatchControl = {
    sessionId: payload.sessionId,
    connectionId,
    cancelled: false,
    client,
    clients: [client],
    ownsClient: true,
  };
  sftpBatchControlMap.set(batchId, control);
  emitSftpProgressMaybe(
    {
      sessionId: payload.sessionId,
      batchId,
      direction: 'download',
      index: 0,
      totalCount: 0,
      completedCount: 0,
      name: '准备中',
      transferred: 0,
      total: 0,
    },
    true,
  );
  const targetDir = payload.localDir || app.getPath('downloads');
  const tasks: DownloadTask[] = [];
  const transferBudget: TransferBudget = { entries: 0, totalBytes: 0 };
  const reservedPaths = new Set<string>();
  let successCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  try {
    for (const rawPath of payload.remotePaths) {
      assertBatchNotCancelled(control);
      const remotePath = await resolveRemotePath(client, rawPath);
      const normalizedRemote = remotePath.replace(/\/+$/, '') || '/';
      const fileName = sanitizeLocalFileName(path.basename(normalizedRemote) || 'download');
      const localPath = await allocateUniqueLocalPath(targetDir, fileName, reservedPaths);
      await collectDownloadTasks(
        client,
        remotePath,
        localPath,
        tasks,
        normalizedRemote,
        fileName,
        reservedPaths,
        () => control.cancelled,
        transferBudget,
      );
    }
    assertBatchNotCancelled(control);
    if (tasks.length > 0) {
      emitSftpProgressMaybe(
        {
          sessionId: payload.sessionId,
          batchId,
          direction: 'download',
          index: 0,
          totalCount: tasks.length,
          completedCount,
          name: tasks[0].name,
          transferred: 0,
          total: tasks[0].size || 0,
        },
        true,
      );
    }
    const concurrency = Math.max(1, Math.min(DEFAULT_TRANSFER_CONCURRENCY, tasks.length || 1));
    const extraClients = await createWorkerSftpClients(connectionId, session, concurrency - 1, (actual, desired) => {
      console.warn(`[SFTP] Download concurrency degraded: ${actual + 1}/${desired + 1}`);
    });
    const workerClients = [client, ...extraClients];
    control.clients = workerClients;
    await runWithConcurrency(tasks.length, workerClients.length, async (index, workerIndex) => {
      assertBatchNotCancelled(control);
      const task = tasks[index];
      const workerClient = workerClients[workerIndex];
      const temporaryPath = createTemporaryDownloadPath(task.localPath);
      try {
        await fs.promises.mkdir(path.dirname(task.localPath), { recursive: true });
        await workerClient.fastGet(task.remotePath, temporaryPath, {
          step: (transferred: number, _chunk: number, total: number) => {
            if (control.cancelled) return;
            emitSftpProgressMaybe({
              sessionId: payload.sessionId,
              batchId,
              direction: 'download',
              index,
              totalCount: tasks.length,
              completedCount,
              name: task.name,
              transferred,
              total: total || task.size,
            });
          },
        });
        assertBatchNotCancelled(control);
        let finalPath = task.localPath;
        try {
          await fs.promises.access(finalPath, fs.constants.F_OK);
          finalPath = await allocateUniqueLocalPath(path.dirname(finalPath), path.basename(finalPath), reservedPaths);
        } catch {
          // The allocated final path is still free.
        }
        await fs.promises.rename(temporaryPath, finalPath);
        task.localPath = finalPath;
        successCount += 1;
        completedCount += 1;
        emitSftpProgressMaybe(
          {
            sessionId: payload.sessionId,
            batchId,
            direction: 'download',
            index,
            totalCount: tasks.length,
            completedCount,
            name: task.name,
            transferred: task.size,
            total: task.size,
          },
          true,
        );
      } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (isBatchCancelledError(error) || control.cancelled) return;
        failedCount += 1;
        completedCount += 1;
        emitSftpBatchError({
          sessionId: payload.sessionId,
          batchId,
          direction: 'download',
          name: task.name,
          error: String(error),
        });
        emitSftpProgressMaybe(
          {
            sessionId: payload.sessionId,
            batchId,
            direction: 'download',
            index,
            totalCount: tasks.length,
            completedCount,
            name: task.name,
            transferred: 0,
            total: task.size,
          },
          true,
        );
      }
    });
  } catch (error) {
    if (isBatchCancelledError(error) || control.cancelled) {
      safeSend('sftp:batch-complete', {
        sessionId: payload.sessionId,
        batchId,
        direction: 'download',
        totalCount: tasks.length,
        successCount,
        failedCount,
        cancelled: true,
      });
      return false;
    }
    failedCount += 1;
    emitSftpBatchError({
      sessionId: payload.sessionId,
      batchId,
      direction: 'download',
      name: 'batch',
      error: String(error),
    });
  } finally {
    const clients = new Set<any>([...(control.clients || []), ...(control.client ? [control.client] : [])]);
    if (control.ownsClient) await Promise.all(Array.from(clients, async (it) => it.end().catch(() => null)));
    control.client = undefined;
    control.clients = [];
    sftpBatchControlMap.delete(batchId);
    for (const [key] of sftpProgressThrottleMap) {
      if (key.includes(`:${batchId}:`)) sftpProgressThrottleMap.delete(key);
    }
  }
  safeSend('sftp:batch-complete', {
    sessionId: payload.sessionId,
    batchId,
    direction: 'download',
    totalCount: tasks.length,
    successCount,
    failedCount,
    cancelled: control.cancelled,
  });
  return !control.cancelled && (successCount > 0 || tasks.length === 0);
}
