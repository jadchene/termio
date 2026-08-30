import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Session, Settings, SftpItem, TreeContextMenu } from '../types';
import { getParentSftpPath } from '../utils/sftpPath';
import { formatSftpError, isSilentSftpError } from '../utils/sftpError';
import { shouldApplyCwdCalibration } from '../utils/sftpCwd';
import { resolveSftpContextTargets } from '../utils/sftpSelection';

type SftpMenuPayload = Extract<TreeContextMenu, { type: 'sftp' }>;

type UseSftpInteractionsParams = {
  activeSessionId: number | null;
  activeSession: Session | null;
  settings: Settings | null;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  sftpPath: string;
  sftpItems: SftpItem[];
  selectedSftpPaths: string[];
  setSftpPathInput: Dispatch<SetStateAction<string>>;
  setSftpUploadDropOver: Dispatch<SetStateAction<boolean>>;
  setTreeMenu: Dispatch<SetStateAction<TreeContextMenu | null>>;
  sftpInternalDragRef: MutableRefObject<string | null>;
  refreshSftp: (targetPath?: string) => Promise<boolean>;
  navigateSftp: (nextPath: string) => Promise<boolean>;
  getCurrentSftpLocation: () => { sessionId: number | null; path: string };
  clearSftpSelectionNow: () => void;
  submitSftpPath: () => Promise<void>;
  setSftpSelection: (fullPath: string, checked: boolean, range?: boolean) => void;
  showAlert: (message: string, title?: string) => Promise<void>;
  askPrompt: (message: string, initialValue?: string, title?: string) => Promise<string | null>;
  askConfirm: (message: string, title?: string) => Promise<boolean>;
};

export function useSftpInteractions(params: UseSftpInteractionsParams) {
  const {
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
  } = params;

  const runSftpAction = async (action: () => Promise<unknown>, title = 'SFTP') => {
    try {
      return await action();
    } catch (error) {
      if (!isSilentSftpError(error)) await showAlert(formatSftpError(error), title);
      return undefined;
    }
  };

  useEffect(() => window.terminalApi.onSftpNativeDragEnded((event) => {
    if (sftpInternalDragRef.current === event.token) {
      sftpInternalDragRef.current = null;
    }
    if (event.error) void showAlert(event.error, 'SFTP 拖拽');
  }), [sftpInternalDragRef, showAlert]);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!activeSessionId) return;
    e.preventDefault();
    if (sftpInternalDragRef.current) {
      e.dataTransfer.dropEffect = 'none';
      setSftpUploadDropOver(false);
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    setSftpUploadDropOver(true);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!activeSessionId) return;
    e.preventDefault();
    if (sftpInternalDragRef.current) {
      e.dataTransfer.dropEffect = 'none';
      setSftpUploadDropOver(false);
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    setSftpUploadDropOver(true);
  };

  const onDragLeave = () => {
    setSftpUploadDropOver(false);
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setSftpUploadDropOver(false);
    if (!activeSessionId) return;
    const nativeDragToken = sftpInternalDragRef.current;
    if (nativeDragToken) {
      await runSftpAction(async () => {
        const cancelled = await window.terminalApi.sftpCancelNativeDrag(nativeDragToken);
        if (cancelled && sftpInternalDragRef.current === nativeDragToken) {
          sftpInternalDragRef.current = null;
        }
      }, 'SFTP 拖拽');
      return;
    }
    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (droppedFiles.length === 0) {
      await showAlert('未识别到可用的拖拽路径，请重试或使用上传按钮。', 'SFTP');
      return;
    }
    const previewNames = droppedFiles.slice(0, 5).map((file) => file.name).join('、');
    const remaining = droppedFiles.length > 5 ? ` 等 ${droppedFiles.length} 项` : '';
    if (!await askConfirm(`确认上传本地文件：${previewNames}${remaining}？`, 'SFTP 上传')) return;
    clearSftpSelectionNow();
    await runSftpAction(async () => {
      const uploadCapability = await window.terminalApi.sftpAuthorizeDroppedFiles(droppedFiles);
      await window.terminalApi.sftpUploadBatch({ sessionId: activeSessionId, remoteDir: sftpPath, uploadCapability });
      await refreshSftp();
    });
  };

  const onToggleShowHidden = async () => {
    if (!settings) return;
    try {
      const saved = await window.terminalApi.updateSettings({
        ui: { ...settings.ui, showHiddenFiles: !settings.ui.showHiddenFiles },
      });
      setSettings(saved);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), '保存设置失败');
    }
  };

  const onRefresh = async () => {
    clearSftpSelectionNow();
    await runSftpAction(() => refreshSftp());
  };
  const onGoParent = async () => {
    await runSftpAction(() => navigateSftp(getParentSftpPath(sftpPath)));
  };

  const onFollowCwd = async () => {
    if (!activeSessionId) return;
    const requestedSessionId = activeSessionId;
    let initialPath = '';
    try {
      const cached = await window.terminalApi.sshGetCachedCwd(requestedSessionId);
      if (getCurrentSftpLocation().sessionId !== requestedSessionId) return;
      if (cached.trim() && await navigateSftp(cached.trim())) {
        initialPath = cached.trim();
      }
      if (!initialPath) {
        const home = await window.terminalApi.sftpGetHome(requestedSessionId);
        if (getCurrentSftpLocation().sessionId !== requestedSessionId) return;
        const target = home?.trim() || '~';
        if (await navigateSftp(target)) initialPath = target;
      }
    } catch (error) {
      try {
        const home = await window.terminalApi.sftpGetHome(requestedSessionId);
        if (getCurrentSftpLocation().sessionId !== requestedSessionId) return;
        const target = home?.trim() || '~';
        if (await navigateSftp(target)) initialPath = target;
      } catch (fallbackError) {
        if (!isSilentSftpError(fallbackError)) await showAlert(formatSftpError(fallbackError), 'SFTP');
      }
    }
    if (!initialPath) return;
    void window.terminalApi.sshGetCwd(requestedSessionId).then(async (livePath) => {
      if (!shouldApplyCwdCalibration(
        requestedSessionId,
        initialPath,
        getCurrentSftpLocation(),
        livePath,
      )) return;
      await navigateSftp(livePath.trim());
    }).catch(() => undefined);
  };

  const onCreateDir = async () => {
    if (!activeSession || !activeSessionId) return;
    const name = await askPrompt('目录名');
    if (!name) return;
    await runSftpAction(async () => {
      await window.terminalApi.sftpMkdir({
        sessionId: activeSessionId,
        path: `${sftpPath.replace(/\/$/, '')}/${name}`,
      });
      await refreshSftp();
    });
  };

  const onBatchUpload = async () => {
    if (!activeSession || !activeSessionId) return;
    clearSftpSelectionNow();
    await runSftpAction(async () => {
      await window.terminalApi.sftpUploadBatch({ sessionId: activeSessionId, remoteDir: sftpPath });
      await refreshSftp();
    });
  };

  const onBatchDownload = async () => {
    if (!activeSession || !activeSessionId) return;
    const selectedPaths = selectedSftpPaths.filter((pathItem) => !!pathItem);
    if (selectedPaths.length === 0) {
      await showAlert('请选择文件或目录后再批量下载');
      return;
    }
    clearSftpSelectionNow();
    await runSftpAction(() => window.terminalApi.sftpDownloadBatch({ sessionId: activeSessionId, remotePaths: selectedPaths }));
  };

  const onPathBlur = () => setSftpPathInput(sftpPath);

  const onStartItemDrag = (e: React.DragEvent<HTMLDivElement>, fullPath: string, draggedItem: SftpItem) => {
    if (!activeSessionId) {
      e.preventDefault();
      return;
    }
    const previousToken = sftpInternalDragRef.current;
    if (previousToken) void window.terminalApi.sftpCancelNativeDrag(previousToken).catch(() => false);
    const picked = selectedSftpPaths.includes(fullPath) && selectedSftpPaths.length > 0 ? selectedSftpPaths : [fullPath];
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    sftpInternalDragRef.current = token;
    e.preventDefault();
    const itemByPath = new Map(
      sftpItems.map((item) => [`${sftpPath.replace(/\/$/, '')}/${item.name}`, item]),
    );
    itemByPath.set(fullPath, draggedItem);
    window.terminalApi.sftpStartNativeDrag({
      sessionId: activeSessionId,
      token,
      items: picked.map((remotePath) => {
        const item = itemByPath.get(remotePath);
        return {
          remotePath,
          name: item?.name || remotePath.replace(/\/+$/, '').split('/').pop() || 'download',
          isDirectory: item?.type === 'd',
          size: Math.max(0, Number(item?.size || 0)),
        };
      }),
    });
  };

  const onEndItemDrag = () => undefined;

  const onOpenItemMenu = (e: React.MouseEvent, payload: { path: string; name: string; isDir: boolean }) => {
    if (!activeSession || !activeSessionId) return;
    e.preventDefault();
    e.stopPropagation();
    const downloadPaths = resolveSftpContextTargets(payload.path, selectedSftpPaths);
    if (!selectedSftpPaths.includes(payload.path)) {
      clearSftpSelectionNow();
      setSftpSelection(payload.path, true);
    }
    setTreeMenu({
      x: e.clientX,
      y: e.clientY,
      type: 'sftp',
      sessionId: activeSessionId,
      path: payload.path,
      name: payload.name,
      isDir: payload.isDir,
      downloadPaths,
    });
  };

  const onDownloadSftpMenu = async (menu: SftpMenuPayload) => {
    setTreeMenu(null);
    clearSftpSelectionNow();
    await runSftpAction(async () => {
      await window.terminalApi.sftpDownloadBatch({ sessionId: menu.sessionId, remotePaths: menu.downloadPaths });
    });
  };

  const onRenameSftpMenu = async (menu: SftpMenuPayload) => {
    const newName = await askPrompt('新名称', menu.name);
    if (!newName || newName === menu.name) {
      setTreeMenu(null);
      return;
    }
    const parentDir = menu.path.replace(/\/[^/]+$/, '') || '/';
    const nextPath = `${parentDir.replace(/\/$/, '')}/${newName}`;
    await runSftpAction(async () => {
      await window.terminalApi.sftpRename({ sessionId: menu.sessionId, from: menu.path, to: nextPath });
      await refreshSftp();
      setTreeMenu(null);
    });
  };

  const onDeleteSftpMenu = async (menu: SftpMenuPayload) => {
    if (!(await askConfirm(`确定删除 ${menu.name} 吗？`))) return;
    await runSftpAction(async () => {
      await window.terminalApi.sftpDelete({ sessionId: menu.sessionId, path: menu.path, isDir: menu.isDir });
      await refreshSftp();
      setTreeMenu(null);
    });
  };

  return {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onToggleShowHidden,
    onRefresh,
    onGoParent,
    onFollowCwd,
    onCreateDir,
    onBatchUpload,
    onBatchDownload,
    onPathInputChange: setSftpPathInput,
    onPathSubmit: submitSftpPath,
    onPathBlur,
    onStartItemDrag,
    onEndItemDrag,
    onOpenItemMenu,
    onToggleItemSelect: setSftpSelection,
    onOpenDir: async (nextPath: string) => {
      await navigateSftp(nextPath);
    },
    onDownloadSftpMenu,
    onRenameSftpMenu,
    onDeleteSftpMenu,
  };
}
