import { useCallback, useEffect, useRef } from 'react';

type UseWindowActionsParams = {
  closeTab: (tabId: number) => Promise<void>;
  hasRunningTransfers: boolean;
  askConfirm: (message: string, title?: string) => Promise<boolean>;
};

export function useWindowActions(params: UseWindowActionsParams) {
  const { closeTab, hasRunningTransfers, askConfirm } = params;
  const closeRequestPendingRef = useRef(false);
  const onCloseWindow = useCallback(async () => {
    if (closeRequestPendingRef.current) return;
    closeRequestPendingRef.current = true;
    try {
      if (hasRunningTransfers && !(await askConfirm('仍有文件正在传输，关闭窗口将取消这些任务。确定关闭吗？', '关闭 Termio'))) return;
      await window.terminalApi.closeWindow();
    } finally {
      closeRequestPendingRef.current = false;
    }
  }, [askConfirm, hasRunningTransfers]);

  useEffect(() => window.terminalApi.onWindowCloseRequested(() => {
    void onCloseWindow();
  }), [onCloseWindow]);

  return {
    onCloseTab: (tabId: number) => {
      closeTab(tabId).catch(() => null);
    },
    onMinimize: () => {
      void window.terminalApi.minimizeWindow();
    },
    onToggleMaximize: () => {
      void window.terminalApi.toggleMaximizeWindow();
    },
    onCloseWindow,
  };
}
