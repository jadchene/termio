import { useRef, useState } from 'react';
import type { SftpTransferBatchResult, SftpTransferError, SftpTransferProgress } from '../types';
import { formatSftpError } from '../utils/sftpError';
import { calculateSftpTransferPercent, finalizeSftpTransferProgress, sftpTransferBatchKey } from '../utils/sftpTransferProgress';

export type TransferRow = {
  key: string;
  batchId: string;
  sessionId: number;
  direction: 'upload' | 'download';
  index: number;
  totalCount: number;
  completedCount: number;
  name: string;
  percent: number;
  transferred: number;
  total: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
};

type UseTransferQueueParams = {
  showAlert: (message: string, title?: string) => Promise<void>;
  cancelBatch: (payload: { sessionId: number; batchId: string }) => Promise<boolean>;
};

export function useTransferQueue(params: UseTransferQueueParams) {
  const { showAlert, cancelBatch } = params;
  const [transferRows, setTransferRows] = useState<TransferRow[]>([]);
  const cancelledTransferBatchRef = useRef<Set<string>>(new Set());
  const transferErrorsRef = useRef<Map<string, SftpTransferError[]>>(new Map());

  const normalizeRunningStatus = (status: TransferRow['status']): TransferRow['status'] =>
    status === 'cancelled' || status === 'error' ? status : 'running';

  const updateTransferRow = (event: SftpTransferProgress) => {
    const batchKey = sftpTransferBatchKey(event.sessionId, event.batchId);
    if (cancelledTransferBatchRef.current.has(batchKey)) return;
    const key = batchKey;
    const percent = calculateSftpTransferPercent(event);
    setTransferRows((prev) => {
      const found = prev.find((it) => it.key === key);
      if (found) {
        const mapped: TransferRow[] = prev.map((it) =>
          it.key === key
            ? {
                ...it,
                batchId: event.batchId,
                name: event.name,
                index: event.index,
                totalCount: event.totalCount,
                completedCount: event.completedCount,
                percent,
                transferred: event.transferred,
                total: event.total,
                status: normalizeRunningStatus(it.status),
              }
            : it,
        );
        return mapped;
      }
      const nextRow: TransferRow = {
        key,
        batchId: event.batchId,
        sessionId: event.sessionId,
        direction: event.direction,
        index: event.index,
        totalCount: event.totalCount,
        completedCount: event.completedCount,
        name: event.name,
        percent,
        transferred: event.transferred,
        total: event.total,
        status: 'running',
      };
      return [nextRow, ...prev].slice(0, 12);
    });
  };

  const markTransferBatchComplete = async (event: SftpTransferBatchResult) => {
    const batchKey = sftpTransferBatchKey(event.sessionId, event.batchId);
    const failedItems = transferErrorsRef.current.get(batchKey) || [];
    transferErrorsRef.current.delete(batchKey);
    if (cancelledTransferBatchRef.current.has(batchKey)) {
      cancelledTransferBatchRef.current.delete(batchKey);
      setTransferRows((prev) => prev.filter((it) => !(it.sessionId === event.sessionId && it.batchId === event.batchId)));
      return;
    }
    if (event.cancelled) {
      setTransferRows((prev) =>
        prev.map((it) =>
          it.sessionId === event.sessionId && it.batchId === event.batchId
            ? { ...it, status: 'cancelled', name: '已取消', percent: Math.min(it.percent, 99) }
            : it,
        ),
      );
      setTimeout(() => {
        setTransferRows((prev) => prev.filter((it) => !(it.sessionId === event.sessionId && it.batchId === event.batchId)));
      }, 1200);
      return;
    }
    if (event.failedCount > 0) {
      setTransferRows((prev) => prev.filter((it) => !(it.sessionId === event.sessionId && it.batchId === event.batchId)));
      const actionText = event.direction === 'upload' ? '上传' : '下载';
      const lines = failedItems.slice(0, 8).map((it, idx) =>
        `${idx + 1}. ${it.name}: ${formatSftpError({ code: it.errorCode, message: it.error })}`,
      );
      const remain = Math.max(0, failedItems.length - lines.length);
      const details = lines.length > 0 ? `\n\n失败明细:\n${lines.join('\n')}` : '';
      const more = remain > 0 ? `\n... 另有 ${remain} 个失败项` : '';
      await showAlert(
        `${actionText}完成，但有失败文件。\n成功 ${event.successCount} / 总计 ${event.totalCount}，失败 ${event.failedCount}${details}${more}`,
        'SFTP 传输结果',
      );
      return;
    }
    setTransferRows((prev) =>
      prev.map((it) => {
        if (it.sessionId !== event.sessionId || it.batchId !== event.batchId) return it;
        return {
          ...it,
          ...finalizeSftpTransferProgress(it),
          status: 'done',
        };
      }),
    );
    setTimeout(() => {
      setTransferRows((prev) => prev.filter((it) => !(it.sessionId === event.sessionId && it.batchId === event.batchId)));
    }, 900);
  };

  const markTransferError = (event: SftpTransferError) => {
    const batchKey = sftpTransferBatchKey(event.sessionId, event.batchId);
    if (cancelledTransferBatchRef.current.has(batchKey)) return;
    const list = transferErrorsRef.current.get(batchKey) || [];
    if (list.length < 50) {
      list.push(event);
      transferErrorsRef.current.set(batchKey, list);
    }
    setTransferRows((prev) =>
      prev.map((it) => (it.sessionId === event.sessionId && it.batchId === event.batchId ? { ...it, status: 'error' } : it)),
    );
  };

  const cancelTransferRow = async (row: TransferRow) => {
    if (row.status !== 'running') {
      setTransferRows((prev) => prev.filter((it) => !(it.sessionId === row.sessionId && it.batchId === row.batchId)));
      return;
    }
    const batchKey = sftpTransferBatchKey(row.sessionId, row.batchId);
    cancelledTransferBatchRef.current.add(batchKey);
    transferErrorsRef.current.delete(batchKey);
    if (cancelledTransferBatchRef.current.size > 200) {
      cancelledTransferBatchRef.current.clear();
      cancelledTransferBatchRef.current.add(batchKey);
    }
    setTransferRows((prev) => prev.filter((it) => !(it.sessionId === row.sessionId && it.batchId === row.batchId)));
    const ok = await cancelBatch({ sessionId: row.sessionId, batchId: row.batchId }).catch(() => false);
    if (!ok) {
      cancelledTransferBatchRef.current.delete(batchKey);
      await showAlert('取消传输失败，请重试', 'SFTP');
    }
  };

  return {
    transferRows,
    updateTransferRow,
    markTransferBatchComplete,
    markTransferError,
    cancelTransferRow,
  };
}
