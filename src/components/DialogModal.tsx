import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Modal } from 'antd';
import type { DialogResult, DialogState } from '../hooks/useDialog';

type DialogModalProps = {
  dialog: DialogState | null;
  dialogInput: string;
  showDialogPassword: boolean;
  capsLockOn: boolean;
  dialogRemember: boolean;
  onChangeInput: (value: string) => void;
  onSetShowDialogPassword: (show: boolean) => void;
  onSetCapsLockOn: (on: boolean) => void;
  onSetDialogRemember: (remember: boolean) => void;
  onClose: (value: DialogResult) => void;
};

export const DialogModal = (props: DialogModalProps) => {
  const {
    dialog,
    dialogInput,
    showDialogPassword,
    capsLockOn,
    dialogRemember,
    onChangeInput,
    onSetShowDialogPassword,
    onSetCapsLockOn,
    onSetDialogRemember,
    onClose,
  } = props;
  if (!dialog) return null;

  const submit = () => {
    if (dialog.type === 'confirm') onClose(true);
    else if (dialog.type === 'prompt') {
      onClose(dialog.rememberOption
        ? { value: dialogInput, remember: dialogRemember }
        : dialog.inputType === 'password' ? dialogInput : dialogInput.trim());
    } else onClose(undefined);
  };

  return (
    <Modal
      open
      title={dialog.title}
      centered
      width={480}
      mask={{ closable: false }}
      closable={false}
      footer={[
        dialog.type !== 'alert' && <Button key="cancel" onClick={() => onClose(dialog.type === 'confirm' ? false : null)}>取消</Button>,
        <Button key="confirm" type="primary" danger={dialog.confirmDanger} onClick={submit}>
          {dialog.confirmText || '确定'}
        </Button>,
      ]}
    >
      <div className="dialog-message">{dialog.message}</div>
      {dialog.type === 'prompt' && (
        <>
          <Input
            autoFocus
            type={dialog.inputType === 'password' && !showDialogPassword ? 'password' : 'text'}
            value={dialogInput}
            onChange={(event) => onChangeInput(event.target.value)}
            onKeyDown={(event) => {
              if (dialog.inputType === 'password') onSetCapsLockOn(event.getModifierState('CapsLock'));
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') onClose(null);
            }}
            onKeyUp={(event) => dialog.inputType === 'password' && onSetCapsLockOn(event.getModifierState('CapsLock'))}
            onBlur={() => onSetCapsLockOn(false)}
            suffix={dialog.inputType === 'password' ? (
              <Button
                type="text"
                size="small"
                icon={showDialogPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => onSetShowDialogPassword(!showDialogPassword)}
              />
            ) : null}
          />
          {dialog.inputType === 'password' && <div className={`caps-tip ${capsLockOn ? 'on' : ''}`}>Caps Lock：{capsLockOn ? '开' : '关'}</div>}
          {dialog.rememberOption && (
            <Checkbox className="dialog-remember-option" checked={dialogRemember} onChange={(event) => onSetDialogRemember(event.target.checked)}>
              {dialog.rememberOption.label}
            </Checkbox>
          )}
        </>
      )}
    </Modal>
  );
};
