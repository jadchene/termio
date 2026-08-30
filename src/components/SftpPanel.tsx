import {
  ArrowUpOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOutlined,
  ReloadOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Empty, Input, Spin, Tooltip } from 'antd';
import { useMemo } from 'react';
import type { SftpItem } from '../types';
import { TransferList } from './TransferList';

type TransferRow = {
  key: string;
  batchId: string;
  sessionId: number;
  direction: 'upload' | 'download';
  index: number;
  totalCount: number;
  completedCount: number;
  name: string;
  percent: number;
  transferred: number;
  total: number;
  status: 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
};

type SftpPanelProps = {
  activeSessionId: number | null;
  hasActiveSession: boolean;
  showHiddenFiles: boolean;
  sftpPath: string;
  sftpPathInput: string;
  sftpItems: SftpItem[];
  selectedSftpPaths: string[];
  loading: boolean;
  dropOver: boolean;
  transferRows: TransferRow[];
  formatSftpMeta: (item: SftpItem) => string;
  onDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => Promise<void>;
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
  onStartItemDrag: (e: React.DragEvent<HTMLDivElement>, fullPath: string, item: SftpItem) => void;
  onEndItemDrag: () => void;
  onSelectItem: (fullPath: string, options: { additive: boolean; range: boolean }) => void;
  onOpenItemMenu: (e: React.MouseEvent, payload: { path: string; name: string; isDir: boolean }) => void;
  onToggleItemSelect: (fullPath: string, checked: boolean, range?: boolean) => void;
  onOpenDir: (nextPath: string) => Promise<void>;
  onCancelTransfer: (row: TransferRow) => void;
};

export const SftpPanel = (props: SftpPanelProps) => {
  const {
    activeSessionId,
    hasActiveSession,
    showHiddenFiles,
    sftpPath,
    sftpPathInput,
    sftpItems,
    selectedSftpPaths,
    loading,
    dropOver,
    transferRows,
    formatSftpMeta,
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
    onPathInputChange,
    onPathSubmit,
    onPathBlur,
    onStartItemDrag,
    onEndItemDrag,
    onSelectItem,
    onOpenItemMenu,
    onToggleItemSelect,
    onOpenDir,
    onCancelTransfer,
  } = props;
  const selectedPathSet = useMemo(() => new Set(selectedSftpPaths), [selectedSftpPaths]);

  if (!activeSessionId) {
    return <div className="panel-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无活动会话" /></div>;
  }

  const toolbarItems = [
    { title: '上级目录', icon: <ArrowUpOutlined />, action: onGoParent, disabled: !hasActiveSession },
    { title: '跟随 SSH 当前目录', icon: <SyncOutlined />, action: onFollowCwd, disabled: !hasActiveSession },
    { title: '刷新', icon: <ReloadOutlined />, action: onRefresh, disabled: !hasActiveSession },
    { title: showHiddenFiles ? '隐藏文件' : '显示隐藏文件', icon: showHiddenFiles ? <EyeInvisibleOutlined /> : <EyeOutlined />, action: onToggleShowHidden, disabled: !hasActiveSession },
    { title: '新建目录', icon: <FolderAddOutlined />, action: onCreateDir, disabled: !hasActiveSession },
    { title: '批量上传', icon: <UploadOutlined />, action: onBatchUpload, disabled: !hasActiveSession },
    { title: '批量下载', icon: <DownloadOutlined />, action: onBatchDownload, disabled: !hasActiveSession || selectedSftpPaths.length === 0 },
  ];

  return (
    <div
      className={`sftp-sidebar-content panel-content ${dropOver ? 'drop-over' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="sidebar-actions sftp-toolbar">
        {toolbarItems.map((item) => (
          <Tooltip key={item.title} title={item.title}>
            <Button aria-label={item.title} type="text" size="small" icon={item.icon} disabled={item.disabled} onClick={() => void item.action()} />
          </Tooltip>
        ))}
      </div>
      <div className="path-bar">
        <Input
          size="small"
          value={sftpPathInput}
          onChange={(event) => onPathInputChange(event.target.value)}
          onPressEnter={() => void onPathSubmit()}
          onBlur={onPathBlur}
          title="输入远程路径并按 Enter 跳转"
          aria-label="远程路径"
          disabled={!hasActiveSession}
        />
      </div>
      <div className="sftp-list" role="listbox" aria-label="远程文件">
        {!hasActiveSession ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="连接已断开，请先在终端按 R 重连" />
        ) : loading && sftpItems.length === 0 ? (
          <div className="sftp-loading"><Spin size="small" /><span>正在读取目录…</span></div>
        ) : sftpItems.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="目录为空" />
        ) : sftpItems.map((item) => {
          const isDir = item.type === 'd';
          const fullPath = `${sftpPath.replace(/\/$/, '')}/${item.name}`;
          return (
              <div
                key={`${item.name}-${item.modifyTime}`}
                className="sftp-row"
                title={formatSftpMeta(item)}
                role="option"
                aria-selected={selectedPathSet.has(fullPath)}
                tabIndex={0}
                draggable
                onDragStart={(event) => onStartItemDrag(event, fullPath, item)}
                onDragEnd={onEndItemDrag}
                onContextMenu={(event) => onOpenItemMenu(event, { path: fullPath, name: item.name, isDir })}
                onClick={(event) => onSelectItem(fullPath, {
                  additive: event.ctrlKey || event.metaKey,
                  range: event.shiftKey,
                })}
                onDoubleClick={() => {
                  if (isDir) void onOpenDir(fullPath);
                }}
                onKeyDown={(event) => {
                  if ((event.target as HTMLElement).closest('.ant-checkbox-wrapper')) return;
                  if (event.key === 'Enter' && isDir) {
                    event.preventDefault();
                    void onOpenDir(fullPath);
                  } else if (event.key === ' ') {
                    event.preventDefault();
                    onToggleItemSelect(fullPath, !selectedPathSet.has(fullPath), event.shiftKey);
                  }
                }}
              >
                <Checkbox
                  checked={selectedPathSet.has(fullPath)}
                  onChange={(event) => onToggleItemSelect(fullPath, event.target.checked, event.nativeEvent.shiftKey)}
                  onClick={(event) => event.stopPropagation()}
                />
                <span className={`sftp-item-icon ${isDir ? 'is-folder' : ''}`} aria-hidden="true">
                  {isDir ? <FolderOutlined /> : <FileOutlined />}
                </span>
                <span className="sftp-item-name">{item.name}</span>
              </div>
          );
        })}
      </div>
      <TransferList rows={transferRows} onCancel={onCancelTransfer} />
    </div>
  );
};
