import {
  CloudServerOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  SlidersOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';
import type { DragEvent, MouseEvent } from 'react';
import type { Folder, Metrics, Session, SftpItem } from '../types';
import { SessionTreePanel } from './SessionTreePanel';
import { SftpPanel } from './SftpPanel';
import { StatusPanel } from './StatusPanel';
import type { TransferRow } from '../hooks/useTransferQueue';
import appIcon from '../../assets/app-icon.png';

type SidebarShellProps = {
  sidebarTab: 'sessions' | 'sftp' | 'status';
  sidebarVisible: boolean;
  setSidebarTab: (tab: 'sessions' | 'sftp' | 'status') => void;
  folders: Folder[];
  sessions: Session[];
  expandedFolderIds: Set<number>;
  setExpandedFolderIds: (updater: (prev: Set<number>) => Set<number>) => void;
  connectSession: (session: Session, forceNew?: boolean) => Promise<void>;
  sessionTreeActions: {
    onOpenSessionMenu: (e: MouseEvent, session: Session) => void;
    onOpenFolderMenu: (e: MouseEvent, folder: Folder) => void;
    onCreateFolder: () => void;
    onCreateSession: () => void;
  };
  activeSessionId: number | null;
  activeSession: Session | null;
  activeSessionConnected: boolean;
  settingsShowHiddenFiles: boolean;
  sftpPath: string;
  sftpPathInput: string;
  sftpItems: SftpItem[];
  selectedSftpPaths: string[];
  sftpLoading: boolean;
  dropOver: boolean;
  transferRows: TransferRow[];
  formatSftpMeta: (item: SftpItem) => string;
  sftpInteractions: {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => Promise<void>;
    onToggleShowHidden: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onGoParent: () => Promise<void>;
    onFollowCwd: () => Promise<void>;
    onCreateDir: () => Promise<void>;
    onBatchUpload: () => Promise<void>;
    onBatchDownload: () => Promise<void>;
    onPathInputChange: (value: string) => void;
    onPathSubmit: () => Promise<void>;
    onPathBlur: () => void;
    onStartItemDrag: (e: DragEvent<HTMLDivElement>, fullPath: string, item: SftpItem) => void;
    onEndItemDrag: () => void;
    onSelectItem: (fullPath: string, options: { additive: boolean; range: boolean }) => void;
    onOpenItemMenu: (e: MouseEvent, payload: { path: string; name: string; isDir: boolean }) => void;
    onToggleItemSelect: (fullPath: string, checked: boolean, range?: boolean) => void;
    onOpenDir: (nextPath: string) => Promise<void>;
  };
  onCancelTransfer: (row: TransferRow) => void;
  currentMetrics: Metrics | null;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
};

export function SidebarShell(props: SidebarShellProps) {
  const {
    sidebarTab,
    sidebarVisible,
    setSidebarTab,
    folders,
    sessions,
    expandedFolderIds,
    setExpandedFolderIds,
    connectSession,
    sessionTreeActions,
    activeSessionId,
    activeSession,
    activeSessionConnected,
    settingsShowHiddenFiles,
    sftpPath,
    sftpPathInput,
    sftpItems,
    selectedSftpPaths,
    sftpLoading,
    dropOver,
    transferRows,
    formatSftpMeta,
    sftpInteractions,
    onCancelTransfer,
    currentMetrics,
    onOpenSettings,
    onToggleSidebar,
  } = props;
  const selectSidebarTab = (nextTab: 'sessions' | 'sftp' | 'status') => {
    setSidebarTab(nextTab);
    if (!sidebarVisible) onToggleSidebar();
  };

  return (
    <aside className={`sidebar ${sidebarVisible ? '' : 'is-collapsed'}`}>
      <nav className="activity-rail" aria-label="功能导航">
        <div className="activity-rail-main">
          <div className="rail-logo" title="Termio">
            <img src={appIcon} alt="Termio" draggable={false} />
          </div>
          <Button aria-label="会话" className={sidebarTab === 'sessions' ? 'is-active' : ''} type="text" icon={<CloudServerOutlined />} onClick={() => selectSidebarTab('sessions')} />
          <Button aria-label="SFTP 文件" className={sidebarTab === 'sftp' ? 'is-active' : ''} type="text" icon={<FolderOpenOutlined />} onClick={() => selectSidebarTab('sftp')} />
          <Button aria-label="系统状态" className={sidebarTab === 'status' ? 'is-active' : ''} type="text" icon={<SlidersOutlined />} onClick={() => selectSidebarTab('status')} />
        </div>
        <div className="activity-rail-footer">
          <Button aria-label={sidebarVisible ? '收起侧栏' : '展开侧栏'} type="text" icon={sidebarVisible ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} onClick={onToggleSidebar} />
          <Button aria-label="设置" type="text" icon={<SettingOutlined />} onClick={onOpenSettings} />
        </div>
      </nav>
      {sidebarVisible && <div className="sidebar-panel">
        <div className="sidebar-panel-title">
          {sidebarTab === 'sessions' ? '会话' : sidebarTab === 'sftp' ? '文件' : '状态'}
        </div>
      {sidebarTab === 'sessions' && (
        <SessionTreePanel
          folders={folders}
          sessions={sessions}
          expandedFolderIds={expandedFolderIds}
          onToggleFolder={(folderId) => {
            setExpandedFolderIds((prev) => {
              const next = new Set(prev);
              if (next.has(folderId)) next.delete(folderId);
              else next.add(folderId);
              return next;
            });
          }}
          onOpenSessionMenu={sessionTreeActions.onOpenSessionMenu}
          onOpenFolderMenu={sessionTreeActions.onOpenFolderMenu}
          onOpenSession={(session) => {
            void connectSession(session);
          }}
          onCreateFolder={sessionTreeActions.onCreateFolder}
          onCreateSession={sessionTreeActions.onCreateSession}
        />
      )}
      {sidebarTab === 'sftp' && (
        <SftpPanel
          activeSessionId={activeSessionId}
          hasActiveSession={!!activeSession && activeSessionConnected}
          showHiddenFiles={settingsShowHiddenFiles}
          sftpPath={sftpPath}
          sftpPathInput={sftpPathInput}
          sftpItems={sftpItems}
          selectedSftpPaths={selectedSftpPaths}
          loading={sftpLoading}
          dropOver={dropOver}
          transferRows={transferRows}
          formatSftpMeta={formatSftpMeta}
          onDragEnter={sftpInteractions.onDragEnter}
          onDragOver={sftpInteractions.onDragOver}
          onDragLeave={sftpInteractions.onDragLeave}
          onDrop={sftpInteractions.onDrop}
          onToggleShowHidden={sftpInteractions.onToggleShowHidden}
          onRefresh={sftpInteractions.onRefresh}
          onGoParent={sftpInteractions.onGoParent}
          onFollowCwd={sftpInteractions.onFollowCwd}
          onCreateDir={sftpInteractions.onCreateDir}
          onBatchUpload={sftpInteractions.onBatchUpload}
          onBatchDownload={sftpInteractions.onBatchDownload}
          onPathInputChange={sftpInteractions.onPathInputChange}
          onPathSubmit={sftpInteractions.onPathSubmit}
          onPathBlur={sftpInteractions.onPathBlur}
          onStartItemDrag={sftpInteractions.onStartItemDrag}
          onEndItemDrag={sftpInteractions.onEndItemDrag}
          onSelectItem={sftpInteractions.onSelectItem}
          onOpenItemMenu={sftpInteractions.onOpenItemMenu}
          onToggleItemSelect={sftpInteractions.onToggleItemSelect}
          onOpenDir={sftpInteractions.onOpenDir}
          onCancelTransfer={onCancelTransfer}
        />
      )}
      {sidebarTab === 'status' && <StatusPanel activeSessionId={activeSessionId} currentMetrics={currentMetrics} />}
      </div>}
    </aside>
  );
}
