import { app, BrowserWindow, type IpcMainEvent } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SftpBatchControl } from './types';
import { sftpBatchControlMap, sftpProgressThrottleMap } from './state';
import { getSessionForConnection, requireConnected } from './session';
import {
  buildRemotePath,
  createBatchId,
  createStandaloneSftp,
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
  localPaths?: string[];
  directoryRoots?: RendererDragItem[];
  directoryRootNames?: Map<string, string>;
  localPreparationStarted: boolean;
  child?: ChildProcessWithoutNullStreams;
  client?: any;
  batchId: string;
  control?: SftpBatchControl;
  transferChain: Promise<void>;
  requestedIndexes: Set<number>;
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
  if (state.cancelled) throw new Error('拖拽已取消');
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
  };
  state.control = control;
  sftpBatchControlMap.set(state.batchId, control);
  return control;
}

async function transferRequestedItem(state: NativeDragState, itemIndex: number): Promise<void> {
  const item = state.entries[itemIndex];
  if (!item || item.isDirectory) {
    sendHelperLine(state, `ERROR\t${itemIndex}\t${Buffer.from('无效的远程文件索引').toString('base64')}`);
    return;
  }
  if (state.requestedIndexes.has(itemIndex)) {
    sendHelperLine(state, `READY\t${itemIndex}`);
    return;
  }
  state.requestedIndexes.add(itemIndex);
  const control = beginTransferBatch(state);
  const fileEntries = state.entries.filter((entry) => !entry.isDirectory);
  const transferIndex = Math.max(0, fileEntries.findIndex((entry) => entry.index === itemIndex));
  const localPath = path.join(state.tempRoot, `${item.index}.data`);
  try {
    if (state.cancelled || control.cancelled) throw new Error('拖拽下载已取消');
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const client = await getTransferClient(state);
    const remotePath = await resolveRemotePath(client, item.remotePath);
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: transferIndex,
        totalCount: fileEntries.length,
        completedCount: state.successCount + state.failedCount,
        name: item.name.replace(/\\/g, '/'),
        transferred: 0,
        total: item.size,
      },
      true,
    );
    await client.fastGet(remotePath, localPath, {
      step: (transferred: number, _chunk: number, total: number) => {
        if (state.cancelled || control.cancelled) return;
        emitSftpProgressMaybe({
          sessionId: state.sessionId,
          batchId: state.batchId,
          direction: 'download',
          index: transferIndex,
          totalCount: fileEntries.length,
          completedCount: state.successCount + state.failedCount,
          name: item.name.replace(/\\/g, '/'),
          transferred,
          total: total || item.size,
        });
      },
    });
    if (state.cancelled || control.cancelled) throw new Error('拖拽下载已取消');
    state.successCount += 1;
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: transferIndex,
        totalCount: fileEntries.length,
        completedCount: state.successCount + state.failedCount,
        name: item.name.replace(/\\/g, '/'),
        transferred: item.size,
        total: item.size,
      },
      true,
    );
    sendHelperLine(state, `READY\t${itemIndex}`);
  } catch (error) {
    state.failedCount += 1;
    const message = String(error);
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
        totalCount: fileEntries.length,
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
    state.transferChain = state.transferChain.then(() => transferRequestedItem(state, index));
    return;
  }
  if (parts[0] === 'REQUEST_LOCAL') {
    if (!state.localPreparationStarted && state.directoryRoots && state.directoryRootNames) {
      state.localPreparationStarted = true;
      state.transferChain = stageDirectoryDrag(state, state.directoryRoots, state.directoryRootNames);
    }
    return;
  }
  if (parts[0] === 'RETURNED') {
    state.cancelled = true;
    if (state.control) state.control.cancelled = true;
    if (state.client) void state.client.end().catch(() => undefined);
    return;
  }
  if (parts[0] === 'END' && Number(parts[2] || 0) === 0) {
    state.cancelled = true;
    if (state.control) state.control.cancelled = true;
    if (state.client) void state.client.end().catch(() => undefined);
    return;
  }
  if (parts[0] === 'ERROR') {
    state.helperError = decodeHelperMessage(parts[1] || '');
  }
}

async function finalizeNativeDrag(state: NativeDragState): Promise<void> {
  if (state.finalized) return;
  state.finalized = true;
  await state.transferChain.catch(() => undefined);
  if (state.client) {
    await state.client.end().catch(() => undefined);
    state.client = undefined;
  }
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
      LocalPaths: state.localPaths || [],
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

async function stageDirectoryDrag(
  state: NativeDragState,
  roots: RendererDragItem[],
  rootNames: Map<string, string>,
): Promise<void> {
  const control = beginTransferBatch(state);
  try {
    emitSftpProgressMaybe(
      {
        sessionId: state.sessionId,
        batchId: state.batchId,
        direction: 'download',
        index: 0,
        totalCount: 0,
        completedCount: 0,
        name: '准备拖拽目录',
        transferred: 0,
        total: 0,
      },
      true,
    );
    const client = await getTransferClient(state);
    const entries: NativeDragEntry[] = [];
    for (const root of roots) {
      if (state.cancelled || control.cancelled) throw new Error('拖拽已取消');
      const resolvedRemotePath = await resolveRemotePath(client, root.remotePath);
      const displayName = rootNames.get(root.remotePath) || sanitizeWindowsName(root.name);
      if (root.isDirectory) {
        await collectDirectoryEntries(client, resolvedRemotePath, displayName, entries, state);
      } else {
        appendEntry(entries, {
          name: displayName,
          remotePath: resolvedRemotePath,
          isDirectory: false,
          size: root.size,
        });
      }
    }
    state.entries = entries;
    const stagingRoot = path.join(state.tempRoot, 'staged');
    for (const entry of entries.filter((item) => item.isDirectory)) {
      await fs.promises.mkdir(path.join(stagingRoot, entry.name), { recursive: true });
    }
    const fileEntries = entries.filter((item) => !item.isDirectory);
    for (let index = 0; index < fileEntries.length; index += 1) {
      if (state.cancelled || control.cancelled) throw new Error('拖拽已取消');
      const entry = fileEntries[index];
      const localPath = path.join(stagingRoot, entry.name);
      state.requestedIndexes.add(entry.index);
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      emitSftpProgressMaybe(
        {
          sessionId: state.sessionId,
          batchId: state.batchId,
          direction: 'download',
          index,
          totalCount: fileEntries.length,
          completedCount: state.successCount + state.failedCount,
          name: entry.name.replace(/\\/g, '/'),
          transferred: 0,
          total: entry.size,
        },
        true,
      );
      try {
        await client.fastGet(entry.remotePath, localPath, {
          step: (transferred: number, _chunk: number, total: number) => {
            if (state.cancelled || control.cancelled) return;
            emitSftpProgressMaybe({
              sessionId: state.sessionId,
              batchId: state.batchId,
              direction: 'download',
              index,
              totalCount: fileEntries.length,
              completedCount: state.successCount + state.failedCount,
              name: entry.name.replace(/\\/g, '/'),
              transferred,
              total: total || entry.size,
            });
          },
        });
      } catch (error) {
        state.failedCount += 1;
        emitSftpBatchError({
          sessionId: state.sessionId,
          batchId: state.batchId,
          direction: 'download',
          name: entry.name.replace(/\\/g, '/'),
          error: String(error),
        });
        emitSftpProgressMaybe(
          {
            sessionId: state.sessionId,
            batchId: state.batchId,
            direction: 'download',
            index,
            totalCount: fileEntries.length,
            completedCount: state.successCount + state.failedCount,
            name: entry.name.replace(/\\/g, '/'),
            transferred: 0,
            total: entry.size,
          },
          true,
        );
        throw error;
      }
      state.successCount += 1;
      emitSftpProgressMaybe(
        {
          sessionId: state.sessionId,
          batchId: state.batchId,
          direction: 'download',
          index,
          totalCount: fileEntries.length,
          completedCount: state.successCount + state.failedCount,
          name: entry.name.replace(/\\/g, '/'),
          transferred: entry.size,
          total: entry.size,
        },
        true,
      );
    }
    sendHelperLine(state, 'LOCAL_READY');
  } catch (error) {
    const message = String(error);
    if (!state.cancelled && !control.cancelled) state.helperError = message;
    sendHelperLine(state, `LOCAL_ERROR\t${Buffer.from(message).toString('base64')}`);
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
        successCount: 0,
        failedCount: 0,
        helperError: '',
        localPreparationStarted: false,
      };
      nativeDragMap.set(token, state);
      if (roots.some((root) => root.isDirectory)) {
        const stagingRoot = path.join(state.tempRoot, 'staged');
        state.localPaths = roots.map((root) => path.join(
          stagingRoot,
          rootNames.get(root.remotePath) || sanitizeWindowsName(root.name),
        ));
        state.directoryRoots = roots;
        state.directoryRootNames = rootNames;
        try {
          launchNativeDrag(state);
        } catch (error) {
          state.helperError = String(error);
          void finalizeNativeDrag(state);
        }
        return;
      }
      for (const root of roots) {
        appendEntry(state.entries, {
          name: rootNames.get(root.remotePath) || sanitizeWindowsName(root.name),
          remotePath: root.remotePath,
          isDirectory: false,
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
    if (state.client) {
      await state.client.end().catch(() => undefined);
      state.client = undefined;
    }
    if (!state.child) await finalizeNativeDrag(state);
    return true;
  });
}

export function cancelAllNativeFileDrags(): void {
  for (const state of nativeDragMap.values()) {
    state.cancelled = true;
    if (state.child && !state.child.killed) state.child.kill();
    if (state.client) void state.client.end().catch(() => undefined);
  }
}
