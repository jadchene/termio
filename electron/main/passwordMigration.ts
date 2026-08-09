import type { Session } from './types';

export type PasswordMigrationDependencies = {
  setPassword: (sessionId: number, password: string) => Promise<void>;
  deletePassword: (sessionId: number) => Promise<void>;
  clearPlainPassword: (sessionId: number) => Promise<void>;
};

export async function migrateSessionPasswords(
  sessions: Session[],
  dependencies: PasswordMigrationDependencies,
): Promise<void> {
  for (const session of sessions) {
    const plainPassword = String(session.password || '');
    if (session.remember_password !== 1) {
      await dependencies.deletePassword(session.id);
    } else if (plainPassword) {
      await dependencies.setPassword(session.id, plainPassword);
    }

    if (plainPassword) {
      await dependencies.clearPlainPassword(session.id);
    }
  }
}
