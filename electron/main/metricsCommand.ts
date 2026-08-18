type MetricsCommandOptions = {
  includeStatic: boolean;
  includeSlow: boolean;
  includeNetwork: boolean;
};

const realtimeCommands = [
  'echo "__CPU__"; head -n1 /proc/stat 2>/dev/null || echo ""',
  'echo "__MEM__"; (grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree" /proc/meminfo 2>/dev/null || true)',
  'echo "__NET__"; (cat /proc/net/dev 2>/dev/null || true)',
  'echo "__DISK__"; (cat /proc/diskstats 2>/dev/null || true)',
  'echo "__UPTIME__"; (cut -d" " -f1 /proc/uptime 2>/dev/null || true)',
];

const networkCommands = [
  'echo "__NETROUTE__"; (ip -4 route get 1.1.1.1 2>/dev/null | head -n1 || true)',
  'echo "__IP__"; ((hostname -I 2>/dev/null || true); (ip -o -4 addr show scope global 2>/dev/null | cut -d\' \' -f7 | cut -d/ -f1 || true))',
  'echo "__DNS__"; (for file in /run/systemd/resolve/resolv.conf /run/NetworkManager/no-stub-resolv.conf /run/NetworkManager/resolv.conf /etc/resolv.conf; do [ -r "$file" ] || continue; servers=$(awk \'/^[[:space:]]*nameserver[[:space:]]+/ {print $2}\' "$file"); [ -n "$servers" ] || continue; echo "$servers"; break; done)',
];

const slowCommands = [
  'echo "__FS__"; (df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || true)',
  'echo "__CPUFREQ__"; (cat /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq 2>/dev/null || grep "^cpu MHz" /proc/cpuinfo 2>/dev/null | cut -d: -f2 || true)',
  'echo "__CPUTEMP__"; (for d in /sys/class/hwmon/hwmon*; do [ -d "$d" ] || continue; n=$(cat "$d/name" 2>/dev/null || echo ""); echo "NAME:$n"; for f in "$d"/temp*_input; do [ -f "$f" ] || continue; b="${f%_input}"; l=$(cat "${b}_label" 2>/dev/null || echo ""); echo "T:$l:$(cat "$f" 2>/dev/null || echo 0)"; done; done)',
  'echo "__GPU__"; (command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,clocks.current.graphics --format=csv,noheader,nounits || true)',
  'echo "__PROCESSES_CPU__"; (command -v ps >/dev/null 2>&1 && LANG=C LC_ALL=C ps -eo pid=,%cpu=,rss=,comm= --sort=-%cpu 2>/dev/null | head -n 10 || true)',
  'echo "__PROCESSES_MEMORY__"; (command -v ps >/dev/null 2>&1 && LANG=C LC_ALL=C ps -eo pid=,%cpu=,rss=,comm= --sort=-rss 2>/dev/null | head -n 10 || true)',
];

const staticCommands = [
  'echo "__BLOCKDEV__"; (for device in /sys/block/*; do [ -d "$device" ] || continue; name="${device##*/}"; case "$name" in loop*|ram*|zram*|fd*|sr*|dm-*|md*) continue ;; esac; [ -r "$device/size" ] || continue; sectors=$(cat "$device/size" 2>/dev/null || echo 0); rotational=$(cat "$device/queue/rotational" 2>/dev/null || echo ""); echo "$name|$sectors|$rotational"; done)',
  'echo "__CPUINFO__"; (cat /proc/cpuinfo 2>/dev/null || true)',
  'echo "__LSCPU__"; (LANG=C LC_ALL=C lscpu 2>/dev/null || true)',
  'echo "__CPUFREQMAX__"; (cat /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq 2>/dev/null || LANG=C LC_ALL=C lscpu 2>/dev/null | sed -n "s/^CPU max MHz:[[:space:]]*//p" || true)',
  'echo "__SYS__"; (sh -c \'if [ -f /etc/os-release ]; then . /etc/os-release; echo "${PRETTY_NAME:-${NAME:-}}"; else echo ""; fi; uname -m 2>/dev/null; uname -r 2>/dev/null\' || true)',
  'echo "__GPUINFO__"; (command -v nvidia-smi >/dev/null 2>&1 && LANG=C LC_ALL=C nvidia-smi 2>/dev/null | sed -n "1,3p" || true)',
];

export const buildMetricsCommand = ({ includeStatic, includeSlow, includeNetwork }: MetricsCommandOptions): string => [
  ...realtimeCommands,
  ...(includeNetwork ? networkCommands : []),
  ...(includeSlow ? slowCommands : []),
  ...(includeStatic ? staticCommands : []),
].join('; ');
