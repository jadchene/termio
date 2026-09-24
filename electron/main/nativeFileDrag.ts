import { app, BrowserWindow, type IpcMainEvent } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SftpBatchControl } from './types';
import { sftpBatchControlMap, sftpProgressThrottleMap, DEFAULT_TRANSFER_CONCURRENCY } from './state';
import { getSessionForConnection, requireConnected } from './session';
import {
  buildRemotePath,
  createBatchId,
  createStandaloneSftp,
  createWorkerSftpClients,
  runWithConcurrency,
  emitSftpBatchError,
  emitSftpProgressMaybe,
  resolveRemotePath,
} from './sftp';
import { safeSend } from './window';
import { registerTrustedHandle, registerTrustedOn } from './ipcSecurity';

const ipcMain = {
  handle: registerTrustedHandle,
  on: registerTrustedOn,
};

type RendererDragItem = {
  remotePath: string;
  name: string;
  isDirectory: boolean;
  size: number;
};

type NativeDragEntry = {
  index: number;
  name: string;
  remotePath: string;
  isDirectory: boolean;
  size: number;
};

type NativeDragState = {
  token: string;
  sessionId: number;
  sender: IpcMainEvent['sender'];
  phase: 'preparing' | 'native';
  cancelled: boolean;
  finalized: boolean;
  tempRoot: string;
  entries: NativeDragEntry[];
  roots: RendererDragItem[];
  rootNames: Map<string, string>;
  manifestPreparationStarted: boolean;
  downloadsStarted: boolean;
  stopped: boolean;
  child?: ChildProcessWithoutNullStreams;
  client?: any;
  batchId: string;
  control?: SftpBatchControl;
  transferChain: Promise<void>;
  requestedIndexes: Set<number>;
  completedItems: Map<number, string>;
  successCount: number;
  failedCount: number;
  helperError: string;
};

const MaxManifestItems = 50000;
const MaxDescriptorNameLength = 259;
const NativeDragCleanupDelayMs = 60 * 60 * 1000;
const nativeDragMap = new Map<string, NativeDragState>();
let nativeDragRoot = '';

function sanitizeWindowsName(name: string): string {
  const sanitized = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  const fallback = sanitized || 'download';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(fallback) ? `_${fallback}` : fallback;
}

function createUniqueWindowsName(name: string, isDirectory: boolean, used: Set<string>): string {
  const original = sanitizeWindowsName(name);
  let candidate = original;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const ext = isDirectory ? '' : path.extname(original);
    const base = ext ? original.slice(0, -ext.length) : original;
    candidate = `${base} (${suffix})${ext}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function ensureDescriptorPath(name: string): string {
  if (name.length > MaxDescriptorNameLength) {
    throw new Error(`拖拽路径过长，Windows 资源管理器无法接收: ${name}`);
  }
  return name;
}

function createUniqueRootNames(items: RendererDragItem[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const item of items) {
    const candidate = createUniqueWindowsName(
      item.name || path.posix.basename(item.remotePath.replace(/\/+$/, '')),
      item.isDirectory,
      used,
    );
    result.set(item.remotePath, ensureDescriptorPath(candidate));
  }
  return result;
}

function appendEntry(
  entries: NativeDragEntry[],
  entry: Omit<NativeDragEntry, 'index'>,
): void {
  if (entries.length >= MaxManifestItems) {
    throw new Error(`目录内容超过 ${MaxManifestItems} 项，无法作为一次拖拽处理`);
  }
  entries.push({ ...entry, index: entries.length });
}

async function collectDirectoryEntries(
  client: any,
  remoteDir: string,
  descriptorDir: string,
  entries: NativeDragEntry[],
  state: NativeDragState,
): Promise<void> {
  if (state.cancelled || state.stopped || state.control?.cancelled) throw new Error('拖拽已取消');
  appendEntry(entries, {
    name: ensureDescriptorPath(descriptorDir),
    remotePath: remoteDir,
    isDirectory: true,
    size: 0,
  });
  const children = await client.list(remoteDir);
  const usedChildNames = new Set<string>();
  for (const child of children) {
    if (state.cancelled) throw new Error('拖拽已取消');
    if (child.name === '.' || child.name === '..') continue;
    const childRemotePath = buildRemotePath(remoteDir, child.name);
    const childName = createUniqueWindowsName(child.name, child.type === 'd', usedChildNames);
    const childDescriptorPath = ensureDescriptorPath(
      path.win32.join(descriptorDir, childName),
    );
    if (child.type === 'd') {
      await collectDirectoryEntries(client, childRemotePath, childDescriptorPath, entries, state);
      continue;
    }
    appendEntry(entries, {
      name: childDescriptorPath,
      remotePath: childRemotePath,
      isDirectory: false,
      size: Math.max(0, Number(child.size || 0)),
    });
  }
}

function getHelperPath(): string {
  const helperName = 'my-terminal-virtual-file-drag.exe';
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'native', helperName)
    : path.resolve(__dirname, '..', '..', 'native', helperName);
  if (fs.existsSync(helperPath)) return helperPath;
  throw new Error(`Windows 拖拽辅助程序不存在: ${helperPath}`);
}

function decodeHelperMessage(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return encoded;
  }
}

function sendHelperLine(state: NativeDragState, line: string): void {
  if (!state.child || state.child.stdin.destroyed) return;
  state.child.stdin.write(`${line}\n`);
}

async function getTransferClient(state: NativeDragState): Promise<any> {
  if (state.client) return state.client;
  requireConnected(state.sessionId);
  const session = await getSessionForConnection(state.sessionId);
  const client = await createStandaloneSftp(session);
  if (state.cancelled || state.stopped || state.control?.cancelled) {
    await client.end().catch(() => undefined);
    throw new Error('拖拽下载已取消');
  }
  state.client = client;
  if (state.control) state.control.client = client;
  return client;
}

function beginTransferBatch(state: NativeDragState): SftpBatchControl {
  if (state.control) return state.control;
  const control: SftpBatchControl = {
    sessionId: state.sessionId,
    connectionId: state.sessionId,
    cancelled: false,
    ownsClient: true,
    onCancel: () => {
      state.cancelled = true;
      sendHelperLine(state, 'CANCEL');
    },
  };
  state.control = control;
  sftpBatchControlMap.set(state.batchId, control);
  return control;
}

async function transferRequestedItem(state: NativeDragState, item: NativeDragEntry, transferIndex: number, totalCount: number, client: any): Promise<void> {
  const itemIndex = item.index;
  if (!item || item.isDirectory) {
    sendHelperLine(state, `ERROR\t${itemIndex}\t${Buffer.from('无效的远程文件索引').toString('base64')}`);
    return;
  }
  state.requestedIndexes.add(itemIndex);
  const control = beginTransferBatch(state);
  const localPath = path.join(state.tempRoot, `${item.index}.data`);
  try {
    if (state.cancelled || state.stopped || control.cancelled) throw new Error('拖拽下载已取消');
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const remotePath = await resolveRemotePath(client, item.remotePath);
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: transferIndex,
        totalCount,
        completedCount: state.successCount + state.failedCount,
        name: item.name.replace(/\\/g, '/'),
        transferred: 0,
        total: item.size,
      },
      true,
    );
    await client.fastGet(remotePath, localPath, {
      step: (transferred: number, _chunk: number, total: number) => {
        if (state.cancelled || state.stopped || control.cancelled) return;
        emitSftpProgressMaybe({
          sessionId: state.sessionId,
          batchId: state.batchId,
          direction: 'download',
          index: transferIndex,
          totalCount,
          completedCount: state.successCount + state.failedCount,
          name: item.name.replace(/\\/g, '/'),
          transferred,
          total: total || item.size,
        });
      },
    });
    if (state.cancelled || state.stopped || control.cancelled) throw new Error('拖拽下载已取消');
    state.successCount += 1;
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: transferIndex,
        totalCount,
        completedCount: state.successCount + state.failedCount,
        name: item.name.replace(/\\/g, '/'),
        transferred: item.size,
        total: item.size,
      },
      true,
    );
    state.completedItems.set(itemIndex, '');
    sendHelperLine(state, `READY\t${itemIndex}`);
  } catch (error) {
    if (state.stopped) return;
    state.failedCount += 1;
    const message = String(error);
    state.completedItems.set(itemIndex, message);
    emitSftpBatchError({
      sessionId: state.sessionId,
      batchId: state.batchId,
      direction: 'download',
      name: item.name.replace(/\\/g, '/'),
      error: message,
    });
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: transferIndex,
        totalCount,
        completedCount: state.successCount + state.failedCount,
        name: item.name.replace(/\\/g, '/'),
        transferred: 0,
        total: item.size,
      },
      true,
    );
    sendHelperLine(state, `ERROR\t${itemIndex}\t${Buffer.from(message).toString('base64')}`);
  }
}

function handleHelperLine(state: NativeDragState, line: string): void {
  const parts = line.split('\t');
  if (parts[0] === 'REQUEST') {
    const index = Number(parts[1]);
    if (!Number.isInteger(index) || !state.entries[index] || state.entries[index].isDirectory) return;
    if (state.completedItems.has(index)) {
      const error = state.completedItems.get(index)!;
      sendHelperLine(state, error ? `ERROR\t${index}\t${Buffer.from(error).toString('base64')}` : `READY\t${index}`);
    } else if (!state.downloadsStarted) {
      state.downloadsStarted = true;
      state.transferChain = state.transferChain.then(() => downloadDragFiles(state, index));
    }
    return;
  }
  if (parts[0] === 'REQUEST_MANIFEST') {
    if (!state.manifestPreparationStarted) {
      state.manifestPreparationStarted = true;
      state.transferChain = prepareDragManifest(state);
    }
    return;
  }
  if (parts[0] === 'DROPPED') {
    // 松手后解除前端拖拽状态，下载任务继续独立运行。
    safeSend('sftp:native-drag-ended', { token: state.token, error: '' });
    return;
  }
  if (parts[0] === 'TRANSFER_END') {
    state.stopped = true;
    if ([-2147023673, -2147467260].includes(Number(parts[1])) || Number(parts[2]) === 0 && Number(parts[1]) >= 0) state.cancelled = true;
    void closeDragClients(state);
    return;
  }
  if (parts[0] === 'RETURNED') {
    state.cancelled = true;
    if (state.control) state.control.cancelled = true;
    void closeDragClients(state);
    return;
  }
  if (parts[0] === 'END' && Number(parts[2] || 0) === 0) {
    state.cancelled = true;
    if (state.control) state.control.cancelled = true;
    void closeDragClients(state);
    return;
  }
  if (parts[0] === 'ERROR') {
    state.helperError = decodeHelperMessage(parts[1] || '');
  }
}

/** 关闭本次拖拽持有的全部通道，保留交互终端连接。 */
async function closeDragClients(state: NativeDragState): Promise<void> {
  const clients = new Set([state.client, ...(state.control?.clients || [])].filter(Boolean));
  await Promise.all(Array.from(clients, (client) => client.end().catch(() => undefined)));
  state.client = undefined;
  if (state.control) {
    state.control.client = undefined;
    state.control.clients = [];
  }
}

async function finalizeNativeDrag(state: NativeDragState): Promise<void> {
  if (state.finalized) return;
  state.finalized = true;
  await state.transferChain.catch(() => undefined);
  await closeDragClients(state);
  if (state.control) {
    sftpBatchControlMap.delete(state.batchId);
    state.control.client = undefined;
    safeSend('sftp:batch-complete', {
      sessionId: state.sessionId,
      batchId: state.batchId,
      direction: 'download',
      totalCount: state.requestedIndexes.size,
      successCount: state.successCount,
      failedCount: state.failedCount,
      cancelled: state.cancelled || state.control.cancelled,
    });
  }
  for (const [key] of sftpProgressThrottleMap) {
    if (key.includes(`:${state.batchId}:`)) sftpProgressThrottleMap.delete(key);
  }
  nativeDragMap.delete(state.token);
  safeSend('sftp:native-drag-ended', {
    token: state.token,
    error: !state.cancelled && state.helperError ? state.helperError : '',
  });
  const cleanupTimer = setTimeout(() => {
    void fs.promises.rm(state.tempRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined);
  }, NativeDragCleanupDelayMs);
  cleanupTimer.unref();
}

function launchNativeDrag(state: NativeDragState): void {
  if (state.cancelled) {
    void finalizeNativeDrag(state);
    return;
  }
  fs.mkdirSync(state.tempRoot, { recursive: true });
  const manifestPath = path.join(state.tempRoot, 'manifest.json');
  const sourceWindow = BrowserWindow.fromWebContents(state.sender);
  const sourceHandleBuffer = sourceWindow?.getNativeWindowHandle();
  const sourceWindowHandle = sourceHandleBuffer
    ? (sourceHandleBuffer.length >= 8
        ? sourceHandleBuffer.readBigUInt64LE(0)
        : BigInt(sourceHandleBuffer.readUInt32LE(0))).toString()
    : '0';
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      TempRoot: state.tempRoot,
      SourceWindowHandle: sourceWindowHandle,
      ExpandDirectories: state.roots.some((root) => root.isDirectory),
      Items: state.entries.map((entry) => ({
        Index: entry.index,
        Name: entry.name,
        IsDirectory: entry.isDirectory,
        Size: entry.size,
      })),
    }),
    'utf8',
  );
  const helperPath = getHelperPath();
  const child = spawn(helperPath, [manifestPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.phase = 'native';
  state.child = child;
  child.stdin.on('error', (error) => {
    if (!state.stopped && !state.cancelled) state.helperError = String(error);
  });
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const maxStdoutLineLength = 64 * 1024;
  const maxStderrLength = 256 * 1024;
  const helperTimeout = setTimeout(() => {
    if (state.child !== child) return;
    state.helperError = 'Windows 拖拽辅助程序运行超时';
    child.kill();
  }, 12 * 60 * 60 * 1000);
  helperTimeout.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > maxStdoutLineLength && !stdoutBuffer.includes('\n')) {
      state.helperError = 'Windows 拖拽辅助程序输出了超长协议行';
      child.kill();
      return;
    }
    while (true) {
      const lineEnd = stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) break;
      if (lineEnd > maxStdoutLineLength) {
        state.helperError = 'Windows 拖拽辅助程序输出了超长协议行';
        child.kill();
        return;
      }
      const line = stdoutBuffer.slice(0, lineEnd).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (line) handleHelperLine(state, line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-maxStderrLength);
  });
  child.on('error', (error) => {
    state.helperError = String(error);
  });
  child.on('close', (code) => {
    clearTimeout(helperTimeout);
    state.stopped = true;
    void closeDragClients(state);
    if (!state.cancelled && code && !state.helperError) {
      state.helperError = stderrBuffer.trim() || `Windows 拖拽辅助程序异常退出 (${code})`;
    }
    void finalizeNativeDrag(state);
  });
}

function normalizePayloadItems(items: RendererDragItem[]): RendererDragItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 1000)
    .map((item) => ({
      remotePath: String(item?.remotePath || '').trim(),
      name: String(item?.name || '').trim(),
      isDirectory: !!item?.isDirectory,
      size: Math.max(0, Number(item?.size || 0)),
    }))
    .filter((item) => !!item.remotePath);
}

/** 后台展开目录，只生成描述符，不在悬停阶段读取远端。 */
async function prepareDragManifest(state: NativeDragState): Promise<void> {
  const control = beginTransferBatch(state);
  try {
    emitSftpProgressMaybe({ sessionId: state.sessionId, batchId: state.batchId, direction: 'download', index: 0, totalCount: 0, completedCount: 0, name: '正在读取目录', transferred: 0, total: 0 }, true);
    const client = await getTransferClient(state);
    const entries: NativeDragEntry[] = [];
    for (const root of state.roots) {
      if (state.cancelled || state.stopped || control.cancelled) throw new Error('拖拽下载已取消');
      const remotePath = await resolveRemotePath(client, root.remotePath);
      const name = state.rootNames.get(root.remotePath)!;
      if (root.isDirectory) await collectDirectoryEntries(client, remotePath, name, entries, state);
      else appendEntry(entries, { name, remotePath, isDirectory: false, size: root.size });
    }
    state.entries = entries;
    await fs.promises.writeFile(path.join(state.tempRoot, 'expanded-items.json'), JSON.stringify(entries.map((entry) => ({ Index: entry.index, Name: entry.name, IsDirectory: entry.isDirectory, Size: entry.size }))), 'utf8');
    if (state.cancelled || state.stopped || control.cancelled) throw new Error('拖拽下载已取消');
    sendHelperLine(state, 'MANIFEST_READY');
  } catch (error) {
    const message = String(error);
    if (!state.cancelled && !control.cancelled) state.helperError = message;
    sendHelperLine(state, `MANIFEST_ERROR\t${Buffer.from(message).toString('base64')}`);
  }
}

/** 虚拟文件和文件夹共用有限并发下载池，完成内容按索引交给 Shell。 */
async function downloadDragFiles(state: NativeDragState, requestedIndex: number): Promise<void> {
  const entries = state.entries.filter((entry) => !entry.isDirectory);
  // 优先满足 Shell 当前请求，其余内容交给有限并发预取。
  const order = entries.map((entry, index) => ({ entry, index }));
  order.sort((a, b) => Number(b.entry.index === requestedIndex) - Number(a.entry.index === requestedIndex));
  const control = beginTransferBatch(state);
  try {
    const client = await getTransferClient(state);
    const session = await getSessionForConnection(state.sessionId);
    const extras = await createWorkerSftpClients(state.sessionId, session, Math.min(DEFAULT_TRANSFER_CONCURRENCY, entries.length) - 1);
    const workers = [client, ...extras];
    control.clients = workers;
    await runWithConcurrency(entries.length, workers.length, async (index, workerIndex) => {
      if (state.stopped) return;
      await transferRequestedItem(state, order[index].entry, order[index].index, entries.length, workers[workerIndex]);
    });
  } catch (error) {
    if (state.stopped) return;
    const message = String(error);
    state.helperError = message;
    for (const entry of entries) {
      state.completedItems.set(entry.index, message);
      sendHelperLine(state, `ERROR\t${entry.index}\t${Buffer.from(message).toString('base64')}`);
    }
  } finally {
    if (state.stopped || state.cancelled || control.cancelled) await closeDragClients(state);
  }
}

export function registerNativeFileDragIpc(): void {
  nativeDragRoot = path.join(app.getPath('temp'), 'my-terminal', 'sftp-native-drag');
  void fs.promises.rm(nativeDragRoot, { recursive: true, force: true }).catch(() => undefined);

  ipcMain.on(
    'sftp:start-native-drag',
    (event, payload: { sessionId: number; items: RendererDragItem[]; token: string }) => {
      const token = String(payload?.token || '');
      const sessionId = Number(payload?.sessionId || 0);
      const roots = normalizePayloadItems(payload?.items);
      if (process.platform !== 'win32' || !/^[a-zA-Z0-9_-]{8,100}$/.test(token) || sessionId <= 0 || roots.length === 0) {
        return;
      }
      try {
        requireConnected(sessionId);
      } catch (error) {
        safeSend('sftp:native-drag-ended', { token, error: String(error) });
        return;
      }
      const previous = nativeDragMap.get(token);
      if (previous) return;
      const rootNames = createUniqueRootNames(roots);
      const state: NativeDragState = {
        token,
        sessionId,
        sender: event.sender,
        phase: 'preparing',
        cancelled: false,
        finalized: false,
        tempRoot: path.join(nativeDragRoot, token),
        entries: [],
        batchId: createBatchId(),
        transferChain: Promise.resolve(),
        requestedIndexes: new Set<number>(),
        completedItems: new Map<number, string>(),
        successCount: 0,
        failedCount: 0,
        helperError: '',
        roots,
        rootNames,
        manifestPreparationStarted: false,
        downloadsStarted: false,
        stopped: false,
      };
      nativeDragMap.set(token, state);
      for (const root of roots) {
        appendEntry(state.entries, {
          name: rootNames.get(root.remotePath) || sanitizeWindowsName(root.name),
          remotePath: root.remotePath,
          isDirectory: root.isDirectory,
          size: root.size,
        });
      }
      try {
        launchNativeDrag(state);
      } catch (error) {
        state.helperError = String(error);
        void finalizeNativeDrag(state);
      }
    },
  );

  ipcMain.handle('sftp:cancel-native-drag', async (_, tokenInput: string) => {
    const token = String(tokenInput || '');
    const state = nativeDragMap.get(token);
    if (!state) return false;
    state.cancelled = true;
    if (state.control) state.control.cancelled = true;
    if (state.child && !state.child.killed) state.child.kill();
    await closeDragClients(state);
    if (!state.child) await finalizeNativeDrag(state);
    return true;
  });
}

export function cancelAllNativeFileDrags(): void {
  for (const state of nativeDragMap.values()) {
    state.cancelled = true;
    if (state.child && !state.child.killed) state.child.kill();
    void closeDragClients(state);
  }
}
