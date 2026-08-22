import { CloseOutlined, MinusOutlined } from '@ant-design/icons';
import { Button, Tabs, Tooltip } from 'antd';
import type { ConnectionState } from '../types';

type Tab = { id: number; sessionId: number; title: string };

type AppHeaderProps = {
  tabs: Tab[];
  activeSessionId: number | null;
  connectionStates: Record<number, ConnectionState>;
  isMaximized: boolean;
  onSelectTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
};

const statusLabels: Record<ConnectionState, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
};

const WindowStateIcon = ({ isMaximized }: { isMaximized: boolean }) => (
  <svg className="window-state-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {isMaximized ? (
      <>
        <path d="M5.5 5.5v-3h8v8h-3" />
        <rect x="2.5" y="5.5" width="8" height="8" />
      </>
    ) : <rect x="3" y="3" width="10" height="10" />}
  </svg>
);

export const AppHeader = (props: AppHeaderProps) => {
  const {
    tabs,
    activeSessionId,
    connectionStates,
    isMaximized,
    onSelectTab,
    onCloseTab,
    onMinimize,
    onToggleMaximize,
    onCloseWindow,
  } = props;

  const items = tabs.map((tab) => {
    const state = connectionStates[tab.id] ?? 'connecting';
    return {
      key: String(tab.id),
      label: (
        <span className="session-tab-label">
          <Tooltip title={statusLabels[state]} mouseEnterDelay={0.5}>
            <span className={`session-state-dot is-${state}`} />
          </Tooltip>
          <span className="session-tab-title">{tab.title}</span>
          <span
            className="session-tab-close"
            aria-label={`关闭 ${tab.title}`}
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onCloseTab(tab.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            <CloseOutlined />
          </span>
        </span>
      ),
    };
  });

  return (
    <header className="title-bar">
      <div className="title-tabs">
        {items.length > 0 ? (
          <Tabs
            activeKey={activeSessionId == null ? undefined : String(activeSessionId)}
            items={items}
            onChange={(key) => onSelectTab(Number(key))}
          />
        ) : <div className="title-drag-region" />}
      </div>
      <div className="window-controls">
        <Button type="text" aria-label="最小化" icon={<MinusOutlined />} onClick={onMinimize} />
        <Button
          type="text"
          aria-label={isMaximized ? '还原' : '最大化'}
          icon={<WindowStateIcon isMaximized={isMaximized} />}
          onClick={onToggleMaximize}
        />
        <Button className="window-close" type="text" aria-label="关闭" icon={<CloseOutlined />} onClick={onCloseWindow} />
      </div>
    </header>
  );
};
