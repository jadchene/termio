import type { RefObject } from 'react';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Tabs,
  Typography,
} from 'antd';
import type { Settings } from '../types';

type SettingsTab = 'appearance' | 'behavior' | 'system';

type SettingsModalProps = {
  show: boolean;
  draft: Settings | null;
  tab: SettingsTab;
  cursorStyleMenuOpen: boolean;
  cursorStyleMenuRef: RefObject<HTMLDivElement | null>;
  runtimeInfo: {
    runtimeDir: string;
    userDataPath: string;
    settingsStorage: string;
    dbPath: string;
    os: string;
  } | null;
  onSwitchTab: (tab: SettingsTab) => void;
  onToggleCursorMenu: () => void;
  onCloseCursorMenu: () => void;
  onUpdateDraft: (next: Settings) => void;
  onPickDefaultDownloadDir: () => Promise<void>;
  onCancel: () => void;
  onSave: () => Promise<void>;
};

const SettingGroup = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="settings-group">
    <h3>{title}</h3>
    <div className="settings-group-body">{children}</div>
  </section>
);

const RuntimePath = ({ value }: { value?: string }) => (
  <Typography.Text className="runtime-path-value" ellipsis={{ tooltip: value }}>{value || '--'}</Typography.Text>
);

const settingsFormLayout = {
  layout: 'horizontal' as const,
  colon: false,
  labelCol: { style: { width: 140 } },
  wrapperCol: { style: { flex: 1, minWidth: 0 } },
};

export const SettingsModal = (props: SettingsModalProps) => {
  const {
    show,
    draft,
    tab,
    runtimeInfo,
    onSwitchTab,
    onUpdateDraft,
    onPickDefaultDownloadDir,
    onCancel,
    onSave,
  } = props;

  if (!draft) return null;
  const updateTheme = (next: Partial<Settings['theme']>) => onUpdateDraft({
    ...draft,
    theme: { ...draft.theme, ...next },
  });
  const updateBehavior = (next: Partial<Settings['behavior']>) => onUpdateDraft({
    ...draft,
    behavior: { ...draft.behavior, ...next },
  });

  const appearance = (
    <div className="settings-scroll">
      <SettingGroup title="界面">
        <Form {...settingsFormLayout}>
          <Form.Item label="主题">
            <Segmented
              className="theme-segmented"
              block
              value={draft.theme.mode}
              options={[{ label: '深色', value: 'dark' }, { label: '浅色', value: 'light' }]}
              onChange={(value) => updateTheme({ mode: value as Settings['theme']['mode'] })}
            />
          </Form.Item>
          <Form.Item label="界面字号">
            <InputNumber min={11} max={24} value={draft.theme.uiFontSize} suffix="px" onChange={(value) => updateTheme({ uiFontSize: value ?? 13 })} />
          </Form.Item>
        </Form>
      </SettingGroup>
      <SettingGroup title="终端">
        <Form {...settingsFormLayout}>
          <Form.Item label="终端字体">
            <Input value={draft.theme.terminalFontFamily} onChange={(event) => updateTheme({ terminalFontFamily: event.target.value })} />
          </Form.Item>
          <Form.Item label="终端字号">
            <InputNumber min={10} max={36} value={draft.theme.terminalFontSize} suffix="px" onChange={(value) => updateTheme({ terminalFontSize: value ?? 16 })} />
          </Form.Item>
          <Form.Item label="光标样式">
            <Select
              value={draft.theme.terminalCursorStyle}
              options={[
                { label: '块', value: 'block' },
                { label: '下划线', value: 'underline' },
                { label: '竖线', value: 'bar' },
              ]}
              onChange={(value) => updateTheme({ terminalCursorStyle: value })}
            />
          </Form.Item>
          <Form.Item label="光标闪烁">
            <Switch checked={draft.theme.terminalCursorBlink} onChange={(checked) => updateTheme({ terminalCursorBlink: checked })} />
          </Form.Item>
          <Form.Item label="竖线宽度">
            <InputNumber min={1} max={8} value={draft.theme.terminalCursorWidth} suffix="px" onChange={(value) => updateTheme({ terminalCursorWidth: value ?? 2 })} />
          </Form.Item>
        </Form>
      </SettingGroup>
    </div>
  );

  const behavior = (
    <div className="settings-scroll">
      <SettingGroup title="会话行为">
        <Form {...settingsFormLayout}>
          <Form.Item label="选中自动复制">
            <Switch checked={draft.behavior.autoCopySelection} onChange={(checked) => updateBehavior({ autoCopySelection: checked })} />
          </Form.Item>
          <Form.Item label="右键粘贴">
            <Switch checked={draft.behavior.rightClickPaste} onChange={(checked) => updateBehavior({ rightClickPaste: checked })} />
          </Form.Item>
          <Form.Item label="粘贴多行确认">
            <Switch checked={draft.behavior.multilineWarning} onChange={(checked) => updateBehavior({ multilineWarning: checked })} />
          </Form.Item>
          <Form.Item label="自动切换英文">
            <Switch checked={draft.behavior.autoSwitchEnglishInputMethod} onChange={(checked) => updateBehavior({ autoSwitchEnglishInputMethod: checked })} />
          </Form.Item>
        </Form>
      </SettingGroup>
      <SettingGroup title="文件传输">
        <Form {...settingsFormLayout}>
          <Form.Item label="默认下载目录">
            <Input
              value={draft.behavior.defaultDownloadDir}
              placeholder="留空时使用系统下载目录"
              onChange={(event) => updateBehavior({ defaultDownloadDir: event.target.value })}
              addonAfter={<Button type="text" size="small" onClick={() => void onPickDefaultDownloadDir()}>选择</Button>}
            />
          </Form.Item>
        </Form>
      </SettingGroup>
    </div>
  );

  const system = (
    <div className="settings-scroll">
      <SettingGroup title="运行环境">
        <Form {...settingsFormLayout}>
          <Form.Item label="运行目录"><RuntimePath value={runtimeInfo?.runtimeDir} /></Form.Item>
          <Form.Item label="用户数据"><RuntimePath value={runtimeInfo?.userDataPath} /></Form.Item>
          <Form.Item label="数据库"><RuntimePath value={runtimeInfo?.dbPath} /></Form.Item>
        </Form>
      </SettingGroup>
    </div>
  );

  return (
    <Modal
      className="settings-modal"
      open={show}
      title="设置"
      width={760}
      centered
      mask={{ closable: false }}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="save" type="primary" onClick={() => void onSave()}>保存</Button>,
      ]}
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => onSwitchTab(key as SettingsTab)}
        items={[
          { key: 'appearance', label: '外观', children: appearance },
          { key: 'behavior', label: '行为', children: behavior },
          { key: 'system', label: '系统', children: system },
        ]}
      />
    </Modal>
  );
};
