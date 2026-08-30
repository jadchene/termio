import { BrowserWindow, Menu, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { WindowState } from './types';
import { appRoot, windowStatePath, preloadCandidates, preloadPath, rendererDevUrl } from './env';
import { sharedState } from './state';

let persistWindowStateTimer: NodeJS.Timeout | null = null;
let rendererApprovedClose = false;

export function approveMainWindowClose(): void {
  rendererApprovedClose = true;
}

export function closeMainWindow(): void {
  const target = sharedState.mainWindow;
  if (!target || target.isDestroyed()) return;
  approveMainWindowClose();
  target.close();
}

export function readWindowState(): WindowState | null {
  try {
    const raw = fs.readFileSync(windowStatePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width = Math.max(900, Number(parsed.width || 1400));
    const height = Math.max(600, Number(parsed.height || 900));
    const hasX = Number.isFinite(parsed.x);
    const hasY = Number.isFinite(parsed.y);
    return {
      width,
      height,
      x: hasX ? Number(parsed.x) : undefined,
      y: hasY ? Number(parsed.y) : undefined,
      maximized: !!parsed.maximized,
    };
  } catch {
    return null;
  }
}

export function persistWindowState(target: BrowserWindow | null) {
  if (!target || target.isDestroyed()) return;
  const normalBounds = target.getNormalBounds();
  const payload: WindowState = {
    x: normalBounds.x,
    y: normalBounds.y,
    width: normalBounds.width,
    height: normalBounds.height,
    maximized: target.isMaximized(),
  };
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn('failed to persist window state:', error);
  }
}

export function schedulePersistWindowState(target: BrowserWindow | null) {
  if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer);
  persistWindowStateTimer = setTimeout(() => {
    persistWindowStateTimer = null;
    persistWindowState(target);
  }, 200);
}

export function flushWindowState(target: BrowserWindow | null) {
  if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer);
  persistWindowStateTimer = null;
  persistWindowState(target);
}

export function safeSend(channel: string, payload?: unknown) {
  if (!sharedState.mainWindow || sharedState.mainWindow.isDestroyed()) return;
  const wc = sharedState.mainWindow.webContents;
  if (wc.isDestroyed()) return;
  try {
    if (payload === undefined) {
      wc.send(channel);
      return;
    }
    wc.send(channel, payload);
  } catch (error) {
    const message = String(error || '').toLowerCase();
    if (message.includes('object has been destroyed') || message.includes('ipc') || message.includes('channel')) {
      return;
    }
    console.warn('safeSend failed:', { channel, error });
  }
}

export function createWindow() {
  if (!fs.existsSync(preloadPath)) {
    throw new Error(`preload.js not found. tried: ${preloadCandidates.join(' | ')}`);
  }
  const savedState = readWindowState();
  const hasVisibleSavedPosition = savedState?.x !== undefined && savedState.y !== undefined
    && screen.getAllDisplays().some(({ workArea }) => {
      const visibleWidth = Math.min(savedState.x! + savedState.width, workArea.x + workArea.width)
        - Math.max(savedState.x!, workArea.x);
      const visibleHeight = Math.min(savedState.y! + savedState.height, workArea.y + workArea.height)
        - Math.max(savedState.y!, workArea.y);
      return visibleWidth >= 100 && visibleHeight >= 100;
    });
  sharedState.mainWindow = new BrowserWindow({
    width: savedState?.width || 1400,
    height: savedState?.height || 900,
    x: hasVisibleSavedPosition ? savedState?.x : undefined,
    y: hasVisibleSavedPosition ? savedState?.y : undefined,
    frame: false,
    backgroundColor: '#000000',
    icon: path.join(appRoot, 'assets', 'app-icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const rendererWebContents = sharedState.mainWindow.webContents;
  const rendererSession = rendererWebContents.session;
  const allowedRendererPermissions = new Set(['local-fonts', 'clipboard-read']);
  rendererSession.setPermissionCheckHandler((webContents, permission) => (
    webContents === rendererWebContents && allowedRendererPermissions.has(String(permission))
  ));
  rendererSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(webContents === rendererWebContents && allowedRendererPermissions.has(String(permission)));
  });
  const csp = rendererDevUrl
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://localhost:5173 ws://localhost:5173; object-src 'none'; base-uri 'none'; frame-src 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
  sharedState.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
  sharedState.mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  if (rendererDevUrl) {
    void sharedState.mainWindow.loadURL(rendererDevUrl);
  } else {
    void sharedState.mainWindow.loadFile(path.join(appRoot, 'dist', 'index.html'));
  }
  sharedState.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      // Ignore invalid renderer window-open requests.
    }
    return { action: 'deny' };
  });
  sharedState.mainWindow.webContents.on('did-fail-load', (_, code, desc, url) => {
    console.error('Renderer load failed:', { code, desc, url });
  });
  sharedState.mainWindow.on('maximize', () => {
    flushWindowState(sharedState.mainWindow);
    safeSend('window:maximized-changed', true);
  });
  sharedState.mainWindow.on('unmaximize', () => {
    flushWindowState(sharedState.mainWindow);
    safeSend('window:maximized-changed', false);
  });
  sharedState.mainWindow.on('resize', () => schedulePersistWindowState(sharedState.mainWindow));
  sharedState.mainWindow.on('move', () => schedulePersistWindowState(sharedState.mainWindow));
  if (savedState?.maximized) {
    sharedState.mainWindow.maximize();
  }
  sharedState.mainWindow.on('close', (event) => {
    if (!rendererApprovedClose) {
      event.preventDefault();
      safeSend('window:close-requested');
      return;
    }
    rendererApprovedClose = false;
    flushWindowState(sharedState.mainWindow);
  });
  sharedState.mainWindow.on('closed', () => {
    sharedState.mainWindow = null;
  });
  Menu.setApplicationMenu(null);
}
