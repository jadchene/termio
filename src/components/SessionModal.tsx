import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Checkbox, Form, Input, InputNumber, Modal, TreeSelect } from 'antd';
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
        <Form.Item label="密码">
          <Input
            type={!editing && showPassword ? 'text' : 'password'}
            value={form.password}
            onChange={(event) => onChangeForm({ ...form, password: event.target.value })}
            suffix={!editing ? (
              <Button type="text" size="small" icon={showPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={onTogglePassword} />
            ) : null}
          />
        </Form.Item>
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
          <Checkbox checked={form.remember_password === 1} onChange={(event) => onChangeForm({ ...form, remember_password: event.target.checked ? 1 : 0 })}>记住密码</Checkbox>
          <Checkbox checked={form.default_session === 1} onChange={(event) => onChangeForm({ ...form, default_session: event.target.checked ? 1 : 0 })}>默认会话</Checkbox>
        </div>
      </Form>
    </Modal>
  );
};
