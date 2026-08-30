import { DownOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Empty, Tooltip } from 'antd';
import { useMemo, type MouseEvent } from 'react';
import type { ReactNode } from 'react';
import type { Folder, Session } from '../types';

type SessionTreePanelProps = {
  folders: Folder[];
  sessions: Session[];
  expandedFolderIds: Set<number>;
  onToggleFolder: (folderId: number) => void;
  onOpenSessionMenu: (e: MouseEvent, session: Session) => void;
  onOpenFolderMenu: (e: MouseEvent, folder: Folder) => void;
  onOpenSession: (session: Session) => void;
  onCreateFolder: () => void;
  onCreateSession: () => void;
};

const compareByNameThenId = (a: { name: string; id: number }, b: { name: string; id: number }): number => {
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
  if (byName !== 0) return byName;
  return a.id - b.id;
};

const TerminalIcon = () => (
  <svg
    className="session-type-icon"
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M6 9l3 3-3 3" />
    <line x1="11" y1="15" x2="18" y2="15" />
  </svg>
);

export const SessionTreePanel = (props: SessionTreePanelProps) => {
  const {
    folders,
    sessions,
    expandedFolderIds,
    onToggleFolder,
    onOpenSessionMenu,
    onOpenFolderMenu,
    onOpenSession,
    onCreateFolder,
    onCreateSession,
  } = props;

  const sessionsByFolder = useMemo(() => {
    const grouped = new Map<number | null, Session[]>();
    for (const session of [...sessions].sort(compareByNameThenId)) {
      const list = grouped.get(session.folder_id) || [];
      list.push(session);
      grouped.set(session.folder_id, list);
    }
    return grouped;
  }, [sessions]);
  const foldersByParent = useMemo(() => {
    const grouped = new Map<number | null, Folder[]>();
    for (const folder of [...folders].sort(compareByNameThenId)) {
      const list = grouped.get(folder.parent_id) || [];
      list.push(folder);
      grouped.set(folder.parent_id, list);
    }
    return grouped;
  }, [folders]);

  const renderSessionList = (folderId: number | null): ReactNode[] =>
    (sessionsByFolder.get(folderId) || [])
      .map((session) => (
        <div key={session.id} className="session-node" onContextMenu={(e) => onOpenSessionMenu(e, session)}>
          <button
            className="link-btn tree-row-btn"
            title={`${session.name} — ${session.username}@${session.host}:${session.port}`}
            onContextMenu={(e) => onOpenSessionMenu(e, session)}
            onClick={() => onOpenSession(session)}
          >
            <TerminalIcon />
            <span className="session-tree-name">{session.name}</span>
          </button>
        </div>
      ));

  const renderFolderTree = (parentId: number | null): ReactNode[] =>
    (foldersByParent.get(parentId) || [])
      .map((folder) => (
        <div key={folder.id} className="folder-node">
          <button className="folder-title" aria-expanded={expandedFolderIds.has(folder.id)} onClick={() => onToggleFolder(folder.id)} onContextMenu={(e) => onOpenFolderMenu(e, folder)}>
            <span className="folder-toggle-icon" aria-hidden="true">
              {expandedFolderIds.has(folder.id) ? <DownOutlined /> : <RightOutlined />}
            </span>
            <FolderOutlined className="folder-type-icon" />
            <span className="folder-tree-name">{folder.name}</span>
          </button>
          {expandedFolderIds.has(folder.id) && (
            <div className="folder-children">
              {renderSessionList(folder.id)}
              {renderFolderTree(folder.id)}
            </div>
          )}
        </div>
      ));

  return (
    <div className="tree-content panel-content">
      <div className="sidebar-actions">
        <Tooltip title="新建目录"><Button aria-label="新建目录" type="text" size="small" icon={<FolderAddOutlined />} onClick={onCreateFolder} /></Tooltip>
        <Tooltip title="新建会话"><Button aria-label="新建会话" type="text" size="small" icon={<PlusOutlined />} onClick={onCreateSession} /></Tooltip>
      </div>
      <div className="tree-scroll">
        {sessions.length === 0 && folders.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
          : <>{renderSessionList(null)}{renderFolderTree(null)}</>}
      </div>
    </div>
  );
};
