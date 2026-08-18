import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Tag } from 'antd';
import type { Metrics } from '../types';

type StatusPanelProps = {
  activeSessionId: number | null;
  currentMetrics: Metrics | null;
};

const formatSpeed = (value: number): string => {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB/s`;
  if (value > 1024) return `${(value / 1024).toFixed(2)} KB/s`;
  return `${value.toFixed(0)} B/s`;
};

const formatCapacity = (valueGb: number): string => {
  const value = Number(valueGb || 0);
  return value >= 1024 ? `${(value / 1024).toFixed(2)} TB` : `${value.toFixed(2)} GB`;
};

const formatUptime = (valueSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(valueSeconds || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return '不足1分钟';
};

const formatFrequency = (valueMhz: number): string => {
  if (!valueMhz) return '--';
  return valueMhz >= 1000 ? `${(valueMhz / 1000).toFixed(2)} GHz` : `${valueMhz.toFixed(0)} MHz`;
};

const formatProcessMemory = (valueBytes: number): string => {
  if (valueBytes >= 1024 * 1024 * 1024) return `${(valueBytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (valueBytes >= 1024 * 1024) return `${(valueBytes / 1024 / 1024).toFixed(0)} MB`;
  return `${Math.max(0, valueBytes / 1024).toFixed(0)} KB`;
};

const renderBreakableValue = (value: string) => value.split(/([./\\_-])/).map((part, index) => (
  <Fragment key={`${index}-${part}`}>
    {part}
    {/^[./\\_-]$/.test(part) ? <wbr /> : null}
  </Fragment>
));

const StatusRow = ({ label, value }: { label: string; value: string }) => (
  <div className="status-kv">
    <span className="status-kv-label">{label}</span>
    <span className="status-kv-value">{value ? renderBreakableValue(value) : '--'}</span>
  </div>
);

const ProcessPanel = ({ items }: { items: Metrics['processes'] }) => {
  const [processSort, setProcessSort] = useState<'cpu' | 'memory'>('cpu');
  const [copiedPid, setCopiedPid] = useState<number | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processes = useMemo(() => [...items]
    .sort((left, right) => (
      processSort === 'cpu'
        ? right.cpuPercent - left.cpuPercent
        : right.memoryBytes - left.memoryBytes
    ))
    .slice(0, 10), [items, processSort]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copyPid = async (pid: number) => {
    const copied = await window.terminalApi.writeClipboardText(String(pid)).catch(() => false);
    if (!copied) return;
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedPid(pid);
    copiedTimerRef.current = setTimeout(() => {
      setCopiedPid(null);
      copiedTimerRef.current = null;
    }, 900);
  };

  return (
    <section className="status-group">
      <h3>进程</h3>
      <div className="process-table">
        <div className="process-header">
          <span>进程</span>
          <button
            type="button"
            className={processSort === 'cpu' ? 'is-active' : ''}
            onClick={() => setProcessSort('cpu')}
          >CPU</button>
          <button
            type="button"
            className={processSort === 'memory' ? 'is-active' : ''}
            onClick={() => setProcessSort('memory')}
          >内存</button>
        </div>
        <div className="process-body">
          {processes.length > 0 ? processes.map((process) => (
            <button
              key={process.pid}
              type="button"
              className="process-row"
              aria-label={`复制进程 ${process.name} 的 PID ${process.pid}`}
              onClick={() => { void copyPid(process.pid); }}
            >
              <span className="process-name">{process.name}</span>
              <span className="process-number">{process.cpuPercent.toFixed(1)}%</span>
              <span className="process-number">{formatProcessMemory(process.memoryBytes)}</span>
              {copiedPid === process.pid && <span className="process-copy-bubble" role="status">已复制</span>}
            </button>
          )) : <div className="process-empty">暂无数据</div>}
        </div>
      </div>
    </section>
  );
};

export const StatusPanel = ({ activeSessionId, currentMetrics }: StatusPanelProps) => {
  if (!activeSessionId || !currentMetrics) {
    return <div className="panel-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无活动会话" /></div>;
  }

  return (
    <div className="status-panel panel-content">
      {currentMetrics.stale && <Tag color="warning">数据已过期</Tag>}
      <section className="status-group">
        <h3>系统</h3>
        <StatusRow label="版本" value={currentMetrics.system.version} />
        <StatusRow label="架构" value={currentMetrics.system.arch} />
        <StatusRow label="内核版本" value={currentMetrics.system.kernelVersion} />
        <StatusRow label="运行时间" value={formatUptime(currentMetrics.system.uptimeSeconds)} />
      </section>
      <section className="status-group">
        <h3>CPU</h3>
        <StatusRow label="名称" value={currentMetrics.cpuName} />
        <StatusRow label="负载" value={`${currentMetrics.cpu}%`} />
        <StatusRow
          label="频率"
          value={`${formatFrequency(currentMetrics.cpuFrequencyMhz)} / ${formatFrequency(currentMetrics.cpuMaxFrequencyMhz)}`}
        />
        <StatusRow label="温度" value={currentMetrics.cpuTemp == null ? '--' : `${currentMetrics.cpuTemp}°C`} />
        <StatusRow label="核心" value={`${currentMetrics.cpuPhysicalCores || '--'}核心/${currentMetrics.cpuLogicalCores || '--'}线程`} />
      </section>
      <section className="status-group">
        <h3>内存</h3>
        <StatusRow label="占用" value={`${formatCapacity(currentMetrics.memory.usedGb)} / ${formatCapacity(currentMetrics.memory.totalGb)}`} />
        <StatusRow label="Swap" value={`${formatCapacity(currentMetrics.memory.swapUsedGb)} / ${formatCapacity(currentMetrics.memory.swapTotalGb)}`} />
      </section>
      <section className="status-group">
        <h3>网络</h3>
        <StatusRow label="IP" value={currentMetrics.network.ips.join(', ') || '--'} />
        <StatusRow label="网卡" value={currentMetrics.network.interfaceName} />
        <StatusRow label="网关" value={currentMetrics.network.gateway} />
        <StatusRow label="DNS" value={currentMetrics.network.dns.join(', ')} />
        <StatusRow label="上传" value={formatSpeed(currentMetrics.network.upload)} />
        <StatusRow label="下载" value={formatSpeed(currentMetrics.network.download)} />
      </section>
      <section className="status-group">
        <h3>硬盘</h3>
        <StatusRow
          label="占用"
          value={currentMetrics.disk.totalGb > 0
            ? `${formatCapacity(currentMetrics.disk.usedGb)} / ${formatCapacity(currentMetrics.disk.totalGb)}`
            : '--'}
        />
        <StatusRow label="写入" value={formatSpeed(currentMetrics.disk.upload)} />
        <StatusRow label="读取" value={formatSpeed(currentMetrics.disk.download)} />
        <StatusRow label="固态" value={`${currentMetrics.disk.ssdCount} 块 / ${formatCapacity(currentMetrics.disk.ssdTotalGb)}`} />
        <StatusRow label="机械" value={`${currentMetrics.disk.hddCount} 块 / ${formatCapacity(currentMetrics.disk.hddTotalGb)}`} />
      </section>
      <section className="status-group">
        <h3>GPU</h3>
        {currentMetrics.gpu.available ? (
          <>
            <div className="gpu-meta">
              <StatusRow label="驱动" value={currentMetrics.gpu.driverVersion} />
              <StatusRow label="CUDA" value={currentMetrics.gpu.cudaVersion} />
            </div>
            {currentMetrics.gpu.items.map((gpu) => (
              <div key={`${gpu.index}-${gpu.name}`} className="gpu-item">
                <StatusRow label={`GPU ${gpu.index}`} value={gpu.name} />
                <StatusRow label="主频" value={gpu.clockMhz == null ? '--' : `${gpu.clockMhz} MHz`} />
                <StatusRow label="温度" value={`${gpu.temperature}°C`} />
                <StatusRow label="显存" value={`${gpu.memoryUsedGb} GB / ${gpu.memoryTotalGb} GB`} />
                <StatusRow label="负载" value={`${gpu.load}%`} />
                <StatusRow label="功耗" value={`${gpu.powerDraw ?? '--'} W / ${gpu.powerLimit ?? '--'} W`} />
              </div>
            ))}
          </>
        ) : <StatusRow label="设备" value="未检测到" />}
      </section>
      <ProcessPanel items={currentMetrics.processes} />
    </div>
  );
};
