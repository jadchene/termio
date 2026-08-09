import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appRoot, rendererDevUrl } from './env';

type TrustedIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

const MAX_IPC_ARGUMENTS = 16;
const MAX_IPC_ARRAY_ITEMS = 1000;
const MAX_IPC_STRING_LENGTH = 1024 * 1024;
const MAX_IPC_DEPTH = 12;

const rendererEntryPath = path.resolve(appRoot, 'dist', 'index.html');

export const isTrustedRendererUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    if (rendererDevUrl && url.origin === rendererDevUrl) return true;
    if (url.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(url)) === rendererEntryPath;
  } catch {
    return false;
  }
};

export const assertTrustedIpcEvent = (event: TrustedIpcEvent): void => {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('已拒绝非主框架 IPC 请求');
  }
  if (!isTrustedRendererUrl(event.senderFrame.url)) {
    throw new Error('已拒绝非受信页面 IPC 请求');
  }
};

export const assertSafeIpcArguments = (args: unknown[]): void => {
  if (args.length > MAX_IPC_ARGUMENTS) throw new Error('IPC 参数数量超过限制');
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_IPC_DEPTH) throw new Error('IPC 参数嵌套层级超过限制');
    if (typeof value === 'string') {
      if (value.length > MAX_IPC_STRING_LENGTH) throw new Error('IPC 字符串参数超过限制');
      return;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return;
    if (Array.isArray(value)) {
      if (value.length > MAX_IPC_ARRAY_ITEMS) throw new Error('IPC 数组参数超过限制');
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 100) throw new Error('IPC 对象字段数量超过限制');
      entries.forEach(([, item]) => visit(item, depth + 1));
      return;
    }
    throw new Error('IPC 参数包含不支持的数据类型');
  };
  args.forEach((argument) => visit(argument, 0));
};

export const registerTrustedHandle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any,
): void => {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcEvent(event);
    assertSafeIpcArguments(args);
    return listener(event, ...args);
  });
};

export const registerTrustedOn = (
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void,
): void => {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcEvent(event);
      assertSafeIpcArguments(args);
      listener(event, ...args);
    } catch (error) {
      console.warn(`[IPC] Rejected ${channel}:`, error);
    }
  });
};
