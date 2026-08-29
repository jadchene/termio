import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Checkbox, Form, Input, InputNumber, Modal, Radio, TreeSelect } from 'antd';
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
  onCancel: () => void;
  onConfirm: () => Promise<void>;
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
    onCancel,
    onConfirm,
  } = props;

  return (
    <Modal
      open={show}
      title={editing ? '编辑会话' : '新建会话'}
      centered
      mask={{ closable: false }}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="confirm" type="primary" onClick={() => void onConfirm()}>确认</Button>,
      ]}
    >
      <Form layout="vertical" colon={false} className="session-form">
        <Form.Item label="名称" required>
          <Input value={form.name} onChange={(event) => onChangeForm({ ...form, name: event.target.value })} />
        </Form.Item>
        <div className="form-grid-two">
          <Form.Item label="主机" required>
            <Input value={form.host} onChange={(event) => onChangeForm({ ...form, host: event.target.value })} />
          </Form.Item>
          <Form.Item label="端口">
            <InputNumber min={1} max={65535} value={form.port} onChange={(value) => onChangeForm({ ...form, port: value ?? 22 })} />
          </Form.Item>
        </div>
        <Form.Item label="用户名" required>
          <Input value={form.username} onChange={(event) => onChangeForm({ ...form, username: event.target.value })} />
        </Form.Item>
        <Form.Item label="认证方式">
          <Radio.Group
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
            <Form.Item label="私钥文件" required extra="支持 OpenSSH / PEM 私钥；私钥内容只在连接时读取，不会写入数据库。">
              <div className="private-key-picker">
                <Input
                  value={form.private_key_path}
                  placeholder="例如 ~/.ssh/id_ed25519"
                  onChange={(event) => onChangeForm({ ...form, private_key_path: event.target.value })}
                />
                <Button onClick={() => {
                  void window.terminalApi.pickPrivateKey(form.private_key_path).then((selected) => {
                    if (selected) onChangeForm({ ...form, private_key_path: selected });
                  });
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
