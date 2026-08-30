export type SessionTab = { id: number };

export function resolveTabsAfterClose<T extends SessionTab>(
  tabs: T[],
  activeTabId: number | null,
  closingTabId: number,
): { tabs: T[]; activeTabId: number | null } {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId);
  if (closingIndex < 0) return { tabs, activeTabId };
  const nextTabs = tabs.filter((tab) => tab.id !== closingTabId);
  if (activeTabId !== closingTabId) return { tabs: nextTabs, activeTabId };
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[closingIndex]?.id ?? nextTabs[closingIndex - 1]?.id ?? null,
  };
}
