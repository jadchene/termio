import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import type { Session, TreeContextMenu } from '../types';

type SessionForm = Omit<Session, 'id'>;

function buildCopiedSessionName(baseName: string, existingNames: Set<string>): string {
  const seed = `${baseName} - 副本`;
  if (!existingNames.has(seed)) return seed;
  let index = 2;
  while (index < 1000) {
    const next = `${seed} ${index}`;
    if (!existingNames.has(next)) return next;
    index += 1;
  }
  return `${seed} ${Date.now()}`;
}

type UseSessionTreeActionsParams = {
  sessions: Session[];
  editingSession: Session | null;
  sessionForm: SessionForm;
  folderName: string;
  folderParent: number | null;
  defaultSessionForm: SessionForm;
  setShowSessionModal: Dispatch<SetStateAction<boolean>>;
  setEditingSession: Dispatch<SetStateAction<Session | null>>;
  setSessionForm: Dispatch<SetStateAction<SessionForm>>;
  setShowSessionPassword: Dispatch<SetStateAction<boolean>>;
  setSessionFolderMenuOpen: Dispatch<SetStateAction<boolean>>;
  setShowFolderModal: Dispatch<SetStateAction<boolean>>;
  setFolderName: Dispatch<SetStateAction<string>>;
  setFolderParent: Dispatch<SetStateAction<number | null>>;
  setFolderParentMenuOpen: Dispatch<SetStateAction<boolean>>;
  setTreeMenu: Dispatch<SetStateAction<TreeContextMenu | null>>;
  loadSessionData: () => Promise<void>;
  askConfirm: (message: string, title?: string) => Promise<boolean>;
  askPrompt: (message: string, initialValue?: string, title?: string) => Promise<string | null>;
  showAlert: (message: string, title?: string) => Promise<void>;
};

export function useSessionTreeActions(params: UseSessionTreeActionsParams) {
  const {
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
  } = params;

  const runMutation = async (action: () => Promise<void>, title: string): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), title);
      return false;
    }
  };

  const openSessionModal = (target?: Session, preferredFolderId?: number | null) => {
    if (target) {
      setEditingSession(target);
      setSessionForm({
        folder_id: target.folder_id,
        name: target.name,
        host: target.host,
        port: target.port,
        username: target.username,
        auth_type: target.auth_type,
        password: '',
        remember_password: target.remember_password,
        private_key_path: target.private_key_path,
        passphrase: '',
        remember_passphrase: target.remember_passphrase,
        default_session: target.default_session,
      });
    } else {
      setEditingSession(null);
      setSessionForm({ ...defaultSessionForm, folder_id: preferredFolderId ?? null });
    }
    setShowSessionPassword(false);
    setSessionFolderMenuOpen(false);
    setShowSessionModal(true);
  };

  const openFolderModal = (parentId?: number | null) => {
    setFolderName('');
    setFolderParent(parentId ?? null);
    setFolderParentMenuOpen(false);
    setShowFolderModal(true);
  };

  const onOpenSessionMenu = (e: ReactMouseEvent, session: Session) => {
    e.preventDefault();
    e.stopPropagation();
    setTreeMenu({ x: e.clientX, y: e.clientY, type: 'session', id: session.id, name: session.name });
  };

  const onOpenFolderMenu = (e: ReactMouseEvent, folder: { id: number; name: string }) => {
    e.preventDefault();
    e.stopPropagation();
    setTreeMenu({ x: e.clientX, y: e.clientY, type: 'folder', id: folder.id, name: folder.name });
  };

  const onPickSessionFolder = (folderId: number | null) => {
    setSessionForm({ ...sessionForm, folder_id: folderId });
    setSessionFolderMenuOpen(false);
  };

  const onConfirmSessionModal = async () => {
    if (!sessionForm.name || !sessionForm.host || !sessionForm.username ||
      (sessionForm.auth_type === 'private_key' && !sessionForm.private_key_path.trim())) {
      await showAlert('请填写完整信息');
      return;
    }
    const saved = await runMutation(async () => {
      if (editingSession) await window.terminalApi.updateSession({ id: editingSession.id, ...sessionForm });
      else await window.terminalApi.createSession(sessionForm);
      await loadSessionData();
    }, '保存会话失败');
    if (!saved) return;
    setSessionFolderMenuOpen(false);
    setShowSessionModal(false);
  };

  const onConfirmFolderModal = async () => {
    if (!folderName.trim()) {
      await showAlert('请输入目录名');
      return;
    }
    const saved = await runMutation(async () => {
      await window.terminalApi.createFolder({ name: folderName.trim(), parentId: folderParent });
      await loadSessionData();
    }, '创建目录失败');
    if (!saved) return;
    setFolderName('');
    setFolderParent(null);
    setFolderParentMenuOpen(false);
    setShowFolderModal(false);
  };

  const onCopySessionMenu = async (menu: Extract<TreeContextMenu, { type: 'session' }>) => {
    const target = sessions.find((s) => s.id === menu.id);
    if (!target) {
      setTreeMenu(null);
      return;
    }
    const existingNames = new Set(sessions.map((item) => item.name));
    const copiedName = buildCopiedSessionName(target.name, existingNames);
    await runMutation(async () => {
      await window.terminalApi.createSession({
        folder_id: target.folder_id,
        name: copiedName,
        host: target.host,
        port: target.port,
        username: target.username,
        auth_type: target.auth_type,
        password: '',
        remember_password: 0,
        private_key_path: target.private_key_path,
        passphrase: '',
        remember_passphrase: 0,
        default_session: 0,
      });
      await loadSessionData();
    }, '复制会话失败');
    setTreeMenu(null);
  };

  const onEditSessionMenu = (menu: Extract<TreeContextMenu, { type: 'session' }>) => {
    const target = sessions.find((s) => s.id === menu.id);
    if (target) openSessionModal(target);
    setTreeMenu(null);
  };

  const onDeleteSessionMenu = async (menu: Extract<TreeContextMenu, { type: 'session' }>) => {
    if (!(await askConfirm(`确定删除会话 ${menu.name} 吗？`))) return;
    await runMutation(async () => {
      await window.terminalApi.deleteSession(menu.id);
      await loadSessionData();
    }, '删除会话失败');
    setTreeMenu(null);
  };

  const onCreateSessionInFolderMenu = (menu: Extract<TreeContextMenu, { type: 'folder' }>) => {
    openSessionModal(undefined, menu.id);
    setTreeMenu(null);
  };

  const onCreateFolderInFolderMenu = (menu: Extract<TreeContextMenu, { type: 'folder' }>) => {
    openFolderModal(menu.id);
    setTreeMenu(null);
  };

  const onEditFolderMenu = async (menu: Extract<TreeContextMenu, { type: 'folder' }>) => {
    const name = await askPrompt('目录名称', menu.name);
    if (!name || !name.trim() || name.trim() === menu.name) {
      setTreeMenu(null);
      return;
    }
    await runMutation(async () => {
      await window.terminalApi.updateFolder({ id: menu.id, name: name.trim() });
      await loadSessionData();
    }, '重命名目录失败');
    setTreeMenu(null);
  };

  const onDeleteFolderMenu = async (menu: Extract<TreeContextMenu, { type: 'folder' }>) => {
    if (!(await askConfirm(`确定删除目录 ${menu.name} 吗？`))) return;
    try {
      await window.terminalApi.deleteFolder(menu.id);
      await loadSessionData();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), '删除失败');
    } finally {
      setTreeMenu(null);
    }
  };

  return {
    openSessionModal,
    openFolderModal,
    onOpenSessionMenu,
    onOpenFolderMenu,
    onCreateSession: () => openSessionModal(),
    onCreateFolder: () => openFolderModal(null),
    onToggleSessionPassword: () => setShowSessionPassword((v) => !v),
    onToggleSessionFolderMenu: () => setSessionFolderMenuOpen((v) => !v),
    onPickSessionFolder,
    onCancelSessionModal: () => {
      setSessionFolderMenuOpen(false);
      setShowSessionModal(false);
    },
    onConfirmSessionModal,
    onToggleFolderParentMenu: () => setFolderParentMenuOpen((v) => !v),
    onPickFolderParent: (folderId: number | null) => {
      setFolderParent(folderId);
      setFolderParentMenuOpen(false);
    },
    onCancelFolderModal: () => {
      setFolderParentMenuOpen(false);
      setShowFolderModal(false);
    },
    onConfirmFolderModal,
    onCopySessionMenu,
    onEditSessionMenu,
    onDeleteSessionMenu,
    onCreateSessionInFolderMenu,
    onCreateFolderInFolderMenu,
    onEditFolderMenu,
    onDeleteFolderMenu,
  };
}
