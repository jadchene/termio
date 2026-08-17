import { useCallback, useEffect, useRef, useState } from 'react';
import { createSequentialQueue } from '../utils/sequentialQueue';

type DialogType = 'alert' | 'confirm' | 'prompt';
type ConfirmDialogOptions = {
  confirmText?: string;
  confirmDanger?: boolean;
};
export type PasswordPromptResult = { value: string; remember: boolean };
export type DialogResult = boolean | string | PasswordPromptResult | null | void;
export type DialogState = {
  type: DialogType;
  title: string;
  message: string;
  defaultValue?: string;
  inputType?: 'text' | 'password';
  rememberOption?: { label: string; defaultValue: boolean };
  confirmText?: string;
  confirmDanger?: boolean;
  requestKey?: string;
};

export function useDialog() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogInput, setDialogInput] = useState('');
  const [showDialogPassword, setShowDialogPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [dialogRemember, setDialogRemember] = useState(false);
  const dialogQueueRef = useRef(createSequentialQueue<DialogState, DialogResult>());

  const showDialog = useCallback((next: DialogState) => {
    setDialogInput(next.defaultValue || '');
    setShowDialogPassword(false);
    setCapsLockOn(false);
    setDialogRemember(next.rememberOption?.defaultValue ?? false);
    setDialog(next);
  }, []);

  const clearDialog = useCallback(() => {
    setDialog(null);
    setDialogInput('');
    setCapsLockOn(false);
    setShowDialogPassword(false);
    setDialogRemember(false);
  }, []);

  const openDialog = useCallback(<T extends DialogResult>(next: DialogState): Promise<T> => {
    const queued = dialogQueueRef.current.enqueue<T>(next);
    if (queued.activated) showDialog(next);
    return queued.promise;
  }, [showDialog]);

  const closeDialog = useCallback((value: DialogResult) => {
    const next = dialogQueueRef.current.resolveActive(value);
    if (next) {
      showDialog(next);
      return;
    }
    clearDialog();
  }, [clearDialog, showDialog]);

  const cancelDialogRequest = useCallback((requestKey: string, value: DialogResult = null): boolean => {
    const cancelled = dialogQueueRef.current.cancelWhere((item) => item.requestKey === requestKey, value);
    if (cancelled.activeCancelled) {
      if (cancelled.next) showDialog(cancelled.next);
      else clearDialog();
    }
    return cancelled.cancelledCount > 0;
  }, [clearDialog, showDialog]);

  useEffect(() => () => {
    dialogQueueRef.current.cancelAll(null);
  }, []);

  const askConfirm = useCallback(
    async (
      message: string,
      title = '确认',
      requestKey?: string,
      options: ConfirmDialogOptions = {},
    ): Promise<boolean> =>
      openDialog<boolean>({ type: 'confirm', title, message, requestKey, ...options }),
    [openDialog],
  );

  const askPrompt = useCallback(
    async (message: string, defaultValue = '', title = '输入', requestKey?: string): Promise<string | null> =>
      openDialog<string | null>({ type: 'prompt', title, message, defaultValue, inputType: 'text', requestKey }),
    [openDialog],
  );

  const askPassword = useCallback(
    async (message: string, title = '输入密码', requestKey?: string): Promise<string | null> =>
      openDialog<string | null>({ type: 'prompt', title, message, defaultValue: '', inputType: 'password', requestKey }),
    [openDialog],
  );

  const askPasswordWithRemember = useCallback(
    async (
      message: string,
      remember: boolean,
      title = '输入密码',
      requestKey?: string,
    ): Promise<PasswordPromptResult | null> =>
      openDialog<PasswordPromptResult | null>({
        type: 'prompt',
        title,
        message,
        defaultValue: '',
        inputType: 'password',
        rememberOption: { label: '记住密码', defaultValue: remember },
        requestKey,
      }),
    [openDialog],
  );

  const showAlert = useCallback(async (message: string, title = '提示'): Promise<void> => {
    await openDialog<void>({ type: 'alert', title, message });
  }, [openDialog]);

  return {
    dialog,
    dialogInput,
    showDialogPassword,
    capsLockOn,
    dialogRemember,
    setDialogInput,
    setShowDialogPassword,
    setCapsLockOn,
    setDialogRemember,
    closeDialog,
    cancelDialogRequest,
    askConfirm,
    askPrompt,
    askPassword,
    askPasswordWithRemember,
    showAlert,
  };
}
