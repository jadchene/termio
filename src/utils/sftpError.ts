export type SftpErrorCode =
  | 'NOT_CONNECTED'
  | 'CONNECTION_CLOSED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'INVALID_PATH'
  | 'UNKNOWN';

export type SftpErrorPayload = {
  code: SftpErrorCode;
  message: string;
};

export function parseSftpError(error: unknown): SftpErrorPayload {
  if (error && typeof error === 'object') {
    const value = error as Partial<SftpErrorPayload>;
    if (typeof value.code === 'string' && typeof value.message === 'string') {
      return value as SftpErrorPayload;
    }
  }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error || '未知错误') };
}

export function isSilentSftpError(error: unknown): boolean {
  const code = parseSftpError(error).code;
  return code === 'CANCELLED' || code === 'NOT_CONNECTED' || code === 'CONNECTION_CLOSED';
}

export function formatSftpError(error: unknown): string {
  const payload = parseSftpError(error);
  const prefix: Record<SftpErrorCode, string> = {
    NOT_CONNECTED: 'SFTP 未连接',
    CONNECTION_CLOSED: 'SFTP 连接已断开',
    NOT_FOUND: '文件或目录不存在',
    PERMISSION_DENIED: '没有操作权限',
    CONFLICT: '目标已存在或发生冲突',
    CANCELLED: '操作已取消',
    INVALID_PATH: '路径无效',
    UNKNOWN: 'SFTP 操作失败',
  };
  return `${prefix[payload.code]}：${payload.message}`;
}
