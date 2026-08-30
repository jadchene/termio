import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Metrics, Session, Settings } from '../types';
import type { PasswordPromptResult } from './useDialog';
import { isSshConnectCancelledError } from '../utils/sshConnection';
import type { ConnectionState } from '../types';

type Tab = { id: number; sessionId: number; title: string };

type UseSessionTabsParams = {
  activeSessionId: number | null;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveSessionId: Dispatch<SetStateAction<number | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setMetricsBySession: Dispatch<SetStateAction<Record<number, Metrics>>>;
  settings: Settings | null;
  activeSessionIdRef: MutableRefObject<number | null>;
  tabsRef: MutableRefObject<Tab[]>;
  sessionsRef: MutableRefObject<Session[]>;
  settingsRef: MutableRefObject<Settings | null>;
  nextTabIdRef: MutableRefObject<number>;
  disconnectedByTabRef: MutableRefObject<Map<number, boolean>>;
  reconnectingTabRef: MutableRefObject<Set<number>>;
  metricsVisibleRef: MutableRefObject<boolean>;
  attachTerminal: (sessionId: number, settings: Settings) => void;
  disposeTerminal: (sessionId: number) => void;
  clearSftpSessionState: (sessionId: number) => void;
  setPausedOutput: Dispatch<SetStateAction<boolean>>;
  onReconnectActiveSession?: (tabId: number) => Promise<void> | void;
  askPasswordWithRemember: (
    message: string,
    remember: boolean,
    title?: string,
    requestKey?: string,
  ) => Promise<PasswordPromptResult | null>;
  cancelDialogRequest: (requestKey: string, value?: null) => boolean;
  showAlert: (message: string, title?: string) => Promise<void>;
  isAuthError: (message: string) => boolean;
  isHostKeyMismatchError: (message: string) => boolean;
  setConnectionState: (tabId: number, state: ConnectionState | null) => void;
};

export function useSessionTabs(params: UseSessionTabsParams) {
  const {
    activeSessionId,
    setTabs,
    setActiveSessionId,
    setSessions,
    setMetricsBySession,
    settings,
    activeSessionIdRef,
    tabsRef,
    sessionsRef,
    settingsRef,
    nextTabIdRef,
    disconnectedByTabRef,
    reconnectingTabRef,
    metricsVisibleRef,
    attachTerminal,
    disposeTerminal,
    clearSftpSessionState,
    setPausedOutput,
    onReconnectActiveSession,
    askPasswordWithRemember,
    cancelDialogRequest,
    showAlert,
    isAuthError,
    isHostKeyMismatchError,
    setConnectionState,
  } = params;
  const closedTabIdsRef = useRef<Set<number>>(new Set());

  const wasConnectionCancelled = (tabId: number, error: unknown): boolean => (
    closedTabIdsRef.current.has(tabId) || isSshConnectCancelledError(error)
  );

  const reconnectTab = async (tabId: number) => {
    if (reconnectingTabRef.current.has(tabId)) return;
    const tab = tabsRef.current.find((it) => it.id === tabId);
    if (!tab) return;
    const session = sessionsRef.current.find((it) => it.id === tab.sessionId);
    if (!session) return;
    reconnectingTabRef.current.add(tabId);
    setConnectionState(tabId, 'connecting');
    const markReconnected = async () => {
      disconnectedByTabRef.current.set(tabId, false);
      setConnectionState(tabId, 'connected');
      if (settingsRef.current) attachTerminal(tabId, settingsRef.current);
      if (activeSessionIdRef.current === tabId) {
        if (metricsVisibleRef.current) {
          await window.terminalApi.setMetricsSession(tabId).catch(() => false);
        }
        await Promise.resolve(onReconnectActiveSession?.(tabId)).catch(() => undefined);
        setPausedOutput(false);
      }
    };
    try {
      await window.terminalApi.sshConnect({ sessionId: session.id, connectionId: tabId });
      if (closedTabIdsRef.current.has(tabId)) {
        await window.terminalApi.sshDisconnect(tabId).catch(() => null);
        return;
      }
      await markReconnected();
      return;
    } catch (error) {
      if (wasConnectionCancelled(tabId, error)) return;
      const message = String(error);
      if (!isAuthError(message)) {
        disconnectedByTabRef.current.set(tabId, true);
        setConnectionState(tabId, 'disconnected');
        if (!isHostKeyMismatchError(message)) await showAlert(message, '重连失败');
        return;
      }
      let retryCount = 0;
      while (true) {
        const privateKeyAuth = session.auth_type === 'private_key';
        const passwordResult = await askPasswordWithRemember(
          privateKeyAuth
            ? `会话 ${session.name} 的私钥认证失败。\n已重试 ${retryCount} 次，请输入私钥口令继续（未加密私钥或口令无误时请检查服务器公钥配置）。`
            : `会话 ${session.name} 认证失败。\n已重试 ${retryCount} 次，请输入密码继续（取消可终止重连）。`,
          privateKeyAuth ? session.remember_passphrase === 1 : session.remember_password === 1,
          '重连认证',
          `ssh-connect:${tabId}`,
        );
        if (closedTabIdsRef.current.has(tabId)) return;
        if (!passwordResult?.value) {
          disconnectedByTabRef.current.set(tabId, true);
          setConnectionState(tabId, 'disconnected');
          return;
        }
        const retrySecret = passwordResult.value;
        retryCount += 1;
        try {
          await window.terminalApi.sshConnect({
            sessionId: session.id,
            connectionId: tabId,
            ...(privateKeyAuth
              ? { passphrase: retrySecret, savePassphrase: passwordResult.remember }
              : { password: retrySecret, savePassword: passwordResult.remember }),
          });
          if (closedTabIdsRef.current.has(tabId)) {
            await window.terminalApi.sshDisconnect(tabId).catch(() => null);
            return;
          }
          if (!passwordResult.remember &&
            (privateKeyAuth ? session.remember_passphrase === 1 : session.remember_password === 1)) {
            await window.terminalApi.updateSession(privateKeyAuth
              ? { ...session, passphrase: '', remember_passphrase: 0 }
              : { ...session, password: '', remember_password: 0 });
          }
          setSessions((prev) =>
            prev.map((it) => (
              it.id === session.id
                ? privateKeyAuth
                  ? { ...it, passphrase: '', remember_passphrase: passwordResult.remember ? 1 : 0 }
                  : { ...it, password: '', remember_password: passwordResult.remember ? 1 : 0 }
                : it
            )),
          );
          await markReconnected();
          return;
        } catch (retryError) {
          if (wasConnectionCancelled(tabId, retryError)) return;
          const retryMessage = String(retryError);
          if (!isAuthError(retryMessage)) {
            disconnectedByTabRef.current.set(tabId, true);
            setConnectionState(tabId, 'disconnected');
            if (!isHostKeyMismatchError(retryMessage)) await showAlert(retryMessage, '重连失败');
            return;
          }
        }
      }
    } finally {
      reconnectingTabRef.current.delete(tabId);
    }
  };

  const connectSession = async (session: Session, forceNew = false) => {
    if (!forceNew) {
      const existing = tabsRef.current.find((it) => it.sessionId === session.id);
      if (existing) {
        setActiveSessionId(existing.id);
        return;
      }
    }
    const tabId = Date.now() + nextTabIdRef.current;
    nextTabIdRef.current += 1;
    const previousActiveSessionId = activeSessionIdRef.current;
    const removeFailedTab = () => {
      tabsRef.current = tabsRef.current.filter((it) => it.id !== tabId);
      setTabs((prev) => prev.filter((it) => it.id !== tabId));
      setConnectionState(tabId, null);
      setActiveSessionId((current) => current === tabId
        ? tabsRef.current.some((it) => it.id === previousActiveSessionId)
          ? previousActiveSessionId
          : tabsRef.current.at(-1)?.id ?? null
        : current);
    };
    const newTab = { id: tabId, sessionId: session.id, title: session.name };
    tabsRef.current = [...tabsRef.current, newTab];
    setTabs((prev) => prev.some((it) => it.id === tabId) ? prev : [...prev, newTab]);
    setConnectionState(tabId, 'connecting');
    setActiveSessionId(tabId);
    try {
      await window.terminalApi.sshConnect({ sessionId: session.id, connectionId: tabId });
      if (closedTabIdsRef.current.has(tabId)) {
        await window.terminalApi.sshDisconnect(tabId).catch(() => null);
        return;
      }
      disconnectedByTabRef.current.set(tabId, false);
      setConnectionState(tabId, 'connected');
      if (settings) attachTerminal(tabId, settings);
      setActiveSessionId(tabId);
    } catch (error) {
      if (wasConnectionCancelled(tabId, error)) return;
      const message = String(error);
      if (!isAuthError(message)) {
        removeFailedTab();
        if (!isHostKeyMismatchError(message)) await showAlert(message, '连接失败');
        return;
      }
      let retryCount = 0;
      while (true) {
        const privateKeyAuth = session.auth_type === 'private_key';
        const passwordResult = await askPasswordWithRemember(
          privateKeyAuth
            ? `会话 ${session.name} 的私钥认证失败。\n已重试 ${retryCount} 次，请输入私钥口令继续（未加密私钥或口令无误时请检查服务器公钥配置）。`
            : `会话 ${session.name} 认证失败。\n已重试 ${retryCount} 次，请输入密码继续（取消可终止连接）。`,
          privateKeyAuth ? session.remember_passphrase === 1 : session.remember_password === 1,
          '连接认证',
          `ssh-connect:${tabId}`,
        );
        if (closedTabIdsRef.current.has(tabId)) return;
        if (!passwordResult?.value) {
          removeFailedTab();
          await showAlert(`已取消连接，累计重试 ${retryCount} 次。`, '连接已取消');
          return;
        }
        const retrySecret = passwordResult.value;
        retryCount += 1;
        try {
          await window.terminalApi.sshConnect({
            sessionId: session.id,
            connectionId: tabId,
            ...(privateKeyAuth
              ? { passphrase: retrySecret, savePassphrase: passwordResult.remember }
              : { password: retrySecret, savePassword: passwordResult.remember }),
          });
          if (closedTabIdsRef.current.has(tabId)) {
            await window.terminalApi.sshDisconnect(tabId).catch(() => null);
            return;
          }
          disconnectedByTabRef.current.set(tabId, false);
          setConnectionState(tabId, 'connected');
          if (!passwordResult.remember &&
            (privateKeyAuth ? session.remember_passphrase === 1 : session.remember_password === 1)) {
            await window.terminalApi.updateSession(privateKeyAuth
              ? { ...session, passphrase: '', remember_passphrase: 0 }
              : { ...session, password: '', remember_password: 0 });
          }
          setSessions((prev) =>
            prev.map((it) => (
              it.id === session.id
                ? privateKeyAuth
                  ? { ...it, passphrase: '', remember_passphrase: passwordResult.remember ? 1 : 0 }
                  : { ...it, password: '', remember_password: passwordResult.remember ? 1 : 0 }
                : it
            )),
          );
          if (settings) attachTerminal(tabId, settings);
          setActiveSessionId(tabId);
          return;
        } catch (retryError) {
          if (wasConnectionCancelled(tabId, retryError)) return;
          const retryMessage = String(retryError);
          if (!isAuthError(retryMessage)) {
            removeFailedTab();
            if (!isHostKeyMismatchError(retryMessage)) await showAlert(retryMessage, '连接失败');
            return;
          }
        }
      }
    }
  };

  const closeTab = async (tabId: number) => {
    closedTabIdsRef.current.add(tabId);
    cancelDialogRequest(`ssh-connect:${tabId}`, null);
    await window.terminalApi.sshDisconnect(tabId).catch(() => null);
    disposeTerminal(tabId);
    clearSftpSessionState(tabId);
    reconnectingTabRef.current.delete(tabId);
    disconnectedByTabRef.current.delete(tabId);
    setConnectionState(tabId, null);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeSessionId === tabId) {
        setActiveSessionId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
    setMetricsBySession((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  };

  return {
    reconnectTab,
    connectSession,
    closeTab,
  };
}
