const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invokeSftp = async (channel, payload) => {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return result;
  if (result.ok) return result.value;
  return Promise.reject(result.error || { code: 'UNKNOWN', message: '未知 SFTP 错误' });
};

contextBridge.exposeInMainWorld('terminalApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (payload) => ipcRenderer.invoke('settings:update', payload),
  onSettingsChanged: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.off('settings:changed', handler);
  },

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  isMaximizedWindow: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  onMaximizedChanged: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.off('window:maximized-changed', handler);
  },
  setMetricsSession: (sessionId) => ipcRenderer.invoke('metrics:set-session', sessionId),

  listFolders: () => ipcRenderer.invoke('folder:list'),
  createFolder: (payload) => ipcRenderer.invoke('folder:create', payload),
  updateFolder: (payload) => ipcRenderer.invoke('folder:update', payload),
  deleteFolder: (folderId) => ipcRenderer.invoke('folder:delete', folderId),

  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (payload) => ipcRenderer.invoke('session:create', payload),
  updateSession: (payload) => ipcRenderer.invoke('session:update', payload),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
  pickPrivateKey: (defaultPath) => ipcRenderer.invoke('dialog:pick-private-key', defaultPath),

  sshConnect: (payload) => ipcRenderer.invoke('ssh:connect', payload),
  sshSendInput: (payload) => ipcRenderer.send('ssh:input', payload),
  sshSend: (payload) => ipcRenderer.invoke('ssh:send', payload),
  sshResize: (payload) => ipcRenderer.invoke('ssh:resize', payload),
  sshDisconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  sshGetCwd: (sessionId) => ipcRenderer.invoke('ssh:get-cwd', sessionId),
  sshGetCachedCwd: (sessionId) => ipcRenderer.invoke('ssh:get-cached-cwd', sessionId),
  onSshData: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.off('ssh:data', handler);
  },
  onSshClosed: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:closed', handler);
    return () => ipcRenderer.off('ssh:closed', handler);
  },
  onSshHostKeyVerification: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:host-key-verification', handler);
    return () => ipcRenderer.off('ssh:host-key-verification', handler);
  },
  resolveSshHostKeyVerification: (requestId, accepted) =>
    ipcRenderer.invoke('ssh:host-key-verification-response', requestId, accepted),
  onSshHostKeyVerificationExpired: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:host-key-verification-expired', handler);
    return () => ipcRenderer.off('ssh:host-key-verification-expired', handler);
  },
  onSshHostKeyMismatch: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:host-key-mismatch', handler);
    return () => ipcRenderer.off('ssh:host-key-mismatch', handler);
  },
  onSshAuthChallenge: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:auth-challenge', handler);
    return () => ipcRenderer.off('ssh:auth-challenge', handler);
  },
  resolveSshAuthChallenge: (requestId, answers) =>
    ipcRenderer.invoke('ssh:auth-challenge-response', requestId, answers),
  onSshAuthChallengeExpired: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('ssh:auth-challenge-expired', handler);
    return () => ipcRenderer.off('ssh:auth-challenge-expired', handler);
  },

  sftpList: (payload) => invokeSftp('sftp:list', payload),
  sftpGetHome: (sessionId) => invokeSftp('sftp:home', sessionId),
  sftpMkdir: (payload) => invokeSftp('sftp:mkdir', payload),
  sftpRename: (payload) => invokeSftp('sftp:rename', payload),
  sftpDelete: (payload) => invokeSftp('sftp:delete', payload),
  sftpUpload: (payload) => invokeSftp('sftp:upload', payload),
  sftpDownload: (payload) => invokeSftp('sftp:download', payload),
  sftpAuthorizeDroppedFiles: (files) => {
    const localPaths = Array.from(files || [])
      .map((file) => {
        try {
          return webUtils.getPathForFile(file) || '';
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    return invokeSftp('sftp:authorize-upload', { localPaths });
  },
  sftpUploadBatch: (payload) => invokeSftp('sftp:upload-batch', payload),
  sftpDownloadBatch: (payload) => invokeSftp('sftp:download-batch', payload),
  sftpStartNativeDrag: (payload) => ipcRenderer.send('sftp:start-native-drag', payload),
  sftpCancelNativeDrag: (token) => ipcRenderer.invoke('sftp:cancel-native-drag', token),
  onSftpNativeDragEnded: (callback) => {
    const handler = (_, token) => callback(token);
    ipcRenderer.on('sftp:native-drag-ended', handler);
    return () => ipcRenderer.off('sftp:native-drag-ended', handler);
  },
  sftpCancelBatch: (payload) => invokeSftp('sftp:cancel-batch', payload),
  onSftpProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.off('sftp:progress', handler);
  },
  onSftpBatchComplete: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('sftp:batch-complete', handler);
    return () => ipcRenderer.off('sftp:batch-complete', handler);
  },
  onSftpBatchError: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('sftp:batch-error', handler);
    return () => ipcRenderer.off('sftp:batch-error', handler);
  },

  onMetrics: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('system:metrics', handler);
    return () => ipcRenderer.off('system:metrics', handler);
  },

  pickDirectory: (defaultPath) => ipcRenderer.invoke('dialog:pick-directory', defaultPath),
  getRuntimePaths: () => ipcRenderer.invoke('app:runtime-paths'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  switchToEnglishInputMethod: () => ipcRenderer.invoke('app:switch-to-english-input-method'),
});
