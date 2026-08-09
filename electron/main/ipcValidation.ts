import type { AppSettings, Session } from './types';

const MAX_PATH_LENGTH = 4096;

export function requireRecord(value: unknown, label = '参数'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  if (value.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength}`);
  if (!allowEmpty && value.trim().length === 0) throw new Error(`${label}不能为空`);
  return value;
}

export function requirePath(value: unknown, label = '路径'): string {
  return requireString(value, label, MAX_PATH_LENGTH);
}

export function requirePositiveId(value: unknown, label = 'ID'): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label}必须是正整数`);
  return Number(value);
}

export function requireNullablePositiveId(value: unknown, label = 'ID'): number | null {
  return value == null ? null : requirePositiveId(value, label);
}

export function requireIntegerInRange(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label}必须是 ${min}-${max} 之间的整数`);
  }
  return Number(value);
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}

export function requireStringArray(value: unknown, label: string, maxItems: number, maxItemLength = MAX_PATH_LENGTH): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > maxItems) throw new Error(`${label}最多包含 ${maxItems} 项`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`, maxItemLength));
}

export function parseSession(value: unknown, requireId: boolean): Session {
  const input = requireRecord(value, '会话');
  return {
    id: requireId ? requirePositiveId(input.id, '会话 ID') : 0,
    folder_id: requireNullablePositiveId(input.folder_id, '目录 ID'),
    name: requireString(input.name, '会话名称', 128).trim(),
    host: requireString(input.host, '主机地址', 255).trim(),
    port: requireIntegerInRange(input.port, '端口', 1, 65535),
    username: requireString(input.username, '用户名', 128).trim(),
    password: requireString(input.password ?? '', '密码', 4096, true),
    remember_password: requireIntegerInRange(input.remember_password, '记住密码', 0, 1),
    default_session: requireIntegerInRange(input.default_session, '默认会话', 0, 1),
  };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label}包含不支持的字段：${unexpected.join(', ')}`);
}

export function validateSettingsPatch(value: unknown, current: AppSettings): AppSettings {
  const patch = requireRecord(value, '设置');
  assertAllowedKeys(patch, ['theme', 'behavior', 'ui'], '设置');
  const themePatch = patch.theme == null ? {} : requireRecord(patch.theme, '主题设置');
  const behaviorPatch = patch.behavior == null ? {} : requireRecord(patch.behavior, '行为设置');
  const uiPatch = patch.ui == null ? {} : requireRecord(patch.ui, '界面设置');
  assertAllowedKeys(themePatch, Object.keys(current.theme), '主题设置');
  assertAllowedKeys(behaviorPatch, Object.keys(current.behavior), '行为设置');
  assertAllowedKeys(uiPatch, Object.keys(current.ui), '界面设置');

  const merged = {
    ...current,
    theme: { ...current.theme, ...themePatch },
    behavior: { ...current.behavior, ...behaviorPatch },
    ui: { ...current.ui, ...uiPatch },
  } as AppSettings;
  if (merged.theme.mode !== 'dark' && merged.theme.mode !== 'light') throw new Error('主题模式无效');
  requireString(merged.theme.uiFontFamily, '界面字体', 256);
  requireString(merged.theme.terminalFontFamily, '终端字体', 256);
  requireIntegerInRange(merged.theme.uiFontSize, '界面字号', 10, 36);
  requireIntegerInRange(merged.theme.terminalFontSize, '终端字号', 10, 36);
  requireIntegerInRange(merged.theme.terminalCursorWidth, '光标宽度', 1, 8);
  if (!['block', 'underline', 'bar'].includes(merged.theme.terminalCursorStyle)) throw new Error('光标样式无效');
  requireBoolean(merged.theme.terminalCursorBlink, '光标闪烁');
  requireBoolean(merged.behavior.autoCopySelection, '选中自动复制');
  requireBoolean(merged.behavior.rightClickPaste, '右键粘贴');
  requireBoolean(merged.behavior.multilineWarning, '多行粘贴确认');
  requireBoolean(merged.behavior.autoSwitchEnglishInputMethod, '自动切换英文输入法');
  requireString(merged.behavior.defaultDownloadDir, '默认下载目录', MAX_PATH_LENGTH, true);
  requireBoolean(merged.ui.sidebarVisible, '侧边栏显示');
  requireBoolean(merged.ui.sftpVisible, 'SFTP 显示');
  requireBoolean(merged.ui.showHiddenFiles, '隐藏文件显示');
  requireIntegerInRange(merged.ui.sidebarWidth, '侧边栏宽度', 160, 1000);
  return merged;
}
