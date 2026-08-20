import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const isDev = !app.isPackaged;

const rendererUrlArgument = process.argv.find((argument) => argument.startsWith('--renderer-url='));
const requestedRendererUrl = rendererUrlArgument?.slice('--renderer-url='.length) || '';

export const rendererDevUrl = isDev && /^http:\/\/localhost:5173\/?$/i.test(requestedRendererUrl)
  ? 'http://localhost:5173'
  : '';

export const devAppRoot = path.resolve(__dirname, '..', '..', '..');

export const appRoot = isDev ? devAppRoot : app.getAppPath();

export const runtimeDir = isDev ? devAppRoot : path.dirname(process.execPath);

export const dataDir = path.join(runtimeDir, 'data');

export const userDataPath = path.join(dataDir, 'user-data');

export const dbPath = path.join(dataDir, 'app.db');

export const windowStatePath = path.join(userDataPath, 'window-state.json');

export const configureUserDataPath = (): void => {
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
};

function migrateLegacyRuntimeData() {
  const legacyDbPath = path.join(runtimeDir, 'app.db');
  const legacyUserDataPath = path.join(runtimeDir, 'user-data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(legacyDbPath) && !fs.existsSync(dbPath)) {
      fs.renameSync(legacyDbPath, dbPath);
    }
    if (fs.existsSync(legacyUserDataPath) && !fs.existsSync(userDataPath)) {
      fs.renameSync(legacyUserDataPath, userDataPath);
    }
  } catch (error) {
    console.warn('failed to migrate legacy runtime data:', error);
  }
}

migrateLegacyRuntimeData();

export const preloadCandidates = [
  path.join(appRoot, 'electron', 'preload.js'),
  path.join(appRoot, 'dist-electron', 'electron', 'preload.js'),
  path.join(__dirname, '..', 'preload.js'),
];

export const preloadPath = preloadCandidates.find((candidate) => fs.existsSync(candidate)) || preloadCandidates[0];
