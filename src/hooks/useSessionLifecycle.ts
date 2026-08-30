import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ConnectionState, Session, Settings } from '../types';
import { formatSftpError, isSilentSftpError } from '../utils/sftpError';
import { resolveMetricsSessionId } from '../utils/metricsVisibility';

type UseSessionLifecycleParams = {
  settings: Settings | null;
  sessions: Session[];
  tabCount: number;
  sidebarTab: 'sessions' | 'sftp' | 'status';
  activeSessionId: number | null;
  connectionState: ConnectionState | null;
  terminalContainerRef: MutableRefObject<HTMLDivElement | null>;
  connectSession: (session: Session, forceNew?: boolean) => Promise<void>;
  attachTerminal: (sessionId: number, settings: Settings) => void;
  focusTerminalInput: (sessionId: number, autoSwitchEnglishInputMethod?: boolean) => void;
  getPausedByScroll: (sessionId: number) => boolean;
  setPausedOutput: Dispatch<SetStateAction<boolean>>;
  flushPendingOutput: (sessionId: number) => void;
  fitTerminalStabilized: (sessionId: number) => void;
  setSftpPath: Dispatch<SetStateAction<string>>;
  setSftpPathInput: Dispatch<SetStateAction<string>>;
  clearSftpSelection: () => void;
  sftpPath: string;
  clearSftpItems: () => void;
  hasSftpSessionState: (sessionId: number) => boolean;
  refreshSftp: (targetPath?: string) => Promise<boolean>;
  showAlert: (message: string, title?: string) => Promise<void>;
};

export function useSessionLifecycle(params: UseSessionLifecycleParams) {
  const {
    settings,
    sessions,
    tabCount,
    sidebarTab,
    activeSessionId,
    connectionState,
    terminalContainerRef,
    connectSession,
    attachTerminal,
    focusTerminalInput,
    getPausedByScroll,
    setPausedOutput,
    flushPendingOutput,
    fitTerminalStabilized,
    setSftpPath,
    setSftpPathInput,
    clearSftpSelection,
    sftpPath,
    clearSftpItems,
    hasSftpSessionState,
    refreshSftp,
    showAlert,
  } = params;
  const lastSftpErrorRef = useRef({ message: '', timestamp: 0 });

  const reportSftpError = useCallback(async (error: unknown) => {
    if (isSilentSftpError(error)) return;
    const message = formatSftpError(error);
    const now = Date.now();
    const previous = lastSftpErrorRef.current;
    if (previous.message === message && now - previous.timestamp < 2_000) return;
    lastSftpErrorRef.current = { message, timestamp: now };
    await showAlert(message, 'SFTP');
  }, [showAlert]);

  useEffect(() => {
    if (!settings) return;
    const defaultOne = sessions.find((it) => it.default_session === 1);
    if (defaultOne && tabCount === 0) {
      connectSession(defaultOne).catch(() => null);
    }
  }, [settings, sessions, tabCount, connectSession]);

  useEffect(() => {
    if (!settings || !activeSessionId) return;
    attachTerminal(activeSessionId, settings);
    focusTerminalInput(activeSessionId, !!settings.behavior.autoSwitchEnglishInputMethod);
    const paused = getPausedByScroll(activeSessionId);
    setPausedOutput(paused);
    if (!paused) {
      flushPendingOutput(activeSessionId);
    }
  }, [
    activeSessionId,
    settings?.theme.mode,
    settings?.theme.terminalFontFamily,
    settings?.theme.terminalFontSize,
    settings?.theme.terminalCursorStyle,
    settings?.theme.terminalCursorBlink,
    settings?.theme.terminalCursorWidth,
    settings?.behavior.autoCopySelection,
    settings?.behavior.autoSwitchEnglishInputMethod,
    attachTerminal,
    focusTerminalInput,
    getPausedByScroll,
    setPausedOutput,
    flushPendingOutput,
  ]);

  useEffect(() => {
    if (!activeSessionId || connectionState !== 'connected' || sidebarTab !== 'sftp' || !settings?.ui.sidebarVisible) return;
    if (hasSftpSessionState(activeSessionId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const home = await window.terminalApi.sftpGetHome(activeSessionId);
        if (cancelled) return;
        const target = home?.trim() || '~';
        clearSftpSelection();
        const accepted = await refreshSftp(target);
        if (!cancelled && accepted) setSftpPath(target);
      } catch (error) {
        if (cancelled || isSilentSftpError(error)) return;
        try {
          clearSftpSelection();
          const accepted = await refreshSftp('~');
          if (!cancelled && accepted) setSftpPath('~');
        } catch (fallbackError) {
          if (!cancelled) await reportSftpError(fallbackError);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, connectionState, sidebarTab, settings?.ui.sidebarVisible, setSftpPath, clearSftpSelection, hasSftpSessionState, refreshSftp, reportSftpError]);

  useEffect(() => {
    const metricsSessionId = resolveMetricsSessionId(
      activeSessionId,
      sidebarTab,
      !!settings?.ui.sidebarVisible,
    );
    window.terminalApi.setMetricsSession(metricsSessionId).catch(() => null);
  }, [activeSessionId, sidebarTab, settings?.ui.sidebarVisible]);

  useEffect(() => {
    if (!activeSessionId || !terminalContainerRef.current) return;
    const container = terminalContainerRef.current;
    const ro = new ResizeObserver(() => {
      fitTerminalStabilized(activeSessionId);
    });
    ro.observe(container);
    const onResize = () => fitTerminalStabilized(activeSessionId);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [activeSessionId, settings?.ui.sidebarVisible, terminalContainerRef, fitTerminalStabilized]);

  useEffect(() => {
    if (!settings || !activeSessionId || connectionState !== 'connected' || sidebarTab !== 'sftp' || !settings.ui.sidebarVisible || !hasSftpSessionState(activeSessionId)) return;
    let cancelled = false;
    void refreshSftp().catch(async (error) => {
      if (!cancelled) await reportSftpError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [settings?.ui.showHiddenFiles, settings?.ui.sidebarVisible, sidebarTab, activeSessionId, connectionState, hasSftpSessionState, refreshSftp, reportSftpError]);

  useEffect(() => {
    if (!settings || !activeSessionId || connectionState !== 'connected' || sidebarTab !== 'sftp' || !settings.ui.sidebarVisible || !hasSftpSessionState(activeSessionId)) return;
    let cancelled = false;
    void refreshSftp().catch(async (error) => {
      if (!cancelled) await reportSftpError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [sidebarTab, activeSessionId, connectionState, settings?.ui.sidebarVisible, hasSftpSessionState, refreshSftp, reportSftpError]);

  useEffect(() => {
    if (!activeSessionId) {
      clearSftpItems();
      clearSftpSelection();
      setPausedOutput(false);
      if (terminalContainerRef.current) {
        terminalContainerRef.current.innerHTML = '';
      }
    }
  }, [activeSessionId, clearSftpItems, clearSftpSelection, setPausedOutput, terminalContainerRef]);

  useEffect(() => {
    setSftpPathInput(sftpPath);
  }, [sftpPath, setSftpPathInput]);
}
