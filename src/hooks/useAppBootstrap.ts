import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  Folder,
  Metrics,
  Session,
  Settings,
  SftpTransferBatchResult,
  SftpTransferError,
  SftpTransferProgress,
} from '../types';
import type { ConnectionState } from '../types';

type UseAppBootstrapParams = {
  activeSessionIdRef: MutableRefObject<number | null>;
  tabsRef: MutableRefObject<Array<{ id: number }>>;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  setRuntimeInfo: Dispatch<
    SetStateAction<{
      runtimeDir: string;
      userDataPath: string;
      settingsStorage: string;
      dbPath: string;
      os: string;
    } | null>
  >;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setIsMaximized: Dispatch<SetStateAction<boolean>>;
  setMetrics: Dispatch<SetStateAction<Metrics | null>>;
  setMetricsBySession: Dispatch<SetStateAction<Record<number, Metrics>>>;
  disconnectedByTabRef: MutableRefObject<Map<number, boolean>>;
  reconnectingTabRef: MutableRefObject<Set<number>>;
  terminalMapRef: MutableRefObject<Map<number, import('@xterm/xterm').Terminal>>;
  appendPendingOutput: (sessionId: number, data: string) => void;
  writeTerminalOutput: (sessionId: number, data: string, term?: import('@xterm/xterm').Terminal) => void;
  getPausedByScroll: (sessionId: number) => boolean;
  isAtBottom: (term: import('@xterm/xterm').Terminal) => boolean;
  setPausedByScroll: (sessionId: number, paused: boolean, term?: import('@xterm/xterm').Terminal) => void;
  fitTerminalStabilized: (sessionId: number) => void;
  updateTransferRow: (payload: SftpTransferProgress) => void;
  markTransferBatchComplete: (payload: SftpTransferBatchResult) => Promise<void> | void;
  markTransferError: (payload: SftpTransferError) => void;
  setConnectionState: (tabId: number, state: ConnectionState | null) => void;
};

export function useAppBootstrap(params: UseAppBootstrapParams) {
  const metricsSequenceRef = useRef<Map<number | null, number>>(new Map());
  const bootstrapSequenceRef = useRef(0);
  const [bootstrapError, setBootstrapError] = useState('');
  const {
    activeSessionIdRef,
    tabsRef,
    setSettings,
    setRuntimeInfo,
    setFolders,
    setSessions,
    setIsMaximized,
    setMetrics,
    setMetricsBySession,
    disconnectedByTabRef,
    reconnectingTabRef,
    terminalMapRef,
    appendPendingOutput,
    writeTerminalOutput,
    getPausedByScroll,
    isAtBottom,
    setPausedByScroll,
    fitTerminalStabilized,
    updateTransferRow,
    markTransferBatchComplete,
    markTransferError,
    setConnectionState,
  } = params;

  const loadSessionData = useCallback(async () => {
    const [folderResult, sessionResult] = await Promise.all([
      window.terminalApi.listFolders(),
      window.terminalApi.listSessions(),
    ]);
    setFolders(folderResult);
    setSessions(sessionResult);
  }, [setFolders, setSessions]);

  const handlerRef = useRef({
      appendPendingOutput,
      writeTerminalOutput,
      getPausedByScroll,
      isAtBottom,
      setPausedByScroll,
      fitTerminalStabilized,
      updateTransferRow,
      markTransferBatchComplete,
      markTransferError,
    });

  useEffect(() => {
    handlerRef.current = {
      appendPendingOutput,
      writeTerminalOutput,
      getPausedByScroll,
      isAtBottom,
      setPausedByScroll,
      fitTerminalStabilized,
      updateTransferRow,
      markTransferBatchComplete,
      markTransferError,
    };
  }, [
    appendPendingOutput,
    writeTerminalOutput,
    getPausedByScroll,
    isAtBottom,
    setPausedByScroll,
    fitTerminalStabilized,
    updateTransferRow,
    markTransferBatchComplete,
    markTransferError,
  ]);

  useEffect(() => {
    const unSettings = window.terminalApi.onSettingsChanged(setSettings);
    const unMaximize = window.terminalApi.onMaximizedChanged((v) => setIsMaximized(v));
    const unData = window.terminalApi.onSshData(({ sessionId, data }) => {
      const handlers = handlerRef.current;
      const cleanData = data;
      if (!cleanData) return;
      if (
        activeSessionIdRef.current === sessionId &&
        (cleanData.includes('\u001b[?1049h') ||
          cleanData.includes('\u001b[?1047h') ||
          cleanData.includes('\u001b[?47h') ||
          cleanData.includes('\u001b[?1049l') ||
          cleanData.includes('\u001b[?1047l') ||
          cleanData.includes('\u001b[?47l'))
      ) {
        handlers.fitTerminalStabilized(sessionId);
      }
      const term = terminalMapRef.current.get(sessionId);
      if (!term) {
        handlers.appendPendingOutput(sessionId, cleanData);
        return;
      }
      const pausedFlag = handlers.getPausedByScroll(sessionId);
      if (pausedFlag) {
        if (handlers.isAtBottom(term)) {
          handlers.setPausedByScroll(sessionId, false, term);
          handlers.writeTerminalOutput(sessionId, cleanData, term);
          return;
        }
        handlers.appendPendingOutput(sessionId, cleanData);
        return;
      }
      handlers.writeTerminalOutput(sessionId, cleanData, term);
    });
    const unClosed = window.terminalApi.onSshClosed(({ sessionId }) => {
      if (!tabsRef.current.some((tab) => tab.id === sessionId)) return;
      disconnectedByTabRef.current.set(sessionId, true);
      reconnectingTabRef.current.delete(sessionId);
      setConnectionState(sessionId, 'disconnected');
      const term = terminalMapRef.current.get(sessionId);
      if (term) handlerRef.current.writeTerminalOutput(sessionId, '\r\n[连接已关闭，按 R 重连]\r\n', term);
    });
    const unMetrics = window.terminalApi.onMetrics((payload) => {
      const previousSequence = metricsSequenceRef.current.get(payload.sessionId) ?? -1;
      if (payload.sequence <= previousSequence) return;
      metricsSequenceRef.current.set(payload.sessionId, payload.sequence);
      setMetrics(payload);
      if (payload.sessionId != null) {
        setMetricsBySession((prev) => ({ ...prev, [payload.sessionId as number]: payload }));
      }
    });
    const unSftpProgress = window.terminalApi.onSftpProgress((event) => handlerRef.current.updateTransferRow(event));
    const unSftpBatchComplete = window.terminalApi.onSftpBatchComplete((event) => {
      void Promise.resolve(handlerRef.current.markTransferBatchComplete(event)).catch(() => null);
    });
    const unSftpBatchError = window.terminalApi.onSftpBatchError((event) => {
      handlerRef.current.markTransferError(event);
    });

    return () => {
      unSettings();
      unMaximize();
      unData();
      unClosed();
      unMetrics();
      unSftpProgress();
      unSftpBatchComplete();
      unSftpBatchError();
    };
  }, [
    activeSessionIdRef,
    tabsRef,
    disconnectedByTabRef,
    reconnectingTabRef,
    setIsMaximized,
    setMetrics,
    setMetricsBySession,
    setSettings,
    setConnectionState,
    terminalMapRef,
  ]);

  const initializeApp = useCallback(async () => {
    const sequence = ++bootstrapSequenceRef.current;
    setBootstrapError('');
    try {
      const [initSettings, runtime, folderResult, sessionResult] = await Promise.all([
        window.terminalApi.getSettings(),
        window.terminalApi.getRuntimePaths(),
        window.terminalApi.listFolders(),
        window.terminalApi.listSessions(),
      ]);
      if (sequence !== bootstrapSequenceRef.current) return;
      setSettings(initSettings);
      setRuntimeInfo(runtime);
      setFolders(folderResult);
      setSessions(sessionResult);
    } catch (error) {
      if (sequence !== bootstrapSequenceRef.current) return;
      setSettings(null);
      setBootstrapError(error instanceof Error ? error.message : String(error || '应用初始化失败'));
    }
  }, [setFolders, setRuntimeInfo, setSessions, setSettings]);

  useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  useEffect(() => {
    window.terminalApi.isMaximizedWindow().then((v) => setIsMaximized(v)).catch(() => null);
  }, [setIsMaximized]);

  return {
    loadSessionData,
    bootstrapError,
    retryBootstrap: initializeApp,
  };
}
