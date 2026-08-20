import { RemoteMetricsPayload } from './types';
import {
  sshStateMap,
  remoteMetricsSnapshotMap,
  remoteMetricsPayloadMap,
  METRICS_NETWORK_SAMPLE_INTERVAL_MS,
  METRICS_SLOW_SAMPLE_INTERVAL_MS,
  sharedState,
} from './state';
import { safeSend } from './window';
import { CappedMetricsOutput } from './metricsOutput';
import {
  parseCpu,
  parseBlockDevices,
  parseCpuFrequencyMhz,
  parseCpuMaxFrequencyMhz,
  parseDnsServers,
  parseGpu,
  parseGpuDriverInfo,
  parseMem,
  parseNetworkRoute,
  parseProcesses,
  normalizeProcessCpuPercent,
  parseSystemInfo,
  parseUptimeSeconds,
} from './metricsParsers';
import { buildMetricsCommand } from './metricsCommand';

export { parseCpu, parseMem } from './metricsParsers';

let lastSlowSampleAt = 0;
let lastNetworkSampleAt = 0;
let metricsSequence = 0;
let immediateCollectionPending = false;

const emptyPayload = (sessionId: number | null, stale: boolean): RemoteMetricsPayload => ({
  sessionId,
  sequence: ++metricsSequence,
  stale,
  sampledAt: Date.now(),
  system: { version: '', arch: '', kernelVersion: '', uptimeSeconds: 0 },
  cpu: 0,
  cpuName: '',
  cpuPhysicalCores: 0,
  cpuLogicalCores: 0,
  cpuFrequencyMhz: 0,
  cpuMaxFrequencyMhz: 0,
  cpuTemp: null,
  memory: { usedGb: 0, totalGb: 0, percent: 0, swapUsedGb: 0, swapTotalGb: 0 },
  network: { upload: 0, download: 0, ips: [], interfaceName: '', gateway: '', dns: [] },
  disk: {
    totalGb: 0,
    usedGb: 0,
    percent: 0,
    upload: 0,
    download: 0,
    ssdCount: 0,
    ssdTotalGb: 0,
    hddCount: 0,
    hddTotalGb: 0,
  },
  gpu: { available: false, driverVersion: '', cudaVersion: '', items: [] },
  processes: [],
});

const collectAndSendMetrics = async (queueIfBusy = false): Promise<boolean> => {
  if (!sharedState.mainWindow || sharedState.mainWindow.isDestroyed()) return false;
  if (sharedState.metricsCollecting) {
    if (queueIfBusy) immediateCollectionPending = true;
    return false;
  }
  sharedState.metricsCollecting = true;
  let sampledSessionId: number | null = null;
  try {
    if (!sharedState.metricsSessionId || !sshStateMap.has(sharedState.metricsSessionId)) {
      if (!sharedState.metricsInactiveSent) {
        safeSend('system:metrics', emptyPayload(null, false));
        sharedState.metricsInactiveSent = true;
      }
      return true;
    }
    const now = Date.now();
    sampledSessionId = sharedState.metricsSessionId;
    const hasCachedPayload = remoteMetricsPayloadMap.has(sampledSessionId);
    const includeSlowSample = !hasCachedPayload || now - lastSlowSampleAt >= METRICS_SLOW_SAMPLE_INTERVAL_MS;
    const includeNetworkSample = !hasCachedPayload
      || now - lastNetworkSampleAt >= METRICS_NETWORK_SAMPLE_INTERVAL_MS;
    const payload = await collectRemoteMetrics(
      sampledSessionId,
      { includeSlowSample, includeNetworkSample },
      ++metricsSequence,
    );
    safeSend('system:metrics', payload);
    if (includeSlowSample) lastSlowSampleAt = now;
    if (includeNetworkSample) lastNetworkSampleAt = now;
    sharedState.metricsInactiveSent = false;
    return true;
  } catch {
    if (!sharedState.metricsInactiveSent) {
      const cached = sampledSessionId ? remoteMetricsPayloadMap.get(sampledSessionId) : undefined;
      safeSend(
        'system:metrics',
        cached
          ? { ...cached, sequence: ++metricsSequence, stale: true }
          : emptyPayload(sampledSessionId, true),
      );
      sharedState.metricsInactiveSent = true;
    }
    return false;
  } finally {
    sharedState.metricsCollecting = false;
    if (immediateCollectionPending) {
      immediateCollectionPending = false;
      void collectAndSendMetrics();
    }
  }
};

export const requestMetricsCollection = async (): Promise<boolean> => collectAndSendMetrics(true);

export function subscribeMetrics() {
  sharedState.metricsTimer = setInterval(() => {
    void collectAndSendMetrics();
  }, 1000);
}

export function parseCpuInfo(lines: string[]): {
  name: string;
  physicalCores: number;
  logicalCores: number;
  mhz: number;
} {
  let logicalCores = 0;
  let name = '';
  let physicalId = '';
  let coreId = '';
  const physicalCoreIds = new Set<string>();
  const mhzValues: number[] = [];
  const looksLikeCpuName = (input: string) => /[a-zA-Z\u4e00-\u9fa5]/.test(String(input || '').trim());
  const commitPhysicalCore = () => {
    if (coreId) {
      physicalCoreIds.add(`${physicalId || '0'}:${coreId}`);
    }
    physicalId = '';
    coreId = '';
  };
  for (const line of lines) {
    if (!line.trim()) {
      commitPhysicalCore();
      continue;
    }
    const matched = line.match(/:\s*(.+)$/);
    const lineKey = line.split(':')[0]?.trim().toLowerCase() || '';
    const lineValue = matched?.[1]?.trim() || '';
    if (!name && lineValue && looksLikeCpuName(lineValue)) {
      if (
        lineKey === 'model name' ||
        lineKey === 'hardware' ||
        lineKey === 'cpu' ||
        lineKey === 'model'
      ) {
        name = lineValue;
      } else if (lineKey === 'processor') {
        // Some ARM distros may put a textual CPU name in "processor".
        name = lineValue;
      }
    }
    if (lineKey === 'processor') {
      logicalCores += 1;
    }
    if (lineKey === 'physical id') {
      physicalId = lineValue;
    }
    if (lineKey === 'core id') {
      coreId = lineValue;
    }
    if (lineKey === 'cpu mhz' || lineKey === 'clock') {
      const parsed = Number(lineValue.replace(/[^0-9.]/g, '')) || 0;
      if (parsed > 0) {
        mhzValues.push(parsed);
      }
    }
  }
  commitPhysicalCore();
  const mhz = mhzValues.length > 0 ? mhzValues.reduce((acc, n) => acc + n, 0) / mhzValues.length : 0;
  return {
    name,
    physicalCores: physicalCoreIds.size,
    logicalCores,
    mhz: Number(mhz.toFixed(0)),
  };
}

export function parseNet(lines: string[]): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    if (!line.includes(':')) continue;
    const [ifaceRaw, rest] = line.split(':');
    const iface = ifaceRaw.trim();
    if (iface === 'lo') continue;
    const fields = rest.trim().split(/\s+/).map((x) => Number(x) || 0);
    rx += fields[0] || 0;
    tx += fields[8] || 0;
  }
  return { rx, tx };
}

export function parseDisk(lines: string[]): { readBytes: number; writeBytes: number } {
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 11) continue;
    const name = f[2];
    if (!/^sd[a-z]+$|^vd[a-z]+$|^xvd[a-z]+$|^nvme\d+n\d+$/.test(name)) continue;
    readSectors += Number(f[5]) || 0;
    writeSectors += Number(f[9]) || 0;
  }
  return { readBytes: readSectors * 512, writeBytes: writeSectors * 512 };
}

export function parseFsUsage(lines: string[]): { total: number; used: number; percent: number } {
  let total = 0;
  let used = 0;
  const seenFs = new Set<string>();
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.toLowerCase().startsWith('filesystem')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 6) continue;
    const fsName = fields[0];
    // Keep persistent block devices, skip temporary/virtual mounts.
    if (!fsName.startsWith('/dev/')) continue;
    if (seenFs.has(fsName)) continue;
    seenFs.add(fsName);
    total += Number(fields[1]) || 0;
    used += Number(fields[2]) || 0;
  }
  const percent = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;
  return { total, used, percent };
}

export function parseCpuInfoFromLscpu(lines: string[]): { name: string; mhz: number } {
  let name = '';
  let mhz = 0;
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || !line.includes(':')) continue;
    const [k, ...rest] = line.split(':');
    const key = String(k || '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (!name && (key === 'model name' || key === 'model' || key === 'cpu')) {
      if (/[a-zA-Z\u4e00-\u9fa5]/.test(value)) {
        name = value;
      }
    }
    if (!mhz && (key === 'cpu mhz' || key === 'cpu max mhz' || key === 'max mhz' || key.includes('mhz'))) {
      const parsed = Number(value.replace(/[^0-9.]/g, '')) || 0;
      if (parsed > 0) mhz = parsed;
    }
  }
  return { name, mhz: Number(mhz.toFixed(0)) };
}

export function parseCoreCount(lines: string[]): number {
  const first = lines.find((line) => /^cpu\(s\)\s*:/i.test(String(line || '').trim()));
  if (!first) return 0;
  const value = String(first).split(':').slice(1).join(':').trim();
  return Number(value.replace(/[^0-9]/g, '')) || 0;
}

export const parsePhysicalCoreCount = (lines: string[]): number => {
  let coresPerSocket = 0;
  let sockets = 0;
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line.includes(':')) continue;
    const [keyRaw, ...valueParts] = line.split(':');
    const key = keyRaw.trim().toLowerCase();
    const value = Number(valueParts.join(':').trim().replace(/[^0-9]/g, '')) || 0;
    if (key === 'core(s) per socket') coresPerSocket = value;
    if (key === 'socket(s)') sockets = value;
  }
  return coresPerSocket > 0 && sockets > 0 ? coresPerSocket * sockets : 0;
};

export function parseCpuTemp(lines: string[]): number | null {
  // Hwmon device names known to carry CPU package temperature.
  const CPU_HWMON_NAMES = new Set(['coretemp', 'k10temp', 'cpu_thermal', 'acpitz', 'zenpower']);
  // Labels that indicate a package-level (not per-core) reading.
  const PACKAGE_LABELS = ['package', 'tctl', 'tdie', 'physical', 'cpu'];

  type DeviceTemps = { name: string; temps: Array<{ label: string; value: number }> };
  const devices: DeviceTemps[] = [];
  let current: DeviceTemps | null = null;

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    if (line.startsWith('NAME:')) {
      const name = line.slice(5).trim().toLowerCase();
      current = { name, temps: [] };
      devices.push(current);
      continue;
    }
    if (line.startsWith('T:') && current) {
      const rest = line.slice(2);
      const colon = rest.indexOf(':');
      const label = colon >= 0 ? rest.slice(0, colon).trim().toLowerCase() : '';
      const valStr = colon >= 0 ? rest.slice(colon + 1).trim() : rest.trim();
      const value = Number(valStr) || 0;
      if (value > 0) {
        current.temps.push({ label, value });
      }
    }
  }

  // Prefer cpu-specific devices, then fall back to any device.
  const cpuDevice =
    devices.find((d) => CPU_HWMON_NAMES.has(d.name) && d.temps.length > 0) ||
    devices.find((d) => d.temps.length > 0);

  if (!cpuDevice) return null;

  // Look for a package-level reading.
  for (const label of PACKAGE_LABELS) {
    const match = cpuDevice.temps.find((t) => t.label.includes(label));
    if (match) return Number((match.value / 1000).toFixed(1));
  }

  // Fallback: first reading from the CPU device.
  return Number((cpuDevice.temps[0].value / 1000).toFixed(1));
}

export function parseIps(lines: string[]): string[] {
  const text = lines.join(' ');
  const matched = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  const unique = Array.from(new Set(matched.filter((ip) => ip !== '127.0.0.1')));
  return unique.length > 0 ? [unique[0]] : [];
}

export function execOnSession(
  sessionId: number,
  command: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  const state = sshStateMap.get(sessionId);
  if (!state) {
    return Promise.reject(new Error('SSH 未连接'));
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    let settled = false;
    let channel: { close?: () => void } | null = null;
    const finish = (error?: Error, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      channel?.close?.();
      finish(new Error(`远程指标采集超时（${timeoutMs}ms）`));
    }, timeoutMs);
    state.client.exec(command, (err, stream) => {
      if (err) {
        finish(err);
        return;
      }
      channel = stream;
      const output = new CappedMetricsOutput(maxOutputBytes);
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        try {
          output.append(chunk);
        } catch (error) {
          stream.close();
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      stream.stderr.on('data', () => undefined);
      stream.on('close', () => {
        finish(undefined, output.toString());
      });
    });
  });
}

export async function collectRemoteMetrics(
  sessionId: number,
  options: { includeSlowSample?: boolean; includeNetworkSample?: boolean } = {},
  sequence = 0,
): Promise<RemoteMetricsPayload> {
  const cachedPayload = remoteMetricsPayloadMap.get(sessionId);
  const shouldSampleStatic = !cachedPayload;
  const shouldSampleSlow = !!options.includeSlowSample || shouldSampleStatic;
  const shouldSampleNetwork = !!options.includeNetworkSample || shouldSampleStatic;
  const script = buildMetricsCommand({
    includeStatic: shouldSampleStatic,
    includeSlow: shouldSampleSlow,
    includeNetwork: shouldSampleNetwork,
  });

  const output = await execOnSession(sessionId, script, {
    timeoutMs: 5000,
    maxOutputBytes: shouldSampleStatic || shouldSampleSlow ? 1024 * 1024 : 256 * 1024,
  });
  const lines = output.split(/\r?\n/);
  const section: Record<string, string[]> = {
    CPU: [],
    BLOCKDEV: [],
    CPUINFO: [],
    LSCPU: [],
    CPUFREQ: [],
    CPUFREQMAX: [],
    CPUTEMP: [],
    SYS: [],
    MEM: [],
    IP: [],
    NET: [],
    DISK: [],
    FS: [],
    NETROUTE: [],
    DNS: [],
    GPUINFO: [],
    GPU: [],
    UPTIME: [],
    PROCESSES_CPU: [],
    PROCESSES_MEMORY: [],
  };
  let current: keyof typeof section | null = null;
  for (const line of lines) {
    if (line === '__CPU__') current = 'CPU';
    else if (line === '__BLOCKDEV__') current = 'BLOCKDEV';
    else if (line === '__CPUINFO__') current = 'CPUINFO';
    else if (line === '__LSCPU__') current = 'LSCPU';
    else if (line === '__CPUFREQ__') current = 'CPUFREQ';
    else if (line === '__CPUFREQMAX__') current = 'CPUFREQMAX';
    else if (line === '__CPUTEMP__') current = 'CPUTEMP';
    else if (line === '__SYS__') current = 'SYS';
    else if (line === '__MEM__') current = 'MEM';
    else if (line === '__IP__') current = 'IP';
    else if (line === '__NET__') current = 'NET';
    else if (line === '__DISK__') current = 'DISK';
    else if (line === '__FS__') current = 'FS';
    else if (line === '__NETROUTE__') current = 'NETROUTE';
    else if (line === '__DNS__') current = 'DNS';
    else if (line === '__GPUINFO__') current = 'GPUINFO';
    else if (line === '__GPU__') current = 'GPU';
    else if (line === '__UPTIME__') current = 'UPTIME';
    else if (line === '__PROCESSES_CPU__') current = 'PROCESSES_CPU';
    else if (line === '__PROCESSES_MEMORY__') current = 'PROCESSES_MEMORY';
    else if (current) section[current].push(line);
  }

  const cpuLine = section.CPU[0] || '';
  const cpuStat = parseCpu(cpuLine);
  const cpuInfo = parseCpuInfo(section.CPUINFO);
  const cpuInfoLscpu = parseCpuInfoFromLscpu(section.LSCPU);
  const cpuLogicalCoreCount = cpuInfo.logicalCores || parseCoreCount(section.LSCPU);
  const detectedPhysicalCoreCount = cpuInfo.physicalCores || parsePhysicalCoreCount(section.LSCPU);
  const cpuPhysicalCoreCount = detectedPhysicalCoreCount > 0 && detectedPhysicalCoreCount <= cpuLogicalCoreCount
    ? detectedPhysicalCoreCount
    : 0;
  const systemInfo = parseSystemInfo(section.SYS);
  systemInfo.uptimeSeconds = parseUptimeSeconds(section.UPTIME, cachedPayload?.system.uptimeSeconds || 0);
  const memStat = parseMem(section.MEM);
  const networkRoute = parseNetworkRoute(section.NETROUTE);
  const fallbackIps = parseIps(section.IP);
  const ips = networkRoute.ip ? [networkRoute.ip] : fallbackIps;
  const dns = parseDnsServers(section.DNS);
  const netStat = parseNet(section.NET);
  const diskStat = parseDisk(section.DISK);
  const fsUsage = parseFsUsage(section.FS);
  const parsedBlockDevices = parseBlockDevices(section.BLOCKDEV);

  const now = Date.now();
  const prev = remoteMetricsSnapshotMap.get(sessionId);
  let cpu = 0;
  let netDownload = 0;
  let netUpload = 0;
  let diskRead = 0;
  let diskWrite = 0;

  if (prev) {
    const totalDelta = cpuStat.total - prev.cpuTotal;
    const idleDelta = cpuStat.idle - prev.cpuIdle;
    cpu = totalDelta > 0 ? Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1)) : 0;
    const sec = Math.max((now - prev.at) / 1000, 0.001);
    netDownload = Math.max((netStat.rx - prev.netRx) / sec, 0);
    netUpload = Math.max((netStat.tx - prev.netTx) / sec, 0);
    diskRead = Math.max((diskStat.readBytes - prev.diskReadBytes) / sec, 0);
    diskWrite = Math.max((diskStat.writeBytes - prev.diskWriteBytes) / sec, 0);
  }

  remoteMetricsSnapshotMap.set(sessionId, {
    cpuTotal: cpuStat.total,
    cpuIdle: cpuStat.idle,
    netRx: netStat.rx,
    netTx: netStat.tx,
    diskReadBytes: diskStat.readBytes,
    diskWriteBytes: diskStat.writeBytes,
    at: now,
  });

  const memUsed = Math.max(memStat.total - memStat.available, 0);
  const swapUsed = Math.max(memStat.swapTotal - memStat.swapFree, 0);
  const staticSystem = systemInfo.version || systemInfo.arch || systemInfo.kernelVersion
    ? systemInfo
    : (cachedPayload?.system || { version: '', arch: '', kernelVersion: '', uptimeSeconds: 0 });
  const system = { ...staticSystem, uptimeSeconds: systemInfo.uptimeSeconds };
  const cpuName =
    cpuInfo.name || cpuInfoLscpu.name || cachedPayload?.cpuName || (system.arch ? `CPU (${system.arch})` : 'CPU');
  const cpuLogicalCores = cpuLogicalCoreCount || cachedPayload?.cpuLogicalCores || 0;
  const cpuPhysicalCores = cpuPhysicalCoreCount || cachedPayload?.cpuPhysicalCores || 0;
  const cpuFrequencyMhz = parseCpuFrequencyMhz(section.CPUFREQ)
    || cpuInfo.mhz
    || cpuInfoLscpu.mhz
    || cachedPayload?.cpuFrequencyMhz
    || 0;
  const cpuMaxFrequencyMhz = parseCpuMaxFrequencyMhz(section.CPUFREQMAX)
    || cachedPayload?.cpuMaxFrequencyMhz
    || 0;
  const memoryTotalGb = memStat.total
    ? Number((memStat.total / 1024 / 1024 / 1024).toFixed(2))
    : (cachedPayload?.memory.totalGb || 0);
  const diskTotalGb = fsUsage.total
    ? Number((fsUsage.total / 1024 / 1024 / 1024).toFixed(2))
    : (cachedPayload?.disk.totalGb || 0);
  const diskUsedGb = fsUsage.used
    ? Number((fsUsage.used / 1024 / 1024 / 1024).toFixed(2))
    : (cachedPayload?.disk.usedGb || 0);
  const diskPercent = fsUsage.total
    ? Number(fsUsage.percent.toFixed(1))
    : (cachedPayload?.disk.percent || 0);
  const blockDevices = section.BLOCKDEV.length > 0
    ? parsedBlockDevices
    : {
        ssdCount: cachedPayload?.disk.ssdCount || 0,
        ssdBytes: (cachedPayload?.disk.ssdTotalGb || 0) * 1024 * 1024 * 1024,
        hddCount: cachedPayload?.disk.hddCount || 0,
        hddBytes: (cachedPayload?.disk.hddTotalGb || 0) * 1024 * 1024 * 1024,
      };
  const cpuTemp = section.CPUTEMP.length > 0
    ? parseCpuTemp(section.CPUTEMP)
    : (cachedPayload?.cpuTemp ?? null);
  const gpuDriverInfo = parseGpuDriverInfo(section.GPUINFO);
  const sampledGpu = section.GPU.length > 0
    ? parseGpu(section.GPU)
    : (cachedPayload?.gpu || { available: false, driverVersion: '', cudaVersion: '', items: [] });
  const gpu = ({
    ...sampledGpu,
    driverVersion: gpuDriverInfo.driverVersion || cachedPayload?.gpu.driverVersion || '',
    cudaVersion: gpuDriverInfo.cudaVersion || cachedPayload?.gpu.cudaVersion || '',
  } as RemoteMetricsPayload['gpu']);
  const processes = section.PROCESSES_CPU.length > 0 || section.PROCESSES_MEMORY.length > 0
    ? parseProcesses(section.PROCESSES_CPU, section.PROCESSES_MEMORY).map((process) => ({
        ...process,
        cpuPercent: normalizeProcessCpuPercent(process.cpuPercent, cpuLogicalCores),
      }))
    : (cachedPayload?.processes || []);

  const payload: RemoteMetricsPayload = {
    sessionId,
    sequence,
    stale: false,
    sampledAt: now,
    system,
    cpu,
    cpuName,
    cpuPhysicalCores,
    cpuLogicalCores,
    cpuFrequencyMhz,
    cpuMaxFrequencyMhz,
    cpuTemp,
    memory: {
      usedGb: Number((memUsed / 1024 / 1024 / 1024).toFixed(2)),
      totalGb: memoryTotalGb,
      percent: memStat.total ? Number(((memUsed / memStat.total) * 100).toFixed(1)) : (cachedPayload?.memory.percent || 0),
      swapUsedGb: Number((swapUsed / 1024 / 1024 / 1024).toFixed(2)),
      swapTotalGb: Number((memStat.swapTotal / 1024 / 1024 / 1024).toFixed(2)),
    },
    network: {
      upload: Number(netUpload.toFixed(0)),
      download: Number(netDownload.toFixed(0)),
      ips: ips.length > 0 ? ips : (cachedPayload?.network.ips || []),
      interfaceName: networkRoute.interfaceName || cachedPayload?.network.interfaceName || '',
      gateway: networkRoute.gateway || cachedPayload?.network.gateway || '',
      dns: dns.length > 0 ? dns : (cachedPayload?.network.dns || []),
    },
    disk: {
      totalGb: diskTotalGb,
      usedGb: diskUsedGb,
      percent: diskPercent,
      upload: Number(diskWrite.toFixed(0)),
      download: Number(diskRead.toFixed(0)),
      ssdCount: blockDevices.ssdCount,
      ssdTotalGb: Number((blockDevices.ssdBytes / 1024 / 1024 / 1024).toFixed(2)),
      hddCount: blockDevices.hddCount,
      hddTotalGb: Number((blockDevices.hddBytes / 1024 / 1024 / 1024).toFixed(2)),
    },
    gpu,
    processes,
  };
  remoteMetricsPayloadMap.set(sessionId, payload);
  return payload;
}
