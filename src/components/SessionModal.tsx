import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Checkbox, Form, Input, InputNumber, Modal, Radio, TreeSelect } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { FolderTreeOption } from '../hooks/useFolderTreeOptions';
import type { Session } from '../types';

type SessionForm = Omit<Session, 'id'>;

type SessionModalProps = {
  show: boolean;
  editing: boolean;
  form: SessionForm;
  showPassword: boolean;
  folderMenuOpen: boolean;
  folderTreeData: FolderTreeOption[];
  onChangeForm: (next: SessionForm) => void;
  onTogglePassword: () => void;
  onToggleFolderMenu: () => void;
  onPickFolder: (folderId: number | null) => void;
  onPickPrivateKey: (defaultPath: string) => Promise<string>;
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
};

export const SessionModal = (props: SessionModalProps) => {
  const {
    show,
    editing,
    form,
    showPassword,
    folderMenuOpen,
    folderTreeData,
    onChangeForm,
    onTogglePassword,
    onToggleFolderMenu,
    onPickFolder,
    onPickPrivateKey,
    onCancel,
    onConfirm,
  } = props;
  const nameInputRef = useRef<import('antd').InputRef>(null);
  const hostInputRef = useRef<import('antd').InputRef>(null);
  const usernameInputRef = useRef<import('antd').InputRef>(null);
  const privateKeyInputRef = useRef<import('antd').InputRef>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickingKey, setPickingKey] = useState(false);

  useEffect(() => {
    if (!show) return;
    setAttempted(false);
    setSaving(false);
    setPickingKey(false);
    requestAnimationFrame(() => nameInputRef.current?.focus({ cursor: 'end' }));
  }, [show]);

  const missingName = !form.name.trim();
  const missingHost = !form.host.trim();
  const missingUsername = !form.username.trim();
  const missingPrivateKey = form.auth_type === 'private_key' && !form.private_key_path.trim();

  const submit = async () => {
    if (saving) return;
    setAttempted(true);
    if (missingName || missingHost || missingUsername || missingPrivateKey) {
      requestAnimationFrame(() => {
        if (missingName) nameInputRef.current?.focus();
        else if (missingHost) hostInputRef.current?.focus();
        else if (missingUsername) usernameInputRef.current?.focus();
        else privateKeyInputRef.current?.focus();
      });
      return;
    }
    setSaving(true);
    try {
      await onConfirm();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={show}
      className="session-modal"
      title={editing ? '编辑会话' : '新建会话'}
      centered
      mask={{ closable: false }}
      closable={!saving}
      keyboard={!saving}
      onCancel={() => {
        if (!saving) onCancel();
      }}
      footer={[
        <Button key="cancel" disabled={saving} onClick={onCancel}>取消</Button>,
        <Button key="confirm" type="primary" loading={saving} onClick={() => void submit()}>{editing ? '保存' : '创建'}</Button>,
      ]}
    >
      <Form
        layout="vertical"
        colon={false}
        className="session-form"
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          const target = event.target as HTMLElement;
          if (target.closest('button, [role="button"], .ant-select')) return;
          event.preventDefault();
          void submit();
        }}
      >
        <Form.Item label="名称" required validateStatus={attempted && missingName ? 'error' : undefined} help={attempted && missingName ? '请输入会话名称' : undefined}>
          <Input ref={nameInputRef} value={form.name} onChange={(event) => onChangeForm({ ...form, name: event.target.value })} />
        </Form.Item>
        <div className="form-grid-two">
          <Form.Item label="主机" required validateStatus={attempted && missingHost ? 'error' : undefined} help={attempted && missingHost ? '请输入主机地址' : undefined}>
            <Input ref={hostInputRef} value={form.host} placeholder="IP 地址或域名" onChange={(event) => onChangeForm({ ...form, host: event.target.value })} />
          </Form.Item>
          <Form.Item label="端口">
            <InputNumber min={1} max={65535} value={form.port} onChange={(value) => onChangeForm({ ...form, port: value ?? 22 })} />
          </Form.Item>
        </div>
        <Form.Item label="用户名" required validateStatus={attempted && missingUsername ? 'error' : undefined} help={attempted && missingUsername ? '请输入用户名' : undefined}>
          <Input ref={usernameInputRef} value={form.username} onChange={(event) => onChangeForm({ ...form, username: event.target.value })} />
        </Form.Item>
        <Form.Item label="认证方式">
          <Radio.Group className="auth-method-picker"
            optionType="button"
            buttonStyle="solid"
            value={form.auth_type}
            onChange={(event) => {
              const authType = event.target.value as Session['auth_type'];
              onChangeForm({
                ...form,
                auth_type: authType,
                password: '',
                remember_password: authType === 'password' ? form.remember_password : 0,
                passphrase: '',
                remember_passphrase: authType === 'private_key' ? form.remember_passphrase : 0,
              });
            }}
          >
            <Radio.Button value="password">密码</Radio.Button>
            <Radio.Button value="private_key">SSH 私钥</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {form.auth_type === 'password' ? (
          <Form.Item label={editing ? '密码（留空则不修改）' : '密码'}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(event) => onChangeForm({ ...form, password: event.target.value })}
              suffix={<Button type="text" size="small" aria-label={showPassword ? '隐藏密码' : '显示密码'} icon={showPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={onTogglePassword} />}
            />
          </Form.Item>
        ) : (
          <>
            <Form.Item label="私钥文件" required validateStatus={attempted && missingPrivateKey ? 'error' : undefined} help={attempted && missingPrivateKey ? '请选择或输入私钥文件路径' : undefined} extra="支持 OpenSSH / PEM 私钥；私钥内容只在连接时读取，不会写入数据库。">
              <div className="private-key-picker">
                <Input
                  ref={privateKeyInputRef}
                  value={form.private_key_path}
                  placeholder="例如 ~/.ssh/id_ed25519"
                  onChange={(event) => onChangeForm({ ...form, private_key_path: event.target.value })}
                />
                <Button loading={pickingKey} onClick={() => {
                  setPickingKey(true);
                  void onPickPrivateKey(form.private_key_path).then((selected) => {
                    if (selected) onChangeForm({ ...form, private_key_path: selected });
                  }).finally(() => setPickingKey(false));
                }}>浏览…</Button>
              </div>
            </Form.Item>
            <Form.Item label={editing ? '私钥口令（留空则不修改）' : '私钥口令'} extra="未加密私钥可留空。">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={form.passphrase}
                onChange={(event) => onChangeForm({ ...form, passphrase: event.target.value })}
                suffix={<Button type="text" size="small" aria-label={showPassword ? '隐藏私钥口令' : '显示私钥口令'} icon={showPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={onTogglePassword} />}
              />
            </Form.Item>
          </>
        )}
        <Form.Item label="目录">
          <TreeSelect
            className="folder-select"
            open={folderMenuOpen}
            value={form.folder_id ?? 0}
            treeData={folderTreeData}
            treeDefaultExpandAll
            onOpenChange={(open) => {
              if (open !== folderMenuOpen) onToggleFolderMenu();
            }}
            onChange={(value) => onPickFolder(value === 0 ? null : value)}
          />
        </Form.Item>
        <div className="form-check-row">
          {form.auth_type === 'password' ? (
            <Checkbox checked={form.remember_password === 1} onChange={(event) => onChangeForm({ ...form, remember_password: event.target.checked ? 1 : 0 })}>记住密码</Checkbox>
          ) : (
            <Checkbox checked={form.remember_passphrase === 1} onChange={(event) => onChangeForm({ ...form, remember_passphrase: event.target.checked ? 1 : 0 })}>记住私钥口令</Checkbox>
          )}
          <Checkbox checked={form.default_session === 1} onChange={(event) => onChangeForm({ ...form, default_session: event.target.checked ? 1 : 0 })}>默认会话</Checkbox>
        </div>
      </Form>
    </Modal>
  );
};
