export type SidebarTab = 'sessions' | 'sftp' | 'status';

export const isMetricsPanelVisible = (sidebarTab: SidebarTab, sidebarVisible: boolean): boolean => (
  sidebarVisible && sidebarTab === 'status'
);

export const resolveMetricsSessionId = (
  activeSessionId: number | null,
  sidebarTab: SidebarTab,
  sidebarVisible: boolean,
): number | null => (
  isMetricsPanelVisible(sidebarTab, sidebarVisible) ? activeSessionId : null
);
