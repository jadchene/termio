type TransferProgress = {
  totalCount: number;
  completedCount: number;
  transferred: number;
  total: number;
};

type CompletedTransferProgress = TransferProgress & {
  percent: number;
};

export const sftpTransferBatchKey = (sessionId: number, batchId: string): string => `${sessionId}:${batchId}`;

export const calculateSftpTransferPercent = (progress: TransferProgress): number => {
  const ratio = progress.totalCount > 1
    ? progress.completedCount / progress.totalCount
    : progress.total > 0
      ? progress.transferred / progress.total
      : 0;
  return Math.min(100, Number((ratio * 100).toFixed(1)));
};

export const finalizeSftpTransferProgress = (progress: TransferProgress): CompletedTransferProgress => ({
  ...progress,
  completedCount: progress.totalCount,
  transferred: progress.total > 0 ? progress.total : progress.transferred,
  percent: 100,
});
