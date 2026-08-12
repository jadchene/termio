import { Button, Form, Input, Modal, TreeSelect } from 'antd';
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
  onConfirm: () => Promise<void>;
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

  return (
    <Modal
      open={show}
      title="新建目录"
      centered
      mask={{ closable: false }}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="confirm" type="primary" onClick={() => void onConfirm()}>确认</Button>,
      ]}
    >
      <Form layout="vertical" colon={false}>
        <Form.Item label="名称" required>
          <Input autoFocus value={folderName} onChange={(event) => onChangeName(event.target.value)} onPressEnter={() => void onConfirm()} />
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
