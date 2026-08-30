import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { formatSftpError, isSilentSftpError } from '../utils/sftpError';
import { isLatestSessionRequest } from '../utils/requestSequence';
import {
  createSessionSftpState,
  updateSessionSftpState,
  type SessionSftpState,
} from '../utils/sessionSftpState';

type UseSftpPanelParams = {
  activeSessionId: number | null;
  showHiddenFiles: boolean;
  showAlert: (message: string, title?: string) => Promise<void>;
};

export function useSftpPanel(params: UseSftpPanelParams) {
  const { activeSessionId, showHiddenFiles, showAlert } = params;
  const [sessionStateById, setSessionStateById] = useState<Map<number, SessionSftpState>>(() => new Map());
  const [sftpUploadDropOver, setSftpUploadDropOver] = useState(false);
  const sessionStateByIdRef = useRef(sessionStateById);
  const activeSessionIdRef = useRef<number | null>(activeSessionId);
  const showHiddenFilesRef = useRef(showHiddenFiles);
  const sftpSelectionAnchorRef = useRef<Map<number, string | null>>(new Map());
  const listRequestSequenceRef = useRef<Map<number, number>>(new Map());
  const activeState = activeSessionId == null
    ? createSessionSftpState()
    : sessionStateById.get(activeSessionId) ?? createSessionSftpState();
  const {
    path: sftpPath,
    pathInput: sftpPathInput,
    items: sftpItems,
    selectedPaths: selectedSftpPaths,
    loading: sftpLoading,
  } = activeState;

  const updateSessionState = useCallback((
    sessionId: number,
    updater: (current: SessionSftpState) => SessionSftpState,
  ) => {
    const next = updateSessionSftpState(sessionStateByIdRef.current, sessionId, updater);
    sessionStateByIdRef.current = next;
    setSessionStateById(next);
  }, []);

  const setSftpPath = useCallback<Dispatch<SetStateAction<string>>>((nextValue) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    updateSessionState(sessionId, (current) => ({
      ...current,
      path: typeof nextValue === 'function' ? nextValue(current.path) : nextValue,
    }));
  }, [updateSessionState]);

  const setSftpPathInput = useCallback<Dispatch<SetStateAction<string>>>((nextValue) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    updateSessionState(sessionId, (current) => ({
      ...current,
      pathInput: typeof nextValue === 'function' ? nextValue(current.pathInput) : nextValue,
    }));
  }, [updateSessionState]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    showHiddenFilesRef.current = showHiddenFiles;
  }, [showHiddenFiles]);

  const refreshSftp = useCallback(async (pathInput?: string): Promise<boolean> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return false;
    const requestSequence = (listRequestSequenceRef.current.get(sessionId) ?? 0) + 1;
    listRequestSequenceRef.current.set(sessionId, requestSequence);
    const target = pathInput ?? sessionStateByIdRef.current.get(sessionId)?.path ?? '~';
    updateSessionState(sessionId, (current) => ({ ...current, loading: true }));
    let response;
    try {
      response = await window.terminalApi.sftpList({
        sessionId,
        requestSequence,
        path: target,
        showHidden: showHiddenFilesRef.current,
      });
    } catch (error) {
      if (listRequestSequenceRef.current.get(sessionId) === requestSequence) {
        updateSessionState(sessionId, (current) => ({ ...current, loading: false }));
      }
      throw error;
    }
    if (!isLatestSessionRequest(
      activeSessionIdRef.current,
      response.sessionId,
      listRequestSequenceRef.current.get(sessionId) ?? 0,
      response.requestSequence,
    )) {
      if (listRequestSequenceRef.current.get(sessionId) === requestSequence) {
        updateSessionState(sessionId, (current) => ({ ...current, loading: false }));
      }
      return false;
    }
    const list = response.items;
    updateSessionState(sessionId, (current) => ({
      ...current,
      loading: false,
      items: list,
      selectedPaths: current.selectedPaths.filter((it) => (
        list.some((item) => `${target.replace(/\/$/, '')}/${item.name}` === it)
      )),
    }));
    return true;
  }, [updateSessionState]);

  const getVisibleSftpPaths = useCallback(() => {
    const basePath = sftpPath.replace(/\/$/, '');
    return sftpItems.map((item) => `${basePath}/${item.name}`);
  }, [sftpItems, sftpPath]);

  const setSftpSelection = useCallback((fullPath: string, checked: boolean, range = false) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    const anchorPath = sftpSelectionAnchorRef.current.get(sessionId) ?? null;
    const visiblePaths = getVisibleSftpPaths();
    if (range && anchorPath) {
      const anchorIndex = visiblePaths.indexOf(anchorPath);
      const targetIndex = visiblePaths.indexOf(fullPath);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const rangePaths = visiblePaths.slice(start, end + 1);
        updateSessionState(sessionId, (current) => ({
          ...current,
          selectedPaths: checked
            ? Array.from(new Set([...current.selectedPaths, ...rangePaths]))
            : current.selectedPaths.filter((it) => !rangePaths.includes(it)),
        }));
        return;
      }
    }
    sftpSelectionAnchorRef.current.set(sessionId, fullPath);
    updateSessionState(sessionId, (current) => ({
      ...current,
      selectedPaths: checked
        ? current.selectedPaths.includes(fullPath)
          ? current.selectedPaths
          : [...current.selectedPaths, fullPath]
        : current.selectedPaths.filter((it) => it !== fullPath),
    }));
  }, [getVisibleSftpPaths, updateSessionState]);

  const navigateSftp = useCallback(async (nextPath: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return false;
    const accepted = await refreshSftp(nextPath);
    if (!accepted || activeSessionIdRef.current !== sessionId) return false;
    updateSessionState(sessionId, (current) => ({ ...current, path: nextPath }));
    return true;
  }, [refreshSftp, updateSessionState]);

  const getCurrentSftpLocation = useCallback(() => ({
    sessionId: activeSessionIdRef.current,
    path: activeSessionIdRef.current == null
      ? '~'
      : sessionStateByIdRef.current.get(activeSessionIdRef.current)?.path ?? '~',
  }), []);

  const clearSftpSelectionNow = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    flushSync(() => {
      sftpSelectionAnchorRef.current.set(sessionId, null);
      updateSessionState(sessionId, (current) => ({ ...current, selectedPaths: [] }));
    });
  }, [updateSessionState]);

  const clearSftpSelection = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    sftpSelectionAnchorRef.current.set(sessionId, null);
    updateSessionState(sessionId, (current) => ({ ...current, selectedPaths: [] }));
  }, [updateSessionState]);

  const clearSftpItems = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    updateSessionState(sessionId, (current) => ({ ...current, items: [] }));
  }, [updateSessionState]);

  const submitSftpPath = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    const current = sessionStateByIdRef.current.get(sessionId) ?? createSessionSftpState();
    const nextPath = current.pathInput.trim();
    if (!nextPath) {
      setSftpPathInput(current.path);
      return;
    }
    try {
      await navigateSftp(nextPath);
    } catch (error) {
      setSftpPathInput(sessionStateByIdRef.current.get(sessionId)?.path ?? '~');
      if (!isSilentSftpError(error)) await showAlert(formatSftpError(error), 'SFTP');
    }
  }, [navigateSftp, showAlert]);

  const hasSftpSessionState = useCallback((sessionId: number) => (
    sessionStateByIdRef.current.has(sessionId)
  ), []);

  const clearSftpSessionState = useCallback((sessionId: number) => {
    const next = new Map(sessionStateByIdRef.current);
    next.delete(sessionId);
    sessionStateByIdRef.current = next;
    listRequestSequenceRef.current.delete(sessionId);
    sftpSelectionAnchorRef.current.delete(sessionId);
    setSessionStateById(next);
  }, []);

  return {
    sftpPath,
    setSftpPath,
    sftpPathInput,
    setSftpPathInput,
    sftpItems,
    selectedSftpPaths,
    sftpLoading,
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
  };
}
