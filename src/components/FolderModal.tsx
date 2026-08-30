import { Button, Form, Input, Modal, TreeSelect } from 'antd';
import { useEffect, useState } from 'react';
import type { FolderTreeOption } from '../hooks/useFolderTreeOptions';

type FolderModalProps = {
  show: boolean;
  folderName: string;
  folderParent: number | null;
  folderParentMenuOpen: boolean;
  folderTreeData: FolderTreeOption[];
  onChangeName: (value: string) => void;
  onToggleParentMenu: () => void;
  onPickParent: (folderId: number | null) => void;
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
};

export const FolderModal = (props: FolderModalProps) => {
  const {
    show,
    folderName,
    folderParent,
    folderParentMenuOpen,
    folderTreeData,
    onChangeName,
    onToggleParentMenu,
    onPickParent,
    onCancel,
    onConfirm,
  } = props;
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const missingName = !folderName.trim();

  useEffect(() => {
    if (!show) return;
    setAttempted(false);
    setSaving(false);
  }, [show]);

  const submit = async () => {
    if (saving) return;
    setAttempted(true);
    if (missingName) return;
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
      title="新建目录"
      centered
      mask={{ closable: false }}
      closable={!saving}
      keyboard={!saving}
      onCancel={() => { if (!saving) onCancel(); }}
      footer={[
        <Button key="cancel" disabled={saving} onClick={onCancel}>取消</Button>,
        <Button key="confirm" type="primary" loading={saving} onClick={() => void submit()}>创建</Button>,
      ]}
    >
      <Form layout="vertical" colon={false}>
        <Form.Item label="名称" required validateStatus={attempted && missingName ? 'error' : undefined} help={attempted && missingName ? '请输入目录名称' : undefined}>
          <Input autoFocus value={folderName} onChange={(event) => onChangeName(event.target.value)} onPressEnter={() => void submit()} />
        </Form.Item>
        <Form.Item label="父目录">
          <TreeSelect
            className="folder-select"
            open={folderParentMenuOpen}
            value={folderParent ?? 0}
            treeData={folderTreeData}
            treeDefaultExpandAll
            onOpenChange={(open) => {
              if (open !== folderParentMenuOpen) onToggleParentMenu();
            }}
            onChange={(value) => onPickParent(value === 0 ? null : value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
