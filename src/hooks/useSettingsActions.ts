import type { Dispatch, SetStateAction } from 'react';
import type { Settings } from '../types';

type RuntimeInfo = {
  runtimeDir: string;
  userDataPath: string;
  settingsStorage: string;
  dbPath: string;
  os: string;
};

type UseSettingsActionsParams = {
  settings: Settings | null;
  settingsDraft: Settings | null;
  runtimeInfo: RuntimeInfo | null;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  setSettingsDraft: Dispatch<SetStateAction<Settings | null>>;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setSettingsTab: Dispatch<SetStateAction<'appearance' | 'behavior' | 'system'>>;
  setCursorStyleMenuOpen: Dispatch<SetStateAction<boolean>>;
  showAlert: (message: string, title?: string) => Promise<void>;
};

export function useSettingsActions(params: UseSettingsActionsParams) {
  const {
    settings,
    settingsDraft,
    runtimeInfo,
    setSettings,
    setSettingsDraft,
    setShowSettings,
    setSettingsTab,
    setCursorStyleMenuOpen,
    showAlert,
  } = params;

  const showSettingsError = async (error: unknown) => {
    await showAlert(error instanceof Error ? error.message : String(error), '设置操作失败');
  };

  const openSettingsModal = () => {
    if (!settings) return;
    setSettingsDraft({
      ...settings,
      theme: { ...settings.theme },
      behavior: { ...settings.behavior },
      ui: { ...settings.ui },
    });
    setSettingsTab('appearance');
    setShowSettings(true);
  };

  const toggleSidebarVisible = async () => {
    if (!settings) return;
    try {
      const saved = await window.terminalApi.updateSettings({
        ui: { ...settings.ui, sidebarVisible: !settings.ui.sidebarVisible },
      });
      setSettings(saved);
    } catch (error) {
      await showSettingsError(error);
    }
  };

  const pickDefaultDownloadDir = async () => {
    if (!settingsDraft) return;
    try {
      const picked = await window.terminalApi.pickDirectory(settingsDraft.behavior.defaultDownloadDir || runtimeInfo?.runtimeDir);
      if (!picked) return;
      setSettingsDraft({
        ...settingsDraft,
        behavior: { ...settingsDraft.behavior, defaultDownloadDir: picked },
      });
    } catch (error) {
      await showSettingsError(error);
    }
  };

  const cancelSettingsModal = () => {
    setShowSettings(false);
    setSettingsDraft(null);
    setSettingsTab('appearance');
    setCursorStyleMenuOpen(false);
  };

  const saveSettingsModal = async () => {
    if (!settingsDraft) return;
    const normalizedDraft: Settings = {
      ...settingsDraft,
      theme: {
        ...settingsDraft.theme,
        terminalCursorStyle: settingsDraft.theme.terminalCursorStyle || 'block',
        terminalCursorBlink: settingsDraft.theme.terminalCursorBlink ?? true,
        terminalCursorWidth: Math.max(1, Math.min(8, Number(settingsDraft.theme.terminalCursorWidth ?? 2))),
      },
      behavior: {
        ...settingsDraft.behavior,
        autoSwitchEnglishInputMethod: settingsDraft.behavior.autoSwitchEnglishInputMethod ?? false,
      },
    };
    try {
      const saved = await window.terminalApi.updateSettings(normalizedDraft);
      setSettings(saved);
      setSettingsDraft(null);
      setShowSettings(false);
      setSettingsTab('appearance');
      setCursorStyleMenuOpen(false);
    } catch (error) {
      await showSettingsError(error);
    }
  };

  return {
    openSettingsModal,
    toggleSidebarVisible,
    pickDefaultDownloadDir,
    cancelSettingsModal,
    saveSettingsModal,
  };
}
