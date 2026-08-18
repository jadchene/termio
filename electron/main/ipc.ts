import { clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Client } from 'ssh2';
import { Session } from './types';
import { runtimeDir, userDataPath, dbPath } from './env';
import { run, all, get, withTransaction } from './db';
import { SETTINGS_KEY, readSettings, saveSettings } from './settings';
import { sshStateMap, sftpBatchControlMap, connectionSessionMap, lastKnownCwdMap, sharedState } from './state';
import { runSftpUploadBatch, runSftpDownloadBatch, ensureUniqueLocalPath, getDefaultDownloadDir, resolveRemotePath, getOrCreateSftp } from './sftp';
import { setSessionPasswordToKeytar, deleteSessionPasswordFromKeytar, getSessionPasswordFromKeytar, toPublicSession, loadSession, getSessionForConnection, requireConnected, cleanupConnectionState } from './session';
import { getRemoteShellCwd, updateCwdFromPrompt } from './ssh';
import { safeSend } from './window';
import { switchToEnglishInputMethod } from './inputMethod';
import { registerNativeFileDragIpc } from './nativeFileDrag';
import { registerTrustedHandle, registerTrustedOn } from './ipcSecurity';
import { cancelPendingHostKeyRequests, createHostVerifier, registerHostKeyIpc } from './hostKey';
import { cancelPendingAuthChallenges, registerAuthChallengeIpc, requestAuthChallengeAnswers } from './authChallenge';
import { isStoredPasswordPrompt } from './authPrompt';
import { toSftpErrorPayload } from './sftpError';
import { createTemporaryDownloadPath } from './downloadPath';
import { consumeUploadCapability, createUploadCapability } from './uploadCapability';
import {
  parseSession,
  requireBoolean,
  requireIntegerInRange,
  requireNullablePositiveId,
  requirePath,
  requirePositiveId,
  requireRecord,
  requireString,
  requireStringArray,
  validateSettingsPatch,
} from './ipcValidation';
import { createSessionRecord, deleteSessionRecord, saveSessionPasswordRecord, updateSessionRecord } from './sessionPersistence';
import {
  SSH_CONNECT_CANCELLED,
  beginConnectionAttempt,
  cancelPendingConnectionAttempt,
  releaseConnectionAttempt,
} from './connectionAttempt';
import { SshDataBuffer } from './sshDataBuffer';
import { requestMetricsCollection } from './metrics';

const ipcMain = {
  handle: (
    channel: string,
    listener: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => any,
  ) => registerTrustedHandle(channel, async (event, ...args) => {
    if (!channel.startsWith('sftp:')) return listener(event, ...args);
    try {
      return { ok: true, value: await listener(event, ...args) };
    } catch (error) {
      return { ok: false, error: toSftpErrorPayload(error) };
    }
  }),
  on: registerTrustedOn,
};

const sessionPersistenceDependencies = {
  withTransaction,
  getPassword: getSessionPasswordFromKeytar,
  setPassword: setSessionPasswordToKeytar,
  deletePassword: deleteSessionPasswordFromKeytar,
};

export function registerIpc() {
  registerHostKeyIpc();
  registerAuthChallengeIpc();
  registerNativeFileDragIpc();
  const sshDataBuffer = new SshDataBuffer({
    send: (connectionId, data) => safeSend('ssh:data', { sessionId: connectionId, data }),
    getShell: (connectionId) => sshStateMap.get(connectionId)?.shell,
  });

  ipcMain.handle('settings:get', async () => readSettings());
  ipcMain.handle('settings:update', async (_, partial: unknown) => {
    const current = readSettings();
    const merged = validateSettingsPatch(partial, current);
    await saveSettings(merged);
    const saved = readSettings();
    safeSend('settings:changed', saved);
    return saved;
  });

  ipcMain.handle('window:minimize', () => sharedState.mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!sharedState.mainWindow) return false;
    if (sharedState.mainWindow.isMaximized()) {
      sharedState.mainWindow.unmaximize();
    } else {
      sharedState.mainWindow.maximize();
    }
    return sharedState.mainWindow.isMaximized();
  });
  ipcMain.handle('window:is-maximized', () => {
    if (!sharedState.mainWindow) return false;
    return sharedState.mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => sharedState.mainWindow?.close());
  ipcMain.handle('clipboard:write-text', async (_, text: unknown) => {
    clipboard.writeText(requireString(text, '剪贴板文本', 1024 * 1024, true));
    return true;
  });
  ipcMain.handle('metrics:set-session', async (_, sessionIdInput: unknown) => {
    sharedState.metricsSessionId = requireNullablePositiveId(sessionIdInput, '指标会话 ID');
    sharedState.metricsInactiveSent = false;
    if (sharedState.metricsSessionId) void requestMetricsCollection();
    return true;
  });

  ipcMain.handle('folder:list', async () => all('SELECT * FROM session_folder ORDER BY id ASC'));
  ipcMain.handle('folder:create', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, '目录');
    const name = requireString(payload.name, '目录名称', 128).trim();
    const parentId = requireNullablePositiveId(payload.parentId, '父目录 ID');
    await run('INSERT INTO session_folder(name, parent_id) VALUES(?, ?)', [name, parentId]);
    return true;
  });
  ipcMain.handle('folder:update', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, '目录');
    const id = requirePositiveId(payload.id, '目录 ID');
    const name = requireString(payload.name, '目录名称', 128).trim();
    await run('UPDATE session_folder SET name = ? WHERE id = ?', [name, id]);
    return true;
  });
  ipcMain.handle('folder:delete', async (_, folderIdInput: unknown) => {
    const folderId = requirePositiveId(folderIdInput, '目录 ID');
    const childFolderCount = await get<{ count: number }>(
      'SELECT COUNT(1) AS count FROM session_folder WHERE parent_id = ?',
      [folderId],
    );
    if ((childFolderCount?.count || 0) > 0) {
      throw new Error('目录下存在子目录，无法删除');
    }
    const sessionCount = await get<{ count: number }>(
      'SELECT COUNT(1) AS count FROM session WHERE folder_id = ?',
      [folderId],
    );
    if ((sessionCount?.count || 0) > 0) {
      throw new Error('目录下存在会话，无法删除');
    }
    await run('DELETE FROM session_folder WHERE id = ?', [folderId]);
    return true;
  });

  ipcMain.handle('session:list', async () => {
    const list = await all<Session>('SELECT * FROM session ORDER BY id ASC');
    return list.map(toPublicSession);
  });
  ipcMain.handle(
    'session:create',
    async (_, payloadInput: unknown) => {
      const payload = parseSession(payloadInput, false);
      await createSessionRecord(payload, sessionPersistenceDependencies);
      return true;
    },
  );
  ipcMain.handle('session:update', async (_, payloadInput: unknown) => {
    const payload = parseSession(payloadInput, true);
    await updateSessionRecord(payload, sessionPersistenceDependencies);
    return true;
  });
  ipcMain.handle('session:delete', async (_, sessionIdInput: unknown) => {
    const sessionId = requirePositiveId(sessionIdInput, '会话 ID');
    await deleteSessionRecord(sessionId, sessionPersistenceDependencies);
    return true;
  });

  ipcMain.handle(
    'ssh:connect',
    async (
      _,
      payloadInput: unknown,
    ) => {
      const connectPayload = typeof payloadInput === 'number'
        ? { sessionId: requirePositiveId(payloadInput, '会话 ID') }
        : requireRecord(payloadInput, 'SSH 连接参数');
      const profileSessionId = requirePositiveId(connectPayload.sessionId, '会话 ID');
      const connectionId = connectPayload.connectionId == null
        ? profileSessionId
        : requirePositiveId(connectPayload.connectionId, '连接 ID');
      cancelPendingHostKeyRequests(connectionId);
      cancelPendingAuthChallenges(connectionId);
      const attempt = beginConnectionAttempt(connectionId);
      sshDataBuffer.flush(connectionId);
      try {
        await cleanupConnectionState(connectionId);
        if (attempt.cancelled) throw new Error(SSH_CONNECT_CANCELLED);
        const session = await loadSession(profileSessionId);
        if (attempt.cancelled) throw new Error(SSH_CONNECT_CANCELLED);
        const suppliedPassword = connectPayload.password == null
          ? undefined
          : requireString(connectPayload.password, '密码', 4096, true);
        const password = suppliedPassword ?? session.password;
        const savePassword = connectPayload.savePassword === true && !!suppliedPassword;
        return await new Promise<boolean>((resolve, reject) => {
       const client = new Client();
       attempt.client = client;
       let settled = false;
       let hostKeyMismatch = false;
       const fail = (err: unknown) => {
         if (settled) return;
         settled = true;
         releaseConnectionAttempt(connectionId, attempt);
         void cleanupConnectionState(connectionId, client);
         if (attempt.cancelled) {
           reject(new Error(SSH_CONNECT_CANCELLED));
           return;
         }
         reject(hostKeyMismatch ? new Error('SSH_HOST_KEY_MISMATCH') : err);
       };
       attempt.reject = (error) => fail(error);
       const ok = () => {
         if (settled) return;
         if (attempt.cancelled) {
           fail(new Error(SSH_CONNECT_CANCELLED));
           return;
         }
         settled = true;
         releaseConnectionAttempt(connectionId, attempt);
         resolve(true);
       };
      client
        .on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
          if (attempt.cancelled) {
            finish([]);
            return;
          }
          if (!prompts || prompts.length === 0) {
            finish([]);
            return;
          }
          const answers = prompts.map(() => '');
          const unknownPrompts: Array<{ prompt: string; echo: boolean; index: number }> = [];
          prompts.forEach((prompt: { prompt?: string; echo?: boolean }, index: number) => {
            const label = String(prompt?.prompt || '认证信息');
            if (isStoredPasswordPrompt(label)) {
              answers[index] = password;
              return;
            }
            unknownPrompts.push({ prompt: String(prompt?.prompt || '认证信息'), echo: !!prompt?.echo, index });
          });
          if (unknownPrompts.length === 0) {
            finish(answers);
            return;
          }
          void requestAuthChallengeAnswers(
            connectionId,
            session.name,
            unknownPrompts.map(({ prompt, echo }) => ({ prompt, echo })),
          ).then((challengeAnswers) => {
            if (!challengeAnswers || challengeAnswers.length !== unknownPrompts.length) {
              finish([]);
              return;
            }
            unknownPrompts.forEach(({ index }, answerIndex) => {
              answers[index] = challengeAnswers[answerIndex];
            });
            finish(answers);
          }).catch(() => finish([]));
        })
        .on('ready', () => {
          if (attempt.cancelled) {
            client.destroy();
            return;
          }
          client.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              fail(err);
              return;
            }
            if (attempt.cancelled) {
              stream.close();
              client.destroy();
              return;
            }
            connectionSessionMap.set(connectionId, { ...session, password });
            sshStateMap.set(connectionId, { client, shell: stream });
            stream.on('data', (data: Buffer) => {
              const text = data.toString('utf8');
              updateCwdFromPrompt(connectionId, text);
              sshDataBuffer.enqueue(connectionId, text);
            });
            stream.on('close', () => {
              sshDataBuffer.flush(connectionId, true);
              void cleanupConnectionState(connectionId, client).then((cleaned) => {
                if (cleaned) safeSend('ssh:closed', { sessionId: connectionId });
              });
            });
            if (savePassword) {
              const latestPassword = String(connectPayload.password || '');
              void saveSessionPasswordRecord(
                profileSessionId,
                latestPassword,
                sessionPersistenceDependencies,
              )
                .then(() => ok())
                .catch((dbErr) => fail(dbErr));
              return;
            }
            ok();
          });
        })
        .on('error', (err) => fail(err))
        .connect({
          host: session.host,
          port: session.port,
          username: session.username,
          password,
          tryKeyboard: true,
          keepaliveInterval: 10000,
          readyTimeout: 20000,
          hostVerifier: createHostVerifier(
            session,
            () => {
              hostKeyMismatch = true;
            },
            connectionId,
          ),
        });
        });
      } catch (error) {
        releaseConnectionAttempt(connectionId, attempt);
        throw error;
      }
    },
  );

  const writeSshInput = (payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SSH 输入');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const input = requireString(payload.input, '终端输入', 64 * 1024, true);
    const state = sshStateMap.get(sessionId);
    if (!state?.shell) throw new Error('SSH 未连接');
    state.shell.write(input);
    return true;
  };
  ipcMain.on('ssh:input', (_, payload: unknown) => {
    writeSshInput(payload);
  });
  ipcMain.handle('ssh:send', async (_, payload: unknown) => {
    return writeSshInput(payload);
  });
  ipcMain.handle('ssh:resize', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, '终端尺寸');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const cols = requireIntegerInRange(payload.cols, '终端列数', 2, 1000);
    const rows = requireIntegerInRange(payload.rows, '终端行数', 2, 1000);
    const state = sshStateMap.get(sessionId);
    if (!state?.shell) return false;
    try {
      state.shell.setWindow(rows, cols, 0, 0);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('ssh:disconnect', async (_, sessionIdInput: unknown) => {
    const sessionId = requirePositiveId(sessionIdInput, '连接 ID');
    cancelPendingHostKeyRequests(sessionId);
    cancelPendingAuthChallenges(sessionId);
    cancelPendingConnectionAttempt(sessionId);
    sshDataBuffer.flush(sessionId, true);
    await cleanupConnectionState(sessionId);
    return true;
  });
  ipcMain.handle('ssh:get-cwd', async (_, sessionIdInput: unknown) => {
    const sessionId = requirePositiveId(sessionIdInput, '连接 ID');
    const state = sshStateMap.get(sessionId);
    if (!state) return '';
    const cached = lastKnownCwdMap.get(sessionId);
    const live = await getRemoteShellCwd(state.client);
    if (live) {
      lastKnownCwdMap.set(sessionId, live);
      return live;
    }
    if (cached && cached.trim()) return cached.trim();
    return '';
  });
  ipcMain.handle('ssh:get-cached-cwd', async (_, sessionIdInput: unknown) => {
    const sessionId = requirePositiveId(sessionIdInput, '连接 ID');
    if (!sshStateMap.has(sessionId)) return '';
    return lastKnownCwdMap.get(sessionId)?.trim() || '';
  });

  ipcMain.handle('sftp:list', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 列表参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const requestSequence = requireIntegerInRange(payload.requestSequence, '请求序号', 0, Number.MAX_SAFE_INTEGER);
    const remotePath = requirePath(payload.path, '远程路径');
    const showHidden = requireBoolean(payload.showHidden, '显示隐藏文件');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const targetPath = await resolveRemotePath(client, remotePath);
    const list = await client.list(targetPath);
    const items = list
      .filter((item: { name: string }) => showHidden || !item.name.startsWith('.'))
      .map((item: any) => ({
        type: item.type,
        name: item.name,
        size: Number(item.size || 0),
        modifyTime: Number(item.modifyTime || 0),
        accessTime: Number(item.accessTime || 0),
        rights: item.rights || undefined,
        owner: item.owner,
        group: item.group,
        longname: item.longname,
      }))
      .sort((a: { type: string; name: string }, b: { type: string; name: string }) => {
        const aDir = a.type === 'd' ? 0 : 1;
        const bDir = b.type === 'd' ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
      });
    return { sessionId, requestSequence, items };
  });
  ipcMain.handle('sftp:home', async (_, sessionIdInput: unknown) => {
    const sessionId = requirePositiveId(sessionIdInput, '连接 ID');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const cwd = await client.cwd().catch(() => '~');
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : '~';
  });
  ipcMain.handle('sftp:mkdir', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 创建目录参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const remotePath = requirePath(payload.path, '远程路径');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const targetPath = await resolveRemotePath(client, remotePath);
    await client.mkdir(targetPath, true);
    return true;
  });
  ipcMain.handle('sftp:rename', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 重命名参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const fromPath = await resolveRemotePath(client, requirePath(payload.from, '源路径'));
    const toPath = await resolveRemotePath(client, requirePath(payload.to, '目标路径'));
    await client.rename(fromPath, toPath);
    return true;
  });
  ipcMain.handle('sftp:delete', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 删除参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const isDir = requireBoolean(payload.isDir, '目录标记');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const targetPath = await resolveRemotePath(client, requirePath(payload.path, '远程路径'));
    if (isDir) await client.rmdir(targetPath, true);
    else await client.delete(targetPath);
    return true;
  });
  ipcMain.handle('sftp:upload', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 上传参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const remoteDir = requirePath(payload.remoteDir, '远程目录');
    const picked = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) return false;
    return runSftpUploadBatch({ sessionId, remoteDir, localPaths: [picked.filePaths[0]] });
  });
  ipcMain.handle('sftp:download', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 下载参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    requireConnected(sessionId);
    const session = await getSessionForConnection(sessionId);
    const client = await getOrCreateSftp(sessionId, session);
    const remotePath = await resolveRemotePath(client, requirePath(payload.remotePath, '远程路径'));
    const fileName = path.basename(remotePath.replace(/\/+$/, '')) || path.basename(remotePath);
    const downloadDir = getDefaultDownloadDir();
    await fs.promises.mkdir(downloadDir, { recursive: true });
    let localPath = await ensureUniqueLocalPath(downloadDir, fileName || 'download');
    const temporaryPath = createTemporaryDownloadPath(localPath);
    try {
      await client.fastGet(remotePath, temporaryPath);
      try {
        await fs.promises.access(localPath, fs.constants.F_OK);
        localPath = await ensureUniqueLocalPath(downloadDir, path.basename(localPath));
      } catch {
        // The allocated final path is still free.
      }
      await fs.promises.rename(temporaryPath, localPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return true;
  });
  ipcMain.handle('sftp:authorize-upload', async (event, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, '上传授权参数');
    return createUploadCapability(event.sender.id, requireStringArray(payload.localPaths, '本地路径', 100));
  });
  ipcMain.handle('sftp:upload-batch', async (event, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 批量上传参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const remoteDir = requirePath(payload.remoteDir, '远程目录');
    let localPaths: string[];
    if (payload.uploadCapability) {
      localPaths = consumeUploadCapability(payload.uploadCapability, event.sender.id);
    } else {
      const picked = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory', 'multiSelections'] });
      if (picked.canceled || picked.filePaths.length === 0) return false;
      localPaths = picked.filePaths;
    }
    return runSftpUploadBatch({ sessionId, remoteDir, localPaths });
  });
  ipcMain.handle('sftp:download-batch', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 批量下载参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const remotePaths = requireStringArray(payload.remotePaths, '远程路径', 1000);
    if (!remotePaths.length) return false;
    const localDir = payload.localDir == null ? getDefaultDownloadDir() : requirePath(payload.localDir, '本地目录');
    await fs.promises.mkdir(localDir, { recursive: true });
    const ok = await runSftpDownloadBatch({ sessionId, remotePaths, localDir });
    return ok;
  });
  ipcMain.handle('sftp:cancel-batch', async (_, payloadInput: unknown) => {
    const payload = requireRecord(payloadInput, 'SFTP 取消参数');
    const sessionId = requirePositiveId(payload.sessionId, '连接 ID');
    const batchId = requireString(payload.batchId, '批次 ID', 128);
    const batch = sftpBatchControlMap.get(batchId);
    if (!batch || batch.sessionId !== sessionId) return false;
    batch.cancelled = true;
    const clients = new Set<any>([...(batch.clients || []), ...(batch.client ? [batch.client] : [])]);
    if (batch.ownsClient) await Promise.all(Array.from(clients, async (client) => client.end().catch(() => null)));
    batch.client = undefined;
    batch.clients = [];
    return true;
  });
  ipcMain.handle('dialog:pick-directory', async (_, defaultPathInput?: unknown) => {
    const defaultPath = defaultPathInput == null ? undefined : requireString(defaultPathInput, '默认目录', 4096, true);
    const picked = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  });

  ipcMain.handle('app:runtime-paths', async () => ({
    runtimeDir,
    userDataPath,
    settingsStorage: `sqlite:${dbPath}#app_setting.${SETTINGS_KEY}`,
    dbPath,
    os: os.platform(),
  }));
  ipcMain.handle('app:open-external', async (_, url: string) => {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('app:switch-to-english-input-method', async () => switchToEnglishInputMethod());
}
