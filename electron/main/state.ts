import { BrowserWindow } from 'electron';
import os from 'node:os';
import { Session, SshConnectionState, SftpBatchControl, SftpProgressThrottleState, RemoteMetricsSnapshot, RemoteMetricsPayload } from './types';

export const sshStateMap = new Map<number, SshConnectionState>();

export const sftpMap = new Map<number, any>();

export const sftpBatchControlMap = new Map<string, SftpBatchControl>();

export const sftpProgressThrottleMap = new Map<string, SftpProgressThrottleState>();

export const DEFAULT_TRANSFER_CONCURRENCY = Math.max(1, Math.min(3, Math.floor((os.cpus()?.length || 2) / 2)));

export const connectionSessionMap = new Map<number, Session>();

export const connectionHomeMap = new Map<number, string>();

export const lastKnownCwdMap = new Map<number, string>();

export const cwdOutputTailMap = new Map<number, string>();

export const PASSWORD_MIGRATION_KEY = 'session_password_keytar_migrated';

export const KEYTAR_SERVICE = 'my-terminal.session-password';

export const remoteMetricsSnapshotMap = new Map<number, RemoteMetricsSnapshot>();

export const remoteMetricsPayloadMap = new Map<number, RemoteMetricsPayload>();

export const METRICS_SLOW_SAMPLE_INTERVAL_MS = 5000;
export const METRICS_NETWORK_SAMPLE_INTERVAL_MS = 30000;

export const sharedState = {
  mainWindow: null as BrowserWindow | null,
  metricsTimer: null as NodeJS.Timeout | null,
  metricsCollecting: false,
  metricsSessionId: null as number | null,
  metricsInactiveSent: false,
  settingsCache: null as any
};
