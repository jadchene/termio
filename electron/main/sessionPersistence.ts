import type { DatabaseTransaction } from './db';
import type { Session } from './types';

export type SessionPersistenceDependencies = {
  withTransaction: <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => Promise<T>;
  getPassword: (sessionId: number) => Promise<string | null>;
  setPassword: (sessionId: number, password: string) => Promise<void>;
  deletePassword: (sessionId: number) => Promise<void>;
};

export async function createSessionRecord(
  payload: Session,
  dependencies: SessionPersistenceDependencies,
): Promise<number> {
  let sessionId = 0;
  let passwordStored = false;
  try {
    await dependencies.withTransaction(async (transaction) => {
      if (payload.default_session === 1) {
        await transaction.run('UPDATE session SET default_session = 0');
      }
      sessionId = await transaction.insert(
        `INSERT INTO session(folder_id, name, host, port, username, password, remember_password, default_session)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.folder_id,
          payload.name,
          payload.host,
          payload.port,
          payload.username,
          '',
          payload.remember_password,
          payload.default_session,
        ],
      );
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw new Error('创建会话后未获得有效记录 ID');
      }
      if (payload.remember_password === 1 && payload.password.length > 0) {
        await dependencies.setPassword(sessionId, payload.password);
        passwordStored = true;
      }
    });
    return sessionId;
  } catch (error) {
    if (sessionId > 0 && passwordStored) {
      await dependencies.deletePassword(sessionId).catch(() => undefined);
    }
    throw error;
  }
}

export async function updateSessionRecord(
  payload: Session,
  dependencies: SessionPersistenceDependencies,
): Promise<void> {
  const previousPassword = await dependencies.getPassword(payload.id);
  let keytarChanged = false;
  try {
    await dependencies.withTransaction(async (transaction) => {
      if (payload.default_session === 1) {
        await transaction.run('UPDATE session SET default_session = 0');
      }
      await transaction.run(
        `UPDATE session
         SET folder_id = ?, name = ?, host = ?, port = ?, username = ?, password = ?, remember_password = ?, default_session = ?
         WHERE id = ?`,
        [
          payload.folder_id,
          payload.name,
          payload.host,
          payload.port,
          payload.username,
          '',
          payload.remember_password,
          payload.default_session,
          payload.id,
        ],
      );
      if (payload.remember_password !== 1) {
        await dependencies.deletePassword(payload.id);
        keytarChanged = previousPassword !== null;
      } else if (payload.password.length > 0) {
        await dependencies.setPassword(payload.id, payload.password);
        keytarChanged = payload.password !== previousPassword;
      }
    });
  } catch (error) {
    if (keytarChanged) {
      if (previousPassword === null) {
        await dependencies.deletePassword(payload.id).catch(() => undefined);
      } else {
        await dependencies.setPassword(payload.id, previousPassword).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function saveSessionPasswordRecord(
  sessionId: number,
  password: string,
  dependencies: SessionPersistenceDependencies,
): Promise<void> {
  const previousPassword = await dependencies.getPassword(sessionId);
  let passwordChanged = false;
  try {
    await dependencies.withTransaction(async (transaction) => {
      await dependencies.setPassword(sessionId, password);
      passwordChanged = password !== previousPassword;
      await transaction.run(
        'UPDATE session SET password = ?, remember_password = 1 WHERE id = ?',
        ['', sessionId],
      );
    });
  } catch (error) {
    if (passwordChanged) {
      if (previousPassword === null) {
        await dependencies.deletePassword(sessionId).catch(() => undefined);
      } else {
        await dependencies.setPassword(sessionId, previousPassword).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function deleteSessionRecord(
  sessionId: number,
  dependencies: SessionPersistenceDependencies,
): Promise<void> {
  const previousPassword = await dependencies.getPassword(sessionId);
  let passwordDeleted = false;
  try {
    await dependencies.withTransaction(async (transaction) => {
      await transaction.run('DELETE FROM session WHERE id = ?', [sessionId]);
      await dependencies.deletePassword(sessionId);
      passwordDeleted = previousPassword !== null;
    });
  } catch (error) {
    if (passwordDeleted && previousPassword !== null) {
      await dependencies.setPassword(sessionId, previousPassword).catch(() => undefined);
    }
    throw error;
  }
}
