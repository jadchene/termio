import { app, BrowserWindow } from 'electron';
import { db, initStorage } from './db';
import {
  connectionHomeMap,
  connectionSessionMap,
  cwdOutputTailMap,
  lastKnownCwdMap,
  remoteMetricsPayloadMap,
  remoteMetricsSnapshotMap,
  sftpBatchControlMap,
  sftpMap,
  sharedState,
  sshStateMap,
} from './state';
import { subscribeMetrics } from './metrics';
import { createWindow, flushWindowState } from './window';
import { registerIpc } from './ipc';
import { cancelAllNativeFileDrags } from './nativeFileDrag';
import { cancelPendingHostKeyRequests } from './hostKey';
import { cancelPendingAuthChallenges } from './authChallenge';
import { cancelAllPendingConnectionAttempts } from './connectionAttempt';

export function focusMainWindow(): void {
  const target = sharedState.mainWindow;
  if (!target || target.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

export async function startApp(): Promise<void> {
  await initStorage();
  await app.whenReady();
  registerIpc();
  createWindow();
  subscribeMetrics();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let gracefulQuitStarted = false;
let gracefulQuitFinished = false;

async function cleanupBeforeQuit(): Promise<void> {
  flushWindowState(sharedState.mainWindow);
  cancelAllNativeFileDrags();
  cancelPendingHostKeyRequests();
  cancelPendingAuthChallenges();
  cancelAllPendingConnectionAttempts();
  if (sharedState.metricsTimer) clearInterval(sharedState.metricsTimer);
  sharedState.metricsTimer = null;
  const clientsToClose = new Set<any>();
  for (const [, control] of sftpBatchControlMap) {
    control.cancelled = true;
    if (control.client) clientsToClose.add(control.client);
    for (const client of control.clients || []) clientsToClose.add(client);
  }
  for (const [, sftp] of sftpMap) clientsToClose.add(sftp);
  await Promise.all(Array.from(clientsToClose, async (client) => client.end().catch(() => undefined)));
  for (const [, state] of sshStateMap) {
    try {
      state.client.end();
    } catch {
      // Ignore connection shutdown errors.
    }
  }
  sshStateMap.clear();
  connectionSessionMap.clear();
  connectionHomeMap.clear();
  cwdOutputTailMap.clear();
  lastKnownCwdMap.clear();
  remoteMetricsPayloadMap.clear();
  remoteMetricsSnapshotMap.clear();
  sftpMap.clear();
  sftpBatchControlMap.clear();
  await new Promise<void>((resolve) => db.close(() => resolve()));
}

app.on('before-quit', (event) => {
  if (gracefulQuitFinished) return;
  event.preventDefault();
  if (gracefulQuitStarted) return;
  gracefulQuitStarted = true;
  void Promise.race([
    cleanupBeforeQuit(),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => {
    gracefulQuitFinished = true;
    app.quit();
  });
});
