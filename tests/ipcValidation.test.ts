import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSession, requireStringArray, validateSettingsPatch } from '../electron/main/ipcValidation';
import type { AppSettings } from '../electron/main/types';

const defaultSettings: AppSettings = {
  theme: {
    mode: 'dark',
    backgroundColor: '#000000',
    foregroundColor: '#E5E7EB',
    uiFontFamily: 'MiSans, sans-serif',
    uiFontSize: 13,
    terminalFontFamily: 'Consolas, monospace',
    terminalFontSize: 16,
    terminalCursorStyle: 'block',
    terminalCursorBlink: true,
    terminalCursorWidth: 2,
  },
  behavior: {
    autoCopySelection: true,
    rightClickPaste: true,
    multilineWarning: true,
    defaultDownloadDir: '',
    autoSwitchEnglishInputMethod: false,
  },
  ui: {
    sidebarVisible: true,
    sftpVisible: true,
    showHiddenFiles: false,
    sidebarWidth: 300,
  },
};

test('session IPC payloads enforce identifiers, ports and field lengths', () => {
  const parsed = parseSession({
    folder_id: null,
    name: ' Production ',
    host: 'example.com',
    port: 22,
    username: 'root',
    password: 'secret',
    remember_password: 1,
    default_session: 0,
  }, false);
  assert.equal(parsed.name, 'Production');
  assert.equal(parsed.port, 22);
  assert.throws(() => parseSession({ ...parsed, id: 1, port: 70000 }, true), /端口/);
  assert.throws(() => parseSession({ ...parsed, id: -1 }, true), /会话 ID/);
});

test('private-key session IPC requires a key path and normalizes password settings', () => {
  const parsed = parseSession({
    folder_id: null,
    name: 'Key server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    auth_type: 'private_key',
    private_key_path: ' ~/.ssh/id_ed25519 ',
    passphrase: 'secret',
    remember_passphrase: 1,
    password: 'must-not-be-used',
    remember_password: 1,
    default_session: 0,
  }, false);
  assert.equal(parsed.private_key_path, '~/.ssh/id_ed25519');
  assert.equal(parsed.remember_password, 0);
  assert.equal(parsed.remember_passphrase, 1);
  assert.throws(() => parseSession({ ...parsed, private_key_path: '' }, false), /私钥文件/);
  assert.throws(() => parseSession({ ...parsed, auth_type: 'agent' }, false), /认证方式/);
});

test('settings IPC payloads reject unknown fields and invalid ranges', () => {
  const next = validateSettingsPatch({ theme: { terminalFontSize: 20 } }, defaultSettings);
  assert.equal(next.theme.terminalFontSize, 20);
  assert.throws(() => validateSettingsPatch({ behavior: { singleInstance: false } }, defaultSettings), /不支持的字段/);
  assert.throws(() => validateSettingsPatch({ ui: { sidebarWidth: 10 } }, defaultSettings), /侧边栏宽度/);
});

test('IPC arrays enforce item count and item length', () => {
  assert.deepEqual(requireStringArray(['/a', '/b'], '路径', 2), ['/a', '/b']);
  assert.throws(() => requireStringArray(['/a', '/b', '/c'], '路径', 2), /最多包含/);
});
