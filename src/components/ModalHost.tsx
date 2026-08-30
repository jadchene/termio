import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Session, Settings, TreeContextMenu } from '../types';
import type { DialogState } from '../hooks/useDialog';
import type { FolderTreeOption } from '../hooks/useFolderTreeOptions';
import { SessionModal } from './SessionModal';
import { FolderModal } from './FolderModal';
import { SettingsModal } from './SettingsModal';
import { TreeContextMenu as TreeContextMenuComponent } from './TreeContextMenu';
import { DialogModal } from './DialogModal';

type SessionForm = Omit<Session, 'id'>;
type RuntimeInfo = {
  runtimeDir: string;
  userDataPath: string;
  settingsStorage: string;
  dbPath: string;
  os: string;
};

type ModalHostProps = {
  showSessionModal: boolean;
  editingSession: Session | null;
  sessionForm: SessionForm;
  showSessionPassword: boolean;
  sessionFolderMenuOpen: boolean;
  folderTreeData: FolderTreeOption[];
  setSessionForm: Dispatch<SetStateAction<SessionForm>>;

  showFolderModal: boolean;
  folderName: string;
  folderParent: number | null;
  folderParentMenuOpen: boolean;
  setFolderName: Dispatch<SetStateAction<string>>;

  showSettings: boolean;
  settingsDraft: Settings | null;
  settingsTab: 'appearance' | 'behavior' | 'system';
  cursorStyleMenuOpen: boolean;
  cursorStyleMenuRef: MutableRefObject<HTMLDivElement | null>;
  runtimeInfo: RuntimeInfo | null;
  setSettingsTab: Dispatch<SetStateAction<'appearance' | 'behavior' | 'system'>>;
  setCursorStyleMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsDraft: Dispatch<SetStateAction<Settings | null>>;

  treeMenu: TreeContextMenu | null;

  dialog: DialogState | null;
  dialogInput: string;
  showDialogPassword: boolean;
  capsLockOn: boolean;
  dialogRemember: boolean;
  setDialogInput: Dispatch<SetStateAction<string>>;
  setShowDialogPassword: Dispatch<SetStateAction<boolean>>;
  setCapsLockOn: Dispatch<SetStateAction<boolean>>;
  setDialogRemember: Dispatch<SetStateAction<boolean>>;
  closeDialog: (value: boolean | string | { value: string; remember: boolean } | null | void) => void;

  sessionTreeActions: {
    onToggleSessionPassword: () => void;
    onToggleSessionFolderMenu: () => void;
    onPickSessionFolder: (folderId: number | null) => void;
    onPickPrivateKey: (defaultPath: string) => Promise<string>;
    onCancelSessionModal: () => void;
    onConfirmSessionModal: () => Promise<boolean>;
    onToggleFolderParentMenu: () => void;
    onPickFolderParent: (folderId: number | null) => void;
    onCancelFolderModal: () => void;
    onConfirmFolderModal: () => Promise<boolean>;
    onCopySessionMenu: (menu: Extract<TreeContextMenu, { type: 'session' }>) => Promise<void>;
    onOpenNewSessionMenu: (menu: Extract<TreeContextMenu, { type: 'session' }>) => Promise<void>;
    onEditSessionMenu: (menu: Extract<TreeContextMenu, { type: 'session' }>) => void;
    onDeleteSessionMenu: (menu: Extract<TreeContextMenu, { type: 'session' }>) => Promise<void>;
    onCreateSessionInFolderMenu: (menu: Extract<TreeContextMenu, { type: 'folder' }>) => void;
    onCreateFolderInFolderMenu: (menu: Extract<TreeContextMenu, { type: 'folder' }>) => void;
    onEditFolderMenu: (menu: Extract<TreeContextMenu, { type: 'folder' }>) => Promise<void>;
    onDeleteFolderMenu: (menu: Extract<TreeContextMenu, { type: 'folder' }>) => Promise<void>;
  };
  settingsActions: {
    pickDefaultDownloadDir: () => Promise<void>;
    cancelSettingsModal: () => void;
    saveSettingsModal: () => Promise<boolean>;
  };
  sftpInteractions: {
    onDownloadSftpMenu: (menu: Extract<TreeContextMenu, { type: 'sftp' }>) => Promise<void>;
    onRenameSftpMenu: (menu: Extract<TreeContextMenu, { type: 'sftp' }>) => Promise<void>;
    onDeleteSftpMenu: (menu: Extract<TreeContextMenu, { type: 'sftp' }>) => Promise<void>;
  };
};

export function ModalHost(props: ModalHostProps) {
  const {
    showSessionModal,
    editingSession,
    sessionForm,
    showSessionPassword,
    sessionFolderMenuOpen,
    folderTreeData,
    setSessionForm,
    showFolderModal,
    folderName,
    folderParent,
    folderParentMenuOpen,
    setFolderName,
    showSettings,
    settingsDraft,
    settingsTab,
    cursorStyleMenuOpen,
    cursorStyleMenuRef,
    runtimeInfo,
    setSettingsTab,
    setCursorStyleMenuOpen,
    setSettingsDraft,
    treeMenu,
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
    sessionTreeActions,
    settingsActions,
    sftpInteractions,
  } = props;

  return (
    <>
      <SessionModal
        show={showSessionModal}
        editing={!!editingSession}
        form={sessionForm}
        showPassword={showSessionPassword}
        folderMenuOpen={sessionFolderMenuOpen}
        folderTreeData={folderTreeData}
        onChangeForm={setSessionForm}
        onTogglePassword={sessionTreeActions.onToggleSessionPassword}
        onToggleFolderMenu={sessionTreeActions.onToggleSessionFolderMenu}
        onPickFolder={sessionTreeActions.onPickSessionFolder}
        onPickPrivateKey={sessionTreeActions.onPickPrivateKey}
        onCancel={sessionTreeActions.onCancelSessionModal}
        onConfirm={sessionTreeActions.onConfirmSessionModal}
      />

      <FolderModal
        show={showFolderModal}
        folderName={folderName}
        folderParent={folderParent}
        folderParentMenuOpen={folderParentMenuOpen}
        folderTreeData={folderTreeData}
        onChangeName={setFolderName}
        onToggleParentMenu={sessionTreeActions.onToggleFolderParentMenu}
        onPickParent={sessionTreeActions.onPickFolderParent}
        onCancel={sessionTreeActions.onCancelFolderModal}
        onConfirm={sessionTreeActions.onConfirmFolderModal}
      />

      <SettingsModal
        show={showSettings}
        draft={settingsDraft}
        tab={settingsTab}
        cursorStyleMenuOpen={cursorStyleMenuOpen}
        cursorStyleMenuRef={cursorStyleMenuRef}
        runtimeInfo={runtimeInfo}
        onSwitchTab={setSettingsTab}
        onToggleCursorMenu={() => setCursorStyleMenuOpen((v) => !v)}
        onCloseCursorMenu={() => setCursorStyleMenuOpen(false)}
        onUpdateDraft={(next) => setSettingsDraft(next)}
        onPickDefaultDownloadDir={settingsActions.pickDefaultDownloadDir}
        onCancel={settingsActions.cancelSettingsModal}
        onSave={settingsActions.saveSettingsModal}
      />

      <TreeContextMenuComponent
        menu={treeMenu}
        onOpenNewSession={sessionTreeActions.onOpenNewSessionMenu}
        onCopySession={sessionTreeActions.onCopySessionMenu}
        onEditSession={sessionTreeActions.onEditSessionMenu}
        onDeleteSession={sessionTreeActions.onDeleteSessionMenu}
        onCreateSessionInFolder={sessionTreeActions.onCreateSessionInFolderMenu}
        onCreateFolderInFolder={sessionTreeActions.onCreateFolderInFolderMenu}
        onEditFolder={sessionTreeActions.onEditFolderMenu}
        onDeleteFolder={sessionTreeActions.onDeleteFolderMenu}
        onDownloadSftp={sftpInteractions.onDownloadSftpMenu}
        onRenameSftp={sftpInteractions.onRenameSftpMenu}
        onDeleteSftp={sftpInteractions.onDeleteSftpMenu}
      />

      <DialogModal
        dialog={dialog}
        dialogInput={dialogInput}
        showDialogPassword={showDialogPassword}
        capsLockOn={capsLockOn}
        dialogRemember={dialogRemember}
        onChangeInput={setDialogInput}
        onSetShowDialogPassword={setShowDialogPassword}
        onSetCapsLockOn={setCapsLockOn}
        onSetDialogRemember={setDialogRemember}
        onClose={closeDialog}
      />
    </>
  );
}
