import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { App as AntApp, Button, ConfigProvider, theme as antTheme } from 'antd';
import '@xterm/xterm/css/xterm.css';
import type {
  Folder,
  Metrics,
  Session,
  Settings,
  TreeContextMenu,
  ConnectionState,
} from './types';
import { AppHeader } from './components/AppHeader';
import { SidebarShell } from './components/SidebarShell';
import { TerminalZone } from './components/TerminalZone';
import { ModalHost } from './components/ModalHost';
import { useDialog } from './hooks/useDialog';
import { useTransferQueue } from './hooks/useTransferQueue';
import { useSftpPanel } from './hooks/useSftpPanel';
import { useSessionTabs } from './hooks/useSessionTabs';
import { useFolderTreeOptions } from './hooks/useFolderTreeOptions';
import { useTerminalRuntime } from './hooks/useTerminalRuntime';
import { useSidebarResize } from './hooks/useSidebarResize';
import { useOverlayClose } from './hooks/useOverlayClose';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { useSftpInteractions } from './hooks/useSftpInteractions';
import { useSessionTreeActions } from './hooks/useSessionTreeActions';
import { useSessionLifecycle } from './hooks/useSessionLifecycle';
import { useSettingsActions } from './hooks/useSettingsActions';
import { useWindowActions } from './hooks/useWindowActions';
import { formatSftpError, isSilentSftpError } from './utils/sftpError';
import { formatSftpMeta } from './utils/sftpFormat';
import { getTerminalTheme } from './utils/terminalTheme';

type SessionForm = Omit<Session, 'id'>;
type Tab = { id: number; sessionId: number; title: string };

const defaultSessionForm: SessionForm = {
  folder_id: null,
  name: '',
  host: '',
  port: 22,
  username: 'root',
  password: '',
  remember_password: 1,
  default_session: 0,
};

function isAuthError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('all configured authentication methods failed') ||
    text.includes('authentication failure') ||
    text.includes('permission denied') ||
    text.includes('auth fail')
  );
}

const isHostKeyMismatchError = (message: string): boolean => message.includes('SSH_HOST_KEY_MISMATCH');

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsBySession, setMetricsBySession] = useState<Record<number, Metrics>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'appearance' | 'behavior' | 'system'>('appearance');
  const [connectionStates, setConnectionStates] = useState<Record<number, ConnectionState>>({});
  const [isMaximized, setIsMaximized] = useState(false);

  const [showSessionModal, setShowSessionModal] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [sessionForm, setSessionForm] = useState<SessionForm>(defaultSessionForm);

  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderParent, setFolderParent] = useState<number | null>(null);
  const [showSessionPassword, setShowSessionPassword] = useState(false);
  const [sessionFolderMenuOpen, setSessionFolderMenuOpen] = useState(false);
  const [folderParentMenuOpen, setFolderParentMenuOpen] = useState(false);
  const [cursorStyleMenuOpen, setCursorStyleMenuOpen] = useState(false);

  const [runtimeInfo, setRuntimeInfo] = useState<{
    runtimeDir: string;
    userDataPath: string;
    settingsStorage: string;
    dbPath: string;
    os: string;
  } | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'sessions' | 'sftp' | 'status'>('sessions');
  const [treeMenu, setTreeMenu] = useState<TreeContextMenu | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(new Set());

  const setConnectionState = useCallback((tabId: number, state: ConnectionState | null) => {
    setConnectionStates((previous) => {
      if (state) return { ...previous, [tabId]: state };
      const next = { ...previous };
      delete next[tabId];
      return next;
    });
  }, []);

  const disconnectedByTabRef = useRef<Map<number, boolean>>(new Map());
  const reconnectingTabRef = useRef<Set<number>>(new Set());
  const sessionFolderMenuRef = useRef<HTMLDivElement>(null);
  const folderParentMenuRef = useRef<HTMLDivElement>(null);
  const cursorStyleMenuRef = useRef<HTMLDivElement>(null);
  const sftpInternalDragRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<number | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const sessionsRef = useRef<Session[]>([]);
  const settingsRef = useRef<Settings | null>(null);
  const expiredAuthRequestIdsRef = useRef<Set<string>>(new Set());
  const {
    dialog,
    dialogInput,
    showDialogPassword,
    capsLockOn,
    dialogRemember,
    setDialogInput,
    setShowDialogPassword,
    setCapsLockOn,
    setDialogRemember,
    closeDialog,
    cancelDialogRequest,
    askConfirm,
    askPrompt,
    askPassword,
    askPasswordWithRemember,
    showAlert,
  } = useDialog();

  useEffect(() => {
    const unsubscribeHostKey = window.terminalApi.onSshHostKeyVerification((event) => {
      void (async () => {
        const requestKey = `ssh-host-key:${event.requestId}`;
        const accepted = await askConfirm(
          `首次连接到 ${event.host}:${event.port}。\n\n` +
            `会话: ${event.name}\n算法: ${event.algorithm}\n指纹: ${event.fingerprint}\n\n` +
            '请通过可信渠道核对指纹。确认后将保存此主机密钥。',
          '确认 SSH 主机指纹',
          requestKey,
        ).catch(() => false);
        await window.terminalApi.resolveSshHostKeyVerification(event.requestId, accepted).catch(() => false);
      })();
    });
    const unsubscribeHostKeyExpired = window.terminalApi.onSshHostKeyVerificationExpired(({ requestId }) => {
      cancelDialogRequest(`ssh-host-key:${requestId}`, false);
    });
    const unsubscribeHostKeyMismatch = window.terminalApi.onSshHostKeyMismatch((event) => {
      void showAlert(
        `已阻止连接到 ${event.host}:${event.port}。\n\n` +
          `保存的指纹: ${event.expectedFingerprint}\n当前指纹: ${event.actualFingerprint}\n\n` +
          '服务器主机密钥发生变化。请先确认服务器是否重装或存在网络劫持。',
        'SSH 主机指纹不匹配',
      );
    });
    const unsubscribeAuthChallenge = window.terminalApi.onSshAuthChallenge((event) => {
      void (async () => {
        const requestKey = `ssh-auth:${event.requestId}`;
        try {
          const answers: string[] = [];
          for (const prompt of event.prompts) {
            if (expiredAuthRequestIdsRef.current.has(event.requestId)) return;
            const answer = prompt.echo
              ? await askPrompt(prompt.prompt || '认证信息', '', `${event.sessionName} 交互认证`, requestKey)
              : await askPassword(prompt.prompt || '认证信息', `${event.sessionName} 交互认证`, requestKey);
            if (answer == null) {
              if (!expiredAuthRequestIdsRef.current.has(event.requestId)) {
                await window.terminalApi.resolveSshAuthChallenge(event.requestId, null).catch(() => false);
              }
              return;
            }
            answers.push(answer);
          }
          if (!expiredAuthRequestIdsRef.current.has(event.requestId)) {
            await window.terminalApi.resolveSshAuthChallenge(event.requestId, answers).catch(() => false);
          }
        } finally {
          expiredAuthRequestIdsRef.current.delete(event.requestId);
        }
      })();
    });
    const unsubscribeAuthChallengeExpired = window.terminalApi.onSshAuthChallengeExpired(({ requestId }) => {
      expiredAuthRequestIdsRef.current.add(requestId);
      cancelDialogRequest(`ssh-auth:${requestId}`, null);
    });
    return () => {
      unsubscribeHostKey();
      unsubscribeHostKeyExpired();
      unsubscribeHostKeyMismatch();
      unsubscribeAuthChallenge();
      unsubscribeAuthChallengeExpired();
    };
  }, [askConfirm, askPassword, askPrompt, cancelDialogRequest, showAlert]);
  const {
    transferRows,
    updateTransferRow,
    markTransferBatchComplete,
    markTransferError,
    cancelTransferRow,
  } = useTransferQueue({
    showAlert,
    cancelBatch: (payload) => window.terminalApi.sftpCancelBatch(payload),
  });
  const {
    terminalContainerRef,
    terminalMapRef,
    pausedOutput,
    setPausedOutput,
    appendPendingOutput,
    flushPendingOutput,
    writeTerminalOutput,
    setPausedByScroll,
    syncPauseStateWithViewport,
    fitTerminal,
    fitTerminalStabilized,
    focusTerminalInput,
    getPausedByScroll,
    attachTerminal,
    disposeTerminal,
    setReconnectHandler,
    isAtBottom,
  } = useTerminalRuntime({
    activeSessionIdRef,
    disconnectedByTabRef,
    sendInput: window.terminalApi.sshSendInput,
    resizePty: window.terminalApi.sshResize,
  });

  const nextTabIdRef = useRef(1);
  const activeTab = useMemo(
    () => tabs.find((it) => it.id === activeSessionId) || null,
    [tabs, activeSessionId],
  );
  const activeSession = useMemo(
    () => sessions.find((it) => it.id === activeTab?.sessionId) || null,
    [sessions, activeTab],
  );
  const {
    sftpPath,
    setSftpPath,
    sftpPathInput,
    setSftpPathInput,
    sftpItems,
    selectedSftpPaths,
    sftpUploadDropOver,
    setSftpUploadDropOver,
    refreshSftp,
    setSftpSelection,
    navigateSftp,
    getCurrentSftpLocation,
    hasSftpSessionState,
    clearSftpSessionState,
    clearSftpSelectionNow,
    clearSftpSelection,
    clearSftpItems,
    submitSftpPath,
  } = useSftpPanel({
    activeSessionId,
    showHiddenFiles: !!settings?.ui.showHiddenFiles,
    showAlert,
  });
  const { folderTreeData } = useFolderTreeOptions(folders);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    const isDarkTheme = settings?.theme.mode !== 'light';
    document.body.classList.toggle('theme-dark', isDarkTheme);
    document.body.classList.toggle('theme-light', !isDarkTheme);
    return () => {
      document.body.classList.remove('theme-dark', 'theme-light');
    };
  }, [settings?.theme.mode]);

  const { sidebarWidth: resolvedSidebarWidth, startSidebarResize } = useSidebarResize({
    settings,
    activeSessionId,
    sidebarWidth,
    setSidebarWidth,
    setSettings,
    fitTerminal,
    fitTerminalStabilized,
  });

  const { loadSessionData, bootstrapError, retryBootstrap } = useAppBootstrap({
    activeSessionIdRef,
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
  });

  const { reconnectTab, connectSession, closeTab } = useSessionTabs({
    tabs,
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
    attachTerminal,
    disposeTerminal,
    clearSftpSessionState,
    setPausedOutput,
    onReconnectActiveSession: async (tabId) => {
      if (hasSftpSessionState(tabId)) {
        try {
          if (await refreshSftp()) return;
        } catch {
          // Fall back to the remote home directory below.
        }
      }
      let target = '~';
      try {
        const home = await window.terminalApi.sftpGetHome(tabId);
        target = home?.trim() || '~';
      } catch (error) {
        if (isSilentSftpError(error)) return;
      }
      clearSftpSelection();
      try {
        const accepted = await refreshSftp(target);
        if (accepted) setSftpPath(target);
      } catch (error) {
        if (!isSilentSftpError(error)) await showAlert(formatSftpError(error), 'SFTP');
      }
    },
    askPasswordWithRemember,
    cancelDialogRequest,
    showAlert,
    isAuthError,
    isHostKeyMismatchError,
    setConnectionState,
  });

  useEffect(() => {
    setReconnectHandler((tabId) => {
      void reconnectTab(tabId);
    });
  }, [reconnectTab, setReconnectHandler]);

  useSessionLifecycle({
    settings,
    sessions,
    tabCount: tabs.length,
    sidebarTab,
    activeSessionId,
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
  });

  useOverlayClose({
    treeMenu,
    setTreeMenu,
    sessionFolderMenuOpen,
    setSessionFolderMenuOpen,
    sessionFolderMenuRef,
    folderParentMenuOpen,
    setFolderParentMenuOpen,
    folderParentMenuRef,
    cursorStyleMenuOpen,
    setCursorStyleMenuOpen,
    cursorStyleMenuRef,
  });

  const sftpInteractions = useSftpInteractions({
    activeSessionId,
    activeSession,
    settings,
    setSettings,
    sftpPath,
    sftpItems,
    selectedSftpPaths,
    setSftpPathInput,
    setSftpUploadDropOver,
    setTreeMenu,
    sftpInternalDragRef,
    refreshSftp,
    navigateSftp,
    getCurrentSftpLocation,
    clearSftpSelectionNow,
    submitSftpPath,
    setSftpSelection,
    showAlert,
    askPrompt,
    askConfirm,
  });

  const sessionTreeActions = useSessionTreeActions({
    sessions,
    editingSession,
    sessionForm,
    folderName,
    folderParent,
    defaultSessionForm,
    setShowSessionModal,
    setEditingSession,
    setSessionForm,
    setShowSessionPassword,
    setSessionFolderMenuOpen,
    setShowFolderModal,
    setFolderName,
    setFolderParent,
    setFolderParentMenuOpen,
    setTreeMenu,
    loadSessionData,
    askConfirm,
    askPrompt,
    showAlert,
  });

  const settingsActions = useSettingsActions({
    settings,
    settingsDraft,
    runtimeInfo,
    setSettings,
    setSettingsDraft,
    setShowSettings,
    setSettingsTab,
    setCursorStyleMenuOpen,
    showAlert,
  });

  const windowActions = useWindowActions({
    closeTab,
  });

  if (!settings) {
    return (
      <div className="loading">
        <div className="loading-content">
          <div>{bootstrapError ? '应用初始化失败' : '加载中...'}</div>
          {bootstrapError && (
            <>
              <div className="loading-error">{bootstrapError}</div>
              <Button type="primary" onClick={() => void retryBootstrap()}>重试</Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const currentMetrics = activeSessionId ? (metricsBySession[activeSessionId] ?? null) : metrics;
  const currentTransferRows = activeSessionId ? transferRows.filter((it) => it.sessionId === activeSessionId) : [];

  const isDark = settings.theme.mode !== 'light';
  const terminalTheme = getTerminalTheme(settings.theme.mode);

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#4f8cff',
          colorBgBase: isDark ? '#000000' : '#f5f7fa',
          colorBgContainer: isDark ? '#101010' : '#ffffff',
          colorBgElevated: isDark ? '#080808' : '#ffffff',
          colorBorder: isDark ? '#2a2a2a' : '#d9dfe8',
          borderRadius: 6,
          fontFamily: 'MiSans, sans-serif',
          fontSize: settings.theme.uiFontSize || 13,
        },
      }}
    >
      <AntApp className={`app-shell theme-${isDark ? 'dark' : 'light'}`}
      style={
        {
          '--bg': terminalTheme.background,
          '--fg': terminalTheme.foreground,
          '--sidebar-width': `${resolvedSidebarWidth}px`,
          '--ui-font-family': 'MiSans, sans-serif',
          '--ui-font-size': `${settings.theme.uiFontSize || 13}px`,
        } as CSSProperties
      }
    >
      <main className={`body-layout ${settings.ui.sidebarVisible ? '' : 'sidebar-hidden'}`}>
        <SidebarShell
          sidebarTab={sidebarTab}
          sidebarVisible={settings.ui.sidebarVisible}
          setSidebarTab={setSidebarTab}
          folders={folders}
          sessions={sessions}
          expandedFolderIds={expandedFolderIds}
          setExpandedFolderIds={setExpandedFolderIds}
          connectSession={connectSession}
          sessionTreeActions={sessionTreeActions}
          activeSessionId={activeSessionId}
          activeSession={activeSession}
          settingsShowHiddenFiles={settings.ui.showHiddenFiles}
          sftpPath={sftpPath}
          sftpPathInput={sftpPathInput}
          sftpItems={sftpItems}
          selectedSftpPaths={selectedSftpPaths}
          dropOver={sftpUploadDropOver}
          transferRows={currentTransferRows}
          formatSftpMeta={formatSftpMeta}
          sftpInteractions={sftpInteractions}
          onCancelTransfer={(row) => void cancelTransferRow(row)}
          currentMetrics={currentMetrics}
          onOpenSettings={settingsActions.openSettingsModal}
          onToggleSidebar={settingsActions.toggleSidebarVisible}
        />
        <AppHeader
          tabs={tabs}
          activeSessionId={activeSessionId}
          connectionStates={connectionStates}
          isMaximized={isMaximized}
          onSelectTab={setActiveSessionId}
          onCloseTab={windowActions.onCloseTab}
          onMinimize={windowActions.onMinimize}
          onToggleMaximize={windowActions.onToggleMaximize}
          onCloseWindow={windowActions.onCloseWindow}
        />
        {settings.ui.sidebarVisible && (
          <div
            className="sidebar-resizer"
            title="拖动调整侧边栏宽度"
            onMouseDown={startSidebarResize}
          />
        )}

        <TerminalZone
          activeSessionId={activeSessionId}
          pausedOutput={pausedOutput}
          settings={settings}
          showAlert={showAlert}
          terminalContainerRef={terminalContainerRef}
          terminalMapRef={terminalMapRef}
          syncPauseStateWithViewport={syncPauseStateWithViewport}
          askConfirm={askConfirm}
        />
      </main>

      <ModalHost
        showSessionModal={showSessionModal}
        editingSession={editingSession}
        sessionForm={sessionForm}
        showSessionPassword={showSessionPassword}
        sessionFolderMenuOpen={sessionFolderMenuOpen}
        folderTreeData={folderTreeData}
        setSessionForm={setSessionForm}
        showFolderModal={showFolderModal}
        folderName={folderName}
        folderParent={folderParent}
        folderParentMenuOpen={folderParentMenuOpen}
        setFolderName={setFolderName}
        showSettings={showSettings}
        settingsDraft={settingsDraft}
        settingsTab={settingsTab}
        cursorStyleMenuOpen={cursorStyleMenuOpen}
        cursorStyleMenuRef={cursorStyleMenuRef}
        runtimeInfo={runtimeInfo}
        setSettingsTab={setSettingsTab}
        setCursorStyleMenuOpen={setCursorStyleMenuOpen}
        setSettingsDraft={setSettingsDraft}
        treeMenu={treeMenu}
        dialog={dialog}
        dialogInput={dialogInput}
        showDialogPassword={showDialogPassword}
        capsLockOn={capsLockOn}
        dialogRemember={dialogRemember}
        setDialogInput={setDialogInput}
        setShowDialogPassword={setShowDialogPassword}
        setCapsLockOn={setCapsLockOn}
        setDialogRemember={setDialogRemember}
        closeDialog={closeDialog}
        sessionTreeActions={sessionTreeActions}
        settingsActions={settingsActions}
        sftpInteractions={sftpInteractions}
      />
      </AntApp>
    </ConfigProvider>
  );
}
