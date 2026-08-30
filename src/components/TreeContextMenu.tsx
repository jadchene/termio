import type { TreeContextMenu as TreeContextMenuState } from '../types';
import { clampContextMenuPosition } from '../utils/contextMenuPosition';

type TreeContextMenuProps = {
  menu: TreeContextMenuState | null;
  onOpenNewSession: (menu: Extract<TreeContextMenuState, { type: 'session' }>) => Promise<void>;
  onCopySession: (menu: Extract<TreeContextMenuState, { type: 'session' }>) => Promise<void>;
  onEditSession: (menu: Extract<TreeContextMenuState, { type: 'session' }>) => void;
  onDeleteSession: (menu: Extract<TreeContextMenuState, { type: 'session' }>) => Promise<void>;
  onCreateSessionInFolder: (menu: Extract<TreeContextMenuState, { type: 'folder' }>) => void;
  onCreateFolderInFolder: (menu: Extract<TreeContextMenuState, { type: 'folder' }>) => void;
  onEditFolder: (menu: Extract<TreeContextMenuState, { type: 'folder' }>) => Promise<void>;
  onDeleteFolder: (menu: Extract<TreeContextMenuState, { type: 'folder' }>) => Promise<void>;
  onDownloadSftp: (menu: Extract<TreeContextMenuState, { type: 'sftp' }>) => Promise<void>;
  onRenameSftp: (menu: Extract<TreeContextMenuState, { type: 'sftp' }>) => Promise<void>;
  onDeleteSftp: (menu: Extract<TreeContextMenuState, { type: 'sftp' }>) => Promise<void>;
};

export function TreeContextMenu(props: TreeContextMenuProps) {
  const {
    menu,
    onOpenNewSession,
    onCopySession,
    onEditSession,
    onDeleteSession,
    onCreateSessionInFolder,
    onCreateFolderInFolder,
    onEditFolder,
    onDeleteFolder,
    onDownloadSftp,
    onRenameSftp,
    onDeleteSftp,
  } = props;
  if (!menu) return null;
  const position = clampContextMenuPosition(menu.x, menu.y, window.innerWidth, window.innerHeight);

  return (
    <div className="tree-context-menu" role="menu" style={position} onClick={(e) => e.stopPropagation()}>
      {menu.type === 'session' ? (
        <>
          <button role="menuitem" autoFocus onClick={() => void onOpenNewSession(menu)}>新建连接</button>
          <button role="menuitem" onClick={() => void onCopySession(menu)}>复制</button>
          <button role="menuitem" onClick={() => onEditSession(menu)}>编辑</button>
          <button role="menuitem" className="danger" onClick={() => void onDeleteSession(menu)}>
            删除
          </button>
        </>
      ) : menu.type === 'folder' ? (
        <>
          <button role="menuitem" autoFocus onClick={() => onCreateSessionInFolder(menu)}>新增会话</button>
          <button role="menuitem" onClick={() => onCreateFolderInFolder(menu)}>新增目录</button>
          <button role="menuitem" onClick={() => void onEditFolder(menu)}>编辑</button>
          <button role="menuitem" className="danger" onClick={() => void onDeleteFolder(menu)}>
            删除
          </button>
        </>
      ) : (
        <>
          <button role="menuitem" autoFocus onClick={() => void onDownloadSftp(menu)}>
            {menu.downloadPaths.length > 1 ? `下载所选 ${menu.downloadPaths.length} 项` : '下载'}
          </button>
          <button role="menuitem" onClick={() => void onRenameSftp(menu)}>重命名</button>
          <button role="menuitem" className="danger" onClick={() => void onDeleteSftp(menu)}>
            删除
          </button>
        </>
      )}
    </div>
  );
}
