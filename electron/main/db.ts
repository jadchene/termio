import sqlite3 from 'sqlite3';
import { Session } from './types';
import { dbPath } from './env';
import { defaultSettings, SETTINGS_KEY, normalizeSettings, saveSettings, readAppSetting, writeAppSetting } from './settings';
import { PASSWORD_MIGRATION_KEY, sharedState } from './state';
import { setSessionPasswordToKeytar, deleteSessionPasswordFromKeytar } from './session';
import { migrateSessionPasswords } from './passwordMigration';

export const db = new sqlite3.Database(dbPath);

type SqlParams = unknown[];

export type DatabaseTransaction = {
  run: (sql: string, params?: SqlParams) => Promise<void>;
  insert: (sql: string, params?: SqlParams) => Promise<number>;
  get: <T>(sql: string, params?: SqlParams) => Promise<T | undefined>;
  all: <T>(sql: string, params?: SqlParams) => Promise<T[]>;
};

let databaseQueue: Promise<void> = Promise.resolve();

function enqueueDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = databaseQueue.then(operation, operation);
  databaseQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runDirect(sql: string, params: SqlParams = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function insertDirect(sql: string, params: SqlParams = []): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this.lastID);
    });
  });
}

function allDirect<T>(sql: string, params: SqlParams = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows as T[]);
    });
  });
}

function getDirect<T>(sql: string, params: SqlParams = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

export function run(sql: string, params: SqlParams = []): Promise<void> {
  return enqueueDatabaseOperation(() => runDirect(sql, params));
}

export function insert(sql: string, params: SqlParams = []): Promise<number> {
  return enqueueDatabaseOperation(() => insertDirect(sql, params));
}

export function all<T>(sql: string, params: SqlParams = []): Promise<T[]> {
  return enqueueDatabaseOperation(() => allDirect<T>(sql, params));
}

export function get<T>(sql: string, params: SqlParams = []): Promise<T | undefined> {
  return enqueueDatabaseOperation(() => getDirect<T>(sql, params));
}

export function withTransaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return enqueueDatabaseOperation(async () => {
    await runDirect('BEGIN IMMEDIATE');
    const transaction: DatabaseTransaction = {
      run: runDirect,
      insert: insertDirect,
      get: getDirect,
      all: allDirect,
    };
    try {
      const result = await work(transaction);
      await runDirect('COMMIT');
      return result;
    } catch (error) {
      await runDirect('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function migrateSessionPasswordsToKeytarIfNeeded() {
  const flag = await readAppSetting(PASSWORD_MIGRATION_KEY);
  if (flag === '1') return;
  const sessions = await all<Session>('SELECT * FROM session');
  await migrateSessionPasswords(sessions, {
    setPassword: setSessionPasswordToKeytar,
    deletePassword: deleteSessionPasswordFromKeytar,
    clearPlainPassword: async (sessionId) => {
      await run('UPDATE session SET password = ? WHERE id = ?', ['', sessionId]);
    },
  });
  await writeAppSetting(PASSWORD_MIGRATION_KEY, '1');
}

export async function initStorage() {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA busy_timeout = 5000');
  await run(
    `CREATE TABLE IF NOT EXISTS session_folder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      name TEXT NOT NULL
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'password',
      password TEXT,
      remember_password INTEGER DEFAULT 1,
      private_key_path TEXT NOT NULL DEFAULT '',
      remember_passphrase INTEGER DEFAULT 0,
      default_session INTEGER DEFAULT 0
    )`,
  );
  const sessionColumns = new Set((await all<{ name: string }>('PRAGMA table_info(session)')).map((column) => column.name));
  if (!sessionColumns.has('auth_type')) {
    await run("ALTER TABLE session ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password'");
  }
  if (!sessionColumns.has('private_key_path')) {
    await run("ALTER TABLE session ADD COLUMN private_key_path TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has('remember_passphrase')) {
    await run('ALTER TABLE session ADD COLUMN remember_passphrase INTEGER DEFAULT 0');
  }
  await run(
    `CREATE TABLE IF NOT EXISTS app_setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  await run(
    `UPDATE session
     SET default_session = 0
     WHERE default_session = 1
       AND id <> (SELECT MIN(id) FROM session WHERE default_session = 1)`,
  );
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS uk_session_single_default
     ON session(default_session)
     WHERE default_session = 1`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS ssh_host_key (
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      algorithm TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      key_base64 TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(host, port)
    )`,
  );
  const existing = await get<{ value: string }>('SELECT value FROM app_setting WHERE key = ?', [SETTINGS_KEY]);
  if (existing?.value) {
    try {
      sharedState.settingsCache = normalizeSettings(JSON.parse(existing.value));
    } catch {
      await saveSettings(defaultSettings);
    }
  } else {
    await saveSettings(defaultSettings);
  }
  await migrateSessionPasswordsToKeytarIfNeeded();
}
