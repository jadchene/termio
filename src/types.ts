export type Settings = {
  theme: {
    mode: 'dark' | 'light';
    backgroundColor: string;
    foregroundColor: string;
    uiFontFamily: string;
    uiFontSize: number;
    terminalFontFamily: string;
    terminalFontSize: number;
    terminalCursorStyle: 'block' | 'underline' | 'bar';
    terminalCursorBlink: boolean;
    terminalCursorWidth: number;
  };
  behavior: {
    autoCopySelection: boolean;
    rightClickPaste: boolean;
    multilineWarning: boolean;
    defaultDownloadDir: string;
    autoSwitchEnglishInputMethod: boolean;
  };
  ui: {
    sidebarVisible: boolean;
    sftpVisible: boolean;
    showHiddenFiles: boolean;
    sidebarWidth: number;
  };
};

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type Folder = {
  id: number;
  parent_id: number | null;
  name: string;
};

export type Session = {
  id: number;
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  remember_password: number;
  default_session: number;
};

export type Metrics = {
  sessionId: number | null;
  sequence: number;
  stale: boolean;
  sampledAt: number;
  system: {
    version: string;
    arch: string;
    kernelVersion: string;
    uptimeSeconds: number;
  };
  cpu: number;
  cpuName: string;
  cpuPhysicalCores: number;
  cpuLogicalCores: number;
  cpuFrequencyMhz: number;
  cpuMaxFrequencyMhz: number;
  cpuTemp: number | null;
  memory: {
    usedGb: number;
    totalGb: number;
    percent: number;
    swapUsedGb: number;
    swapTotalGb: number;
  };
  network: {
    upload: number;
    download: number;
    ips: string[];
    interfaceName: string;
    gateway: string;
    dns: string[];
  };
  disk: {
    totalGb: number;
    usedGb: number;
    percent: number;
    upload: number;
    download: number;
    ssdCount: number;
    ssdTotalGb: number;
    hddCount: number;
    hddTotalGb: number;
  };
  gpu:
    | {
        available: false;
        driverVersion: string;
        cudaVersion: string;
        items: [];
      }
    | {
        available: true;
        driverVersion: string;
        cudaVersion: string;
        items: Array<{
          index: number;
          name: string;
          temperature: number;
          memoryUsedGb: number;
          memoryTotalGb: number;
          memoryPercent: number;
          load: number;
          powerDraw: number | null;
          powerLimit: number | null;
          clockMhz: number | null;
        }>;
      };
  processes: Array<{
    pid: number;
    name: string;
    cpuPercent: number;
    memoryBytes: number;
  }>;
};

export type SftpItem = {
  type: string;
  name: string;
  size: number;
  modifyTime: number;
  accessTime?: number;
  rights?: {
    user: string;
    group: string;
    other: string;
  };
  owner?: number;
  group?: number;
  longname?: string;
};

export type SftpTransferProgress = {
  sessionId: number;
  batchId: string;
  direction: 'upload' | 'download';
  index: number;
  totalCount: number;
  completedCount: number;
  name: string;
  transferred: number;
  total: number;
};

export type SftpTransferBatchResult = {
  sessionId: number;
  batchId: string;
  direction: 'upload' | 'download';
  totalCount: number;
  successCount: number;
  failedCount: number;
  cancelled?: boolean;
};

export type SftpTransferError = {
  sessionId: number;
  batchId: string;
  direction: 'upload' | 'download';
  name: string;
  errorCode: import('./utils/sftpError').SftpErrorCode;
  error: string;
};

export type TreeContextMenu =
  | { x: number; y: number; type: 'session'; id: number; name: string }
  | { x: number; y: number; type: 'folder'; id: number; name: string }
  | { x: number; y: number; type: 'sftp'; sessionId: number; path: string; name: string; isDir: boolean };

declare global {
  interface Window {
    terminalApi: {
      getSettings: () => Promise<Settings>;
      updateSettings: (payload: Partial<Settings>) => Promise<Settings>;
      onSettingsChanged: (cb: (settings: Settings) => void) => () => void;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<boolean>;
      isMaximizedWindow: () => Promise<boolean>;
      closeWindow: () => Promise<void>;
      writeClipboardText: (text: string) => Promise<boolean>;
      onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void;
      setMetricsSession: (sessionId: number | null) => Promise<boolean>;

      listFolders: () => Promise<Folder[]>;
      createFolder: (payload: { name: string; parentId: number | null }) => Promise<boolean>;
      updateFolder: (payload: { id: number; name: string }) => Promise<boolean>;
      deleteFolder: (folderId: number) => Promise<boolean>;

      listSessions: () => Promise<Session[]>;
      createSession: (payload: Omit<Session, 'id'>) => Promise<boolean>;
      updateSession: (payload: Session) => Promise<boolean>;
      deleteSession: (sessionId: number) => Promise<boolean>;

      sshConnect: (payload: { sessionId: number; connectionId?: number; password?: string; savePassword?: boolean } | number) => Promise<boolean>;
      sshSendInput: (payload: { sessionId: number; input: string }) => void;
      sshSend: (payload: { sessionId: number; input: string }) => Promise<boolean>;
      sshResize: (payload: { sessionId: number; cols: number; rows: number }) => Promise<boolean>;
      sshDisconnect: (sessionId: number) => Promise<boolean>;
      sshGetCwd: (sessionId: number) => Promise<string>;
      sshGetCachedCwd: (sessionId: number) => Promise<string>;
      onSshData: (cb: (event: { sessionId: number; data: string }) => void) => () => void;
      onSshClosed: (cb: (event: { sessionId: number }) => void) => () => void;
      onSshHostKeyVerification: (cb: (event: {
        requestId: string;
        sessionId: number;
        name: string;
        host: string;
        port: number;
        algorithm: string;
        fingerprint: string;
      }) => void) => () => void;
      resolveSshHostKeyVerification: (requestId: string, accepted: boolean) => Promise<boolean>;
      onSshHostKeyVerificationExpired: (cb: (event: { requestId: string }) => void) => () => void;
      onSshHostKeyMismatch: (cb: (event: {
        requestId: string;
        sessionId: number;
        name: string;
        host: string;
        port: number;
        algorithm: string;
        expectedFingerprint: string;
        actualFingerprint: string;
      }) => void) => () => void;
      onSshAuthChallenge: (cb: (event: {
        requestId: string;
        connectionId: number;
        sessionName: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
      }) => void) => () => void;
      resolveSshAuthChallenge: (requestId: string, answers: string[] | null) => Promise<boolean>;
      onSshAuthChallengeExpired: (cb: (event: { requestId: string }) => void) => () => void;

      sftpList: (payload: {
        sessionId: number;
        requestSequence: number;
        path: string;
        showHidden: boolean;
      }) => Promise<{ sessionId: number; requestSequence: number; items: SftpItem[] }>;
      sftpGetHome: (sessionId: number) => Promise<string>;
      sftpMkdir: (payload: { sessionId: number; path: string }) => Promise<boolean>;
      sftpRename: (payload: { sessionId: number; from: string; to: string }) => Promise<boolean>;
      sftpDelete: (payload: { sessionId: number; path: string; isDir: boolean }) => Promise<boolean>;
      sftpUpload: (payload: { sessionId: number; remoteDir: string }) => Promise<boolean>;
      sftpDownload: (payload: { sessionId: number; remotePath: string }) => Promise<boolean>;
      sftpAuthorizeDroppedFiles: (files: File[]) => Promise<string>;
      sftpUploadBatch: (payload: { sessionId: number; remoteDir: string; uploadCapability?: string }) => Promise<boolean>;
      sftpDownloadBatch: (payload: { sessionId: number; remotePaths: string[]; localDir?: string }) => Promise<boolean>;
      sftpStartNativeDrag: (payload: {
        sessionId: number;
        token: string;
        items: Array<{ remotePath: string; name: string; isDirectory: boolean; size: number }>;
      }) => void;
      sftpCancelNativeDrag: (token: string) => Promise<boolean>;
      onSftpNativeDragEnded: (cb: (event: { token: string; error: string }) => void) => () => void;
      sftpCancelBatch: (payload: { sessionId: number; batchId: string }) => Promise<boolean>;
      onSftpProgress: (cb: (event: SftpTransferProgress) => void) => () => void;
      onSftpBatchComplete: (cb: (event: SftpTransferBatchResult) => void) => () => void;
      onSftpBatchError: (cb: (event: SftpTransferError) => void) => () => void;

      onMetrics: (cb: (metrics: Metrics) => void) => () => void;
      pickDirectory: (defaultPath?: string) => Promise<string | null>;
      getRuntimePaths: () => Promise<{ runtimeDir: string; userDataPath: string; settingsStorage: string; dbPath: string; os: string }>;
      openExternal: (url: string) => Promise<boolean>;
      switchToEnglishInputMethod: () => Promise<boolean>;
    };
  }
}

export {};
