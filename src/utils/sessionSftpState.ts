import type { SftpItem } from '../types';

export type SessionSftpState = {
  path: string;
  pathInput: string;
  items: SftpItem[];
  selectedPaths: string[];
  loading: boolean;
};

export const createSessionSftpState = (): SessionSftpState => ({
  path: '~',
  pathInput: '~',
  items: [],
  selectedPaths: [],
  loading: false,
});

export const updateSessionSftpState = (
  states: Map<number, SessionSftpState>,
  sessionId: number,
  updater: (current: SessionSftpState) => SessionSftpState,
): Map<number, SessionSftpState> => {
  const next = new Map(states);
  next.set(sessionId, updater(states.get(sessionId) ?? createSessionSftpState()));
  return next;
};
