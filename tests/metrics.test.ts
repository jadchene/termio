import assert from 'node:assert/strict';
import test from 'node:test';
import { CappedMetricsOutput } from '../electron/main/metricsOutput';
import { buildMetricsCommand } from '../electron/main/metricsCommand';
import {
  parseBlockDevices,
  parseCpu,
  parseCpuFrequencyMhz,
  parseCpuMaxFrequencyMhz,
  parseDnsServers,
  parseGpu,
  parseGpuDriverInfo,
  parseMem,
  parseNetworkRoute,
  parseProcesses,
  parseProcessCpuTicks,
  calculateProcessCpuPercent,
  parseSystemInfo,
  parseUptimeSeconds,
} from '../electron/main/metricsParsers';

test('metrics parsers read Linux counters', () => {
  assert.deepEqual(parseCpu('cpu  10 2 3 40 5 6 7 8'), { total: 81, idle: 45 });
  assert.deepEqual(parseMem([
    'MemTotal: 2048 kB',
    'MemAvailable: 512 kB',
    'SwapTotal: 1024 kB',
    'SwapFree: 256 kB',
  ]), {
    total: 2 * 1024 * 1024,
    available: 512 * 1024,
    swapTotal: 1024 * 1024,
    swapFree: 256 * 1024,
  });
});

test('metrics output enforces its byte cap', () => {
  const output = new CappedMetricsOutput(5);
  output.append(Buffer.from('abc'));
  output.append(Buffer.from('de'));
  assert.equal(output.toString(), 'abcde');
  assert.throws(() => output.append(Buffer.from('f')), /超过限制/);
});

test('CPU frequency parsers normalize kHz and summarize multiple cores', () => {
  assert.equal(parseCpuFrequencyMhz(['2400000', '3600000']), 3000);
  assert.equal(parseCpuFrequencyMhz(['2200.5', '2400.5']), 2301);
  assert.equal(parseCpuMaxFrequencyMhz(['4600000', '4400000']), 4600);
  assert.equal(parseCpuMaxFrequencyMhz([]), 0);
});

test('network parsers bind the source IP, interface, gateway and effective DNS', () => {
  assert.deepEqual(
    parseNetworkRoute(['1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.20 uid 1000']),
    { ip: '192.168.1.20', interfaceName: 'eth0', gateway: '192.168.1.1' },
  );
  assert.deepEqual(parseDnsServers(['127.0.0.53', '223.5.5.5', '223.5.5.5', '1.1.1.1']), [
    '223.5.5.5',
    '1.1.1.1',
  ]);
  assert.deepEqual(parseDnsServers(['127.0.0.53']), ['127.0.0.53']);
});

test('block device parser separates solid-state and rotational raw capacity', () => {
  assert.deepEqual(parseBlockDevices([
    'nvme0n1|3907029168|0',
    'sda|1953514584|1',
    'sdb|1953514584|1',
    'dm-0|1000000|',
  ]), {
    ssdCount: 1,
    ssdBytes: 3907029168 * 512,
    hddCount: 2,
    hddBytes: 1953514584 * 512 * 2,
  });
});

test('GPU parser reads the current graphics clock for each device', () => {
  const parsed = parseGpu([
    'NVIDIA RTX A5000, 61, 72, 8192, 24564, 128.5, 230.0, 1410',
    'NVIDIA RTX A5000, 54, 3, 1024, 24564, 29.1, 230.0, [N/A]',
  ]);
  assert.equal(parsed.available, true);
  assert.equal(parsed.items[0]?.clockMhz, 1410);
  assert.equal(parsed.items[1]?.clockMhz, null);
});

test('process parsers read current CPU ticks and resident memory', () => {
  assert.deepEqual(parseProcesses(['101 1200 node', '202 3400 java']), [
    { pid: 101, name: 'node', memoryBytes: 1200 * 1024 },
    { pid: 202, name: 'java', memoryBytes: 3400 * 1024 },
  ]);
  const ticks = parseProcessCpuTicks([
    '101 (node worker) S 1 2 3 4 5 6 7 8 9 10 80 20 13 14',
    'invalid',
  ]);
  assert.equal(ticks.get(101), 100);
});

test('process CPU usage uses whole-host percentage with a raw fallback when core count is unavailable', () => {
  assert.equal(calculateProcessCpuPercent(240, 140, 1000, 100, 8), 12.5);
  assert.equal(calculateProcessCpuPercent(340, 140, 1000, 100, 8), 25);
  assert.equal(calculateProcessCpuPercent(240, 140, 1000, 100, 0), 100);
  assert.equal(calculateProcessCpuPercent(240, undefined, 1000, 100, 8), 0);
  assert.equal(calculateProcessCpuPercent(100, 120, 1000, 100, 8), 0);
});

test('NVIDIA-SMI header parser reads shared driver and CUDA versions', () => {
  assert.deepEqual(parseGpuDriverInfo([
    '| NVIDIA-SMI 580.65.06     Driver Version: 580.65.06     CUDA Version: 13.0 |',
  ]), {
    driverVersion: '580.65.06',
    cudaVersion: '13.0',
  });
  assert.deepEqual(parseGpuDriverInfo([]), { driverVersion: '', cudaVersion: '' });
});

test('system parser reads kernel version and uptime', () => {
  assert.deepEqual(parseSystemInfo(['Ubuntu 24.04.3 LTS', 'x86_64', '6.8.0-64-generic', '93784.42']), {
    version: 'Ubuntu 24.04.3 LTS',
    arch: 'x86_64',
    kernelVersion: '6.8.0-64-generic',
    uptimeSeconds: 93784,
  });
  assert.equal(parseUptimeSeconds(['93784.42'], 12), 93784);
  assert.equal(parseUptimeSeconds([], 93784), 93784);
});

test('metrics command samples static host information only when requested', () => {
  const realtime = buildMetricsCommand({ includeStatic: false, includeFileSystem: false, includeNetwork: false });
  assert.doesNotMatch(realtime, /__CPUINFO__|__SYS__|__GPUINFO__|__FS__/);
  assert.match(realtime, /__CPU__|__MEM__|__NET__|__DISK__|__UPTIME__|__CLOCK_TICKS__|__CPUFREQ__|__CPUTEMP__|__GPU__|__PROCESS_INFO__|__PROCESS_CPU__/);

  const fileSystem = buildMetricsCommand({ includeStatic: false, includeFileSystem: true, includeNetwork: false });
  assert.match(fileSystem, /__FS__/);
  assert.doesNotMatch(fileSystem, /__CPUINFO__|__SYS__|__GPUINFO__/);

  const network = buildMetricsCommand({ includeStatic: false, includeFileSystem: false, includeNetwork: true });
  assert.match(network, /__NETROUTE__|__IP__|__DNS__|__GPUINFO__/);

  const initial = buildMetricsCommand({ includeStatic: true, includeFileSystem: true, includeNetwork: true });
  assert.match(initial, /__BLOCKDEV__|__CPUINFO__|__CPUFREQMAX__|__SYS__|__GPUINFO__/);
});
