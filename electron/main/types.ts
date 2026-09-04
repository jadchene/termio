import { Client } from 'ssh2';

export type AppSettings = {
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

export type Session = {
  id: number;
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private_key';
  password: string;
  remember_password: number;
  private_key_path: string;
  passphrase: string;
  remember_passphrase: number;
  default_session: number;
};

export type SshConnectionState = {
  client: Client;
  shell?: any;
};

export type SftpProgressPayload = {
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

export type SftpBatchControl = {
  sessionId: number;
  connectionId: number;
  cancelled: boolean;
  client?: any;
  clients?: any[];
  ownsClient?: boolean;
};

export type SftpProgressThrottleState = {
  at: number;
  transferred: number;
  total: number;
};

export type RemoteMetricsSnapshot = {
  cpuTotal: number;
  cpuIdle: number;
  processCpuTicks: Map<number, number>;
  netRx: number;
  netTx: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  at: number;
};

export type RemoteMetricsPayload = {
  sessionId: number | null;
  sequence: number;
  stale: boolean;
  sampledAt: number;
  system: { version: string; arch: string; kernelVersion: string; uptimeSeconds: number };
  cpu: number;
  cpuName: string;
  cpuPhysicalCores: number;
  cpuLogicalCores: number;
  cpuFrequencyMhz: number;
  cpuMaxFrequencyMhz: number;
  cpuTemp: number | null;
  memory: { usedGb: number; totalGb: number; percent: number; swapUsedGb: number; swapTotalGb: number };
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
    | { available: false; driverVersion: string; cudaVersion: string; items: [] }
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

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

export type UploadTask = {
  localPath: string;
  remotePath: string;
  name: string;
  size: number;
};

export type DownloadTask = {
  remotePath: string;
  localPath: string;
  name: string;
  size: number;
};
