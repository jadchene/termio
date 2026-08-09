import { RemoteMetricsPayload } from './types';
import { sshStateMap, remoteMetricsSnapshotMap, remoteMetricsPayloadMap, METRICS_FULL_SAMPLE_INTERVAL_MS, sharedState } from './state';
import { safeSend } from './window';
import { CappedMetricsOutput } from './metricsOutput';
import { parseCpu, parseMem } from './metricsParsers';

export { parseCpu, parseMem } from './metricsParsers';

export function subscribeMetrics() {
  let lastFullSampleAt = 0;
  let metricsSequence = 0;
  const emptyPayload = (sessionId: number | null, stale: boolean): RemoteMetricsPayload => ({
    sessionId,
    sequence: ++metricsSequence,
    stale,
    sampledAt: Date.now(),
    system: { version: '', arch: '' },
    cpu: 0,
    cpuName: '',
    cpuPhysicalCores: 0,
    cpuLogicalCores: 0,
    cpuTemp: null,
    memory: { usedGb: 0, totalGb: 0, percent: 0 },
    network: { upload: 0, download: 0, ips: [] },
    disk: { totalGb: 0, usedGb: 0, percent: 0, upload: 0, download: 0 },
    gpu: { available: false, items: [] },
  });
  sharedState.metricsTimer = setInterval(async () => {
    if (!sharedState.mainWindow || sharedState.mainWindow.isDestroyed() || sharedState.metricsCollecting) return;
    sharedState.metricsCollecting = true;
    try {
      if (!sharedState.metricsSessionId || !sshStateMap.has(sharedState.metricsSessionId)) {
        if (!sharedState.metricsInactiveSent) {
          safeSend('system:metrics', emptyPayload(null, false));
          sharedState.metricsInactiveSent = true;
        }
      } else {
        const now = Date.now();
        const forceFullSample = now - lastFullSampleAt >= METRICS_FULL_SAMPLE_INTERVAL_MS;
        const sessionId = sharedState.metricsSessionId;
        const payload = await collectRemoteMetrics(sessionId, forceFullSample, ++metricsSequence);
        safeSend('system:metrics', payload);
        if (forceFullSample) {
          lastFullSampleAt = now;
        }
        sharedState.metricsInactiveSent = false;
      }
    } catch (error) {
      // Keep metrics loop alive even if a probe fails once.
      if (!sharedState.metricsInactiveSent) {
        const sessionId = sharedState.metricsSessionId;
        const cached = sessionId ? remoteMetricsPayloadMap.get(sessionId) : undefined;
        safeSend(
          'system:metrics',
          cached ? { ...cached, sequence: ++metricsSequence, stale: true } : emptyPayload(sessionId, true),
        );
        sharedState.metricsInactiveSent = true;
      }
    } finally {
      sharedState.metricsCollecting = false;
    }
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

export function parseGpu(lines: string[]) {
  const items = lines
    .map((line, index) => {
      const raw = String(line || '').trim();
      if (!raw) return null;
      const parts = raw.split(',').map((x) => x.trim());
      if (parts.length < 5) return null;
      const name = parts[0];
      const temperature = Number(parts[1]) || 0;
      const load = Number(parts[2]) || 0;
      const memUsedMb = Number(parts[3]) || 0;
      const memTotalMb = Number(parts[4]) || 0;
      const powerDrawRaw = parts.length >= 7 ? Number(parts[5]) : NaN;
      const powerLimitRaw = parts.length >= 7 ? Number(parts[6]) : NaN;
      return {
        index,
        name,
        temperature: Number(temperature.toFixed(1)),
        memoryUsedGb: Number((memUsedMb / 1024).toFixed(2)),
        memoryTotalGb: Number((memTotalMb / 1024).toFixed(2)),
        memoryPercent: memTotalMb ? Number(((memUsedMb / memTotalMb) * 100).toFixed(1)) : 0,
        load: Number(load.toFixed(1)),
        powerDraw: Number.isFinite(powerDrawRaw) ? Number(powerDrawRaw.toFixed(1)) : null,
        powerLimit: Number.isFinite(powerLimitRaw) ? Number(powerLimitRaw.toFixed(1)) : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
  return {
    available: items.length > 0,
    items,
  } as const;
}

export function parseSystem(lines: string[]): { version: string; arch: string } {
  const nonEmpty = lines
    .map((line) => String(line || '').trim().replace(/^"+|"+$/g, ''))
    .filter((line) => !!line);
  return {
    version: nonEmpty[0] || '',
    arch: nonEmpty[1] || '',
  };
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

export function parseCpuFreqMhz(lines: string[]): number {
  const values: number[] = [];
  for (const raw of lines) {
    const val = Number(String(raw || '').trim().replace(/[^0-9.]/g, '')) || 0;
    if (val <= 0) continue;
    // cpufreq files usually return kHz.
    values.push(val > 10000 ? val / 1000 : val);
  }
  if (values.length === 0) return 0;
  const avg = values.reduce((acc, n) => acc + n, 0) / values.length;
  return Number(avg.toFixed(0));
}

export function parseCpuFreqMaxMhz(lines: string[]): number {
  let max = 0;
  for (const raw of lines) {
    const val = Number(String(raw || '').trim().replace(/[^0-9.]/g, '')) || 0;
    if (val <= 0) continue;
    const mhz = val > 10000 ? val / 1000 : val;
    if (mhz > max) max = mhz;
  }
  return Number(max.toFixed(0));
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
  includeStaticSample = false,
  sequence = 0,
): Promise<RemoteMetricsPayload> {
  const cachedPayload = remoteMetricsPayloadMap.get(sessionId);
  const shouldSampleStatic = includeStaticSample || !cachedPayload;
  const script = shouldSampleStatic
    ? [
        'echo "__CPU__"; head -n1 /proc/stat 2>/dev/null || echo ""',
        'echo "__CPUINFO__"; (cat /proc/cpuinfo 2>/dev/null || true)',
        'echo "__LSCPU__"; (LANG=C LC_ALL=C lscpu 2>/dev/null || true)',
        'echo "__SYS__"; (sh -c \'if [ -f /etc/os-release ]; then . /etc/os-release; echo "${PRETTY_NAME:-${NAME:-}}"; fi; uname -m 2>/dev/null\' || true)',
        'echo "__MEM__"; (grep -E "MemTotal|MemAvailable" /proc/meminfo 2>/dev/null || true)',
        'echo "__IP__"; ((hostname -I 2>/dev/null || true); (ip -o -4 addr show scope global 2>/dev/null | cut -d\' \' -f7 | cut -d/ -f1 || true))',
        'echo "__NET__"; (cat /proc/net/dev 2>/dev/null || true)',
        'echo "__DISK__"; (cat /proc/diskstats 2>/dev/null || true)',
        'echo "__FS__"; (df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || true)',
        'echo "__CPUTEMP__"; (for d in /sys/class/hwmon/hwmon*; do [ -d "$d" ] || continue; n=$(cat "$d/name" 2>/dev/null || echo ""); echo "NAME:$n"; for f in "$d"/temp*_input; do [ -f "$f" ] || continue; b="${f%_input}"; l=$(cat "${b}_label" 2>/dev/null || echo ""); echo "T:$l:$(cat "$f" 2>/dev/null || echo 0)"; done; done)',
        'echo "__GPU__"; (command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits || true)',
      ].join('; ')
    : [
        'echo "__CPU__"; head -n1 /proc/stat 2>/dev/null || echo ""',
        'echo "__MEM__"; (grep -E "MemTotal|MemAvailable" /proc/meminfo 2>/dev/null || true)',
        'echo "__IP__"; ((hostname -I 2>/dev/null || true); (ip -o -4 addr show scope global 2>/dev/null | cut -d\' \' -f7 | cut -d/ -f1 || true))',
        'echo "__NET__"; (cat /proc/net/dev 2>/dev/null || true)',
        'echo "__DISK__"; (cat /proc/diskstats 2>/dev/null || true)',
      ].join('; ');

  const output = await execOnSession(sessionId, script, {
    timeoutMs: 5000,
    maxOutputBytes: shouldSampleStatic ? 1024 * 1024 : 256 * 1024,
  });
  const lines = output.split(/\r?\n/);
  const section: Record<string, string[]> = {
    CPU: [],
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
    GPU: [],
  };
  let current: keyof typeof section | null = null;
  for (const line of lines) {
    if (line === '__CPU__') current = 'CPU';
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
    else if (line === '__GPU__') current = 'GPU';
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
  const systemInfo = parseSystem(section.SYS);
  const memStat = parseMem(section.MEM);
  const ips = parseIps(section.IP);
  const netStat = parseNet(section.NET);
  const diskStat = parseDisk(section.DISK);
  const fsUsage = parseFsUsage(section.FS);

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
  const system = systemInfo.version || systemInfo.arch
    ? systemInfo
    : (cachedPayload?.system || { version: '', arch: '' });
  const cpuName =
    cpuInfo.name || cpuInfoLscpu.name || cachedPayload?.cpuName || (system.arch ? `CPU (${system.arch})` : 'CPU');
  const cpuLogicalCores = cpuLogicalCoreCount || cachedPayload?.cpuLogicalCores || 0;
  const cpuPhysicalCores = cpuPhysicalCoreCount || cachedPayload?.cpuPhysicalCores || 0;
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
  const cpuTemp = section.CPUTEMP.length > 0
    ? parseCpuTemp(section.CPUTEMP)
    : (cachedPayload?.cpuTemp ?? null);
  const gpu: RemoteMetricsPayload['gpu'] = section.GPU.length > 0
    ? (parseGpu(section.GPU) as RemoteMetricsPayload['gpu'])
    : (cachedPayload?.gpu || { available: false, items: [] });

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
    cpuTemp,
    memory: {
      usedGb: Number((memUsed / 1024 / 1024 / 1024).toFixed(2)),
      totalGb: memoryTotalGb,
      percent: memStat.total ? Number(((memUsed / memStat.total) * 100).toFixed(1)) : (cachedPayload?.memory.percent || 0),
    },
    network: {
      upload: Number(netUpload.toFixed(0)),
      download: Number(netDownload.toFixed(0)),
      ips: ips.length > 0 ? ips : (cachedPayload?.network.ips || []),
    },
    disk: {
      totalGb: diskTotalGb,
      usedGb: diskUsedGb,
      percent: diskPercent,
      upload: Number(diskWrite.toFixed(0)),
      download: Number(diskRead.toFixed(0)),
    },
    gpu,
  };
  remoteMetricsPayloadMap.set(sessionId, payload);
  return payload;
}
