export function parseCpu(line: string): { total: number; idle: number } {
  const parts = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  return { total: parts.reduce((sum, value) => sum + value, 0), idle };
}

export function parseMem(lines: string[]): { total: number; available: number; swapTotal: number; swapFree: number } {
  let total = 0;
  let available = 0;
  let swapTotal = 0;
  let swapFree = 0;
  for (const line of lines) {
    if (line.startsWith('MemTotal:')) total = (Number(line.replace(/[^0-9]/g, '')) || 0) * 1024;
    if (line.startsWith('MemAvailable:')) available = (Number(line.replace(/[^0-9]/g, '')) || 0) * 1024;
    if (line.startsWith('SwapTotal:')) swapTotal = (Number(line.replace(/[^0-9]/g, '')) || 0) * 1024;
    if (line.startsWith('SwapFree:')) swapFree = (Number(line.replace(/[^0-9]/g, '')) || 0) * 1024;
  }
  return { total, available, swapTotal, swapFree };
}

export function parseGpuDriverInfo(lines: string[]): { driverVersion: string; cudaVersion: string } {
  const text = lines.join(' ');
  const driverVersion = text.match(/Driver Version:\s*([^\s|]+)/i)?.[1] || '';
  const cudaVersion = text.match(/CUDA Version:\s*([^\s|]+)/i)?.[1] || '';
  return { driverVersion, cudaVersion };
}

export function parseGpu(lines: string[]) {
  const items = lines
    .map((line, index) => {
      const raw = String(line || '').trim();
      if (!raw) return null;
      const parts = raw.split(',').map((value) => value.trim());
      if (parts.length < 5) return null;
      const name = parts[0];
      const temperature = Number(parts[1]) || 0;
      const load = Number(parts[2]) || 0;
      const memoryUsedMb = Number(parts[3]) || 0;
      const memoryTotalMb = Number(parts[4]) || 0;
      const powerDrawRaw = parts.length >= 7 ? Number(parts[5]) : NaN;
      const powerLimitRaw = parts.length >= 7 ? Number(parts[6]) : NaN;
      const clockMhzRaw = parts.length >= 8 ? Number(parts[7]) : NaN;
      return {
        index,
        name,
        temperature: Number(temperature.toFixed(1)),
        memoryUsedGb: Number((memoryUsedMb / 1024).toFixed(2)),
        memoryTotalGb: Number((memoryTotalMb / 1024).toFixed(2)),
        memoryPercent: memoryTotalMb ? Number(((memoryUsedMb / memoryTotalMb) * 100).toFixed(1)) : 0,
        load: Number(load.toFixed(1)),
        powerDraw: Number.isFinite(powerDrawRaw) ? Number(powerDrawRaw.toFixed(1)) : null,
        powerLimit: Number.isFinite(powerLimitRaw) ? Number(powerLimitRaw.toFixed(1)) : null,
        clockMhz: Number.isFinite(clockMhzRaw) ? Number(clockMhzRaw.toFixed(0)) : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
  return { available: items.length > 0, items } as const;
}

export function parseCpuFrequencyMhz(lines: string[]): number {
  const values = lines
    .map((line) => Number(String(line || '').trim().replace(/[^0-9.]/g, '')) || 0)
    .filter((value) => value > 0)
    .map((value) => (value > 10000 ? value / 1000 : value));
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(0));
}

export function parseCpuMaxFrequencyMhz(lines: string[]): number {
  const values = lines
    .map((line) => Number(String(line || '').trim().replace(/[^0-9.]/g, '')) || 0)
    .filter((value) => value > 0)
    .map((value) => (value > 10000 ? value / 1000 : value));
  return Number(Math.max(0, ...values).toFixed(0));
}

export function parseNetworkRoute(lines: string[]): { ip: string; interfaceName: string; gateway: string } {
  const text = lines.find((line) => String(line || '').trim()) || '';
  return {
    ip: text.match(/\bsrc\s+((?:\d{1,3}\.){3}\d{1,3})\b/)?.[1] || '',
    interfaceName: text.match(/\bdev\s+(\S+)/)?.[1] || '',
    gateway: text.match(/\bvia\s+((?:\d{1,3}\.){3}\d{1,3})\b/)?.[1] || '',
  };
}

export function parseDnsServers(lines: string[]): string[] {
  const servers = Array.from(new Set(lines.map((line) => String(line || '').trim()).filter(Boolean)));
  const upstream = servers.filter((server) => !server.startsWith('127.') && server !== '::1');
  return upstream.length > 0 ? upstream : servers;
}

export function parseBlockDevices(lines: string[]): {
  ssdCount: number;
  ssdBytes: number;
  hddCount: number;
  hddBytes: number;
} {
  let ssdCount = 0;
  let ssdBytes = 0;
  let hddCount = 0;
  let hddBytes = 0;
  for (const line of lines) {
    const [, sectorsRaw, rotational] = String(line || '').trim().split('|');
    const bytes = Math.max(Number(sectorsRaw) || 0, 0) * 512;
    if (bytes <= 0) continue;
    if (rotational === '0') {
      ssdCount += 1;
      ssdBytes += bytes;
    } else if (rotational === '1') {
      hddCount += 1;
      hddBytes += bytes;
    }
  }
  return { ssdCount, ssdBytes, hddCount, hddBytes };
}

export function parseProcessCpuTicks(lines: string[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of lines) {
    const matched = String(line || '').trim().match(/^(\d+)\s+\(.*\)\s+\S\s+(.+)$/);
    if (!matched) continue;
    const fields = matched[2].trim().split(/\s+/);
    const pid = Number(matched[1]) || 0;
    const ticks = (Number(fields[10]) || 0) + (Number(fields[11]) || 0);
    if (pid > 0) result.set(pid, ticks);
  }
  return result;
}

export function parseProcesses(lines: string[]): Array<{
  pid: number;
  name: string;
  memoryBytes: number;
}> {
  const processes = [];
  for (const line of lines) {
    const matched = String(line || '').trim().match(/^(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!matched) continue;
    const pid = Number(matched[1]) || 0;
    const name = matched[3]?.trim() || '';
    if (!pid || !name) continue;
    processes.push({
      pid,
      name,
      memoryBytes: (Number(matched[2]) || 0) * 1024,
    });
  }
  return processes;
}

export function calculateProcessCpuPercent(
  currentTicks: number,
  previousTicks: number | undefined,
  elapsedMs: number,
  clockTicksPerSecond: number,
  logicalCores: number,
): number {
  if (previousTicks == null || currentTicks < previousTicks || elapsedMs <= 0 || clockTicksPerSecond <= 0) return 0;
  const intervalSeconds = elapsedMs / 1000;
  const rawPercent = ((currentTicks - previousTicks) / clockTicksPerSecond / intervalSeconds) * 100;
  const percent = logicalCores > 0 ? rawPercent / logicalCores : rawPercent;
  return Math.round((Math.max(percent, 0) + 1e-9) * 10) / 10;
}

export function parseSystemInfo(lines: string[]): {
  version: string;
  arch: string;
  kernelVersion: string;
  uptimeSeconds: number;
} {
  const values = lines.map((line) => String(line || '').trim().replace(/^"+|"+$/g, ''));
  return {
    version: values[0] || '',
    arch: values[1] || '',
    kernelVersion: values[2] || '',
    uptimeSeconds: Math.max(Math.floor(Number(values[3]) || 0), 0),
  };
}

export function parseUptimeSeconds(lines: string[], fallback = 0): number {
  const value = Math.max(Math.floor(Number(lines[0]) || 0), 0);
  return value > 0 ? value : Math.max(Math.floor(fallback || 0), 0);
}
