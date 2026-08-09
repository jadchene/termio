import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseTransaction } from '../electron/main/db';
import {
  createSessionRecord,
  saveSessionPasswordRecord,
  type SessionPersistenceDependencies,
} from '../electron/main/sessionPersistence';
import type { Session } from '../electron/main/types';

function createDependencies() {
  let nextId = 0;
  const passwords = new Map<number, string>();
  let queue = Promise.resolve();
  const dependencies: SessionPersistenceDependencies = {
    withTransaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const transaction: DatabaseTransaction = {
          run: async () => undefined,
          insert: async () => ++nextId,
          get: async <R>() => undefined as R | undefined,
          all: async <R>() => [] as R[],
        };
        return await work(transaction);
      } finally {
        release();
      }
    },
    getPassword: async (id) => passwords.get(id) ?? null,
    setPassword: async (id, password) => { passwords.set(id, password); },
    deletePassword: async (id) => { passwords.delete(id); },
  };
  return { dependencies, passwords };
}

function session(index: number): Session {
  return {
    id: 0,
    folder_id: null,
    name: `session-${index}`,
    host: `host-${index}.example`,
    port: 22,
    username: 'root',
    password: `password-${index}`,
    remember_password: 1,
    default_session: index === 0 ? 1 : 0,
  };
}

test('50 concurrent session creates bind every password to its own inserted ID', async () => {
  const { dependencies, passwords } = createDependencies();
  const ids = await Promise.all(Array.from({ length: 50 }, (_, index) => (
    createSessionRecord(session(index), dependencies)
  )));
  assert.equal(new Set(ids).size, 50);
  ids.forEach((id, index) => assert.equal(passwords.get(id), `password-${index}`));
});

test('failed commit removes a password written before the rollback', async () => {
  const { dependencies, passwords } = createDependencies();
  dependencies.withTransaction = async (work) => {
    const transaction: DatabaseTransaction = {
      run: async () => undefined,
      insert: async () => 42,
      get: async <R>() => undefined as R | undefined,
      all: async <R>() => [] as R[],
    };
    await work(transaction);
    throw new Error('commit failed');
  };
  await assert.rejects(createSessionRecord(session(0), dependencies), /commit failed/);
  assert.equal(passwords.has(42), false);
});

test('failed password-save commit restores the previous keytar password', async () => {
  const { dependencies, passwords } = createDependencies();
  passwords.set(7, 'old-password');
  dependencies.withTransaction = async (work) => {
    const transaction: DatabaseTransaction = {
      run: async () => undefined,
      insert: async () => 0,
      get: async <R>() => undefined as R | undefined,
      all: async <R>() => [] as R[],
    };
    await work(transaction);
    throw new Error('commit failed');
  };

  await assert.rejects(
    saveSessionPasswordRecord(7, 'new-password', dependencies),
    /commit failed/,
  );
  assert.equal(passwords.get(7), 'old-password');
});

test('failed keytar password save does not update the database record', async () => {
  const { dependencies } = createDependencies();
  let databaseUpdated = false;
  dependencies.setPassword = async () => { throw new Error('keytar failed'); };
  dependencies.withTransaction = async (work) => work({
    run: async () => { databaseUpdated = true; },
    insert: async () => 0,
    get: async <R>() => undefined as R | undefined,
    all: async <R>() => [] as R[],
  });

  await assert.rejects(
    saveSessionPasswordRecord(7, 'new-password', dependencies),
    /keytar failed/,
  );
  assert.equal(databaseUpdated, false);
});
