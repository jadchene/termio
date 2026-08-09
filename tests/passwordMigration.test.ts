import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateSessionPasswords } from '../electron/main/passwordMigration';
import type { Session } from '../electron/main/types';

function session(id: number, password: string, rememberPassword = 1): Session {
  return {
    id,
    folder_id: null,
    name: `session-${id}`,
    host: 'host.example',
    port: 22,
    username: 'root',
    password,
    remember_password: rememberPassword,
    default_session: 0,
  };
}

test('password migration is restart-safe after an interrupted run', async () => {
  const sessions = [session(1, 'password-1'), session(2, 'password-2')];
  const passwords = new Map<number, string>();
  let failSecondClear = true;
  const dependencies = {
    setPassword: async (id: number, password: string) => { passwords.set(id, password); },
    deletePassword: async (id: number) => { passwords.delete(id); },
    clearPlainPassword: async (id: number) => {
      if (id === 2 && failSecondClear) throw new Error('database failed');
      const target = sessions.find((item) => item.id === id);
      if (target) target.password = '';
    },
  };

  await assert.rejects(migrateSessionPasswords(sessions, dependencies), /database failed/);
  assert.equal(passwords.get(1), 'password-1');
  assert.equal(sessions[0].password, '');

  failSecondClear = false;
  await migrateSessionPasswords(sessions, dependencies);
  assert.equal(passwords.get(1), 'password-1');
  assert.equal(passwords.get(2), 'password-2');
  assert.equal(sessions[1].password, '');
});

test('migration removes keytar entries only for sessions that do not remember passwords', async () => {
  const sessions = [session(1, '', 1), session(2, '', 0)];
  const passwords = new Map<number, string>([[1, 'keep'], [2, 'remove']]);

  await migrateSessionPasswords(sessions, {
    setPassword: async (id, password) => { passwords.set(id, password); },
    deletePassword: async (id) => { passwords.delete(id); },
    clearPlainPassword: async () => undefined,
  });

  assert.equal(passwords.get(1), 'keep');
  assert.equal(passwords.has(2), false);
});
