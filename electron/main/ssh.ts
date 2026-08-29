import path from 'node:path';
import type { Client } from 'ssh2';
import { connectionHomeMap, connectionSessionMap, cwdOutputTailMap, lastKnownCwdMap } from './state';

export const REMOTE_SHELL_CWD_COMMAND = 'sh -c \'connection=${SSH_CONNECTION-}; best_pid=0; best_cwd=; for proc in /proc/[0-9]*; do [ -r "$proc/environ" ] || continue; tty=$(readlink "$proc/fd/0" 2>/dev/null) || continue; case "$tty" in /dev/pts/*|/dev/tty*) ;; *) continue ;; esac; command_name=$(cat "$proc/comm" 2>/dev/null) || continue; case "$command_name" in sh|bash|dash|ash|zsh|ksh|mksh|fish|csh|tcsh|nu|pwsh) ;; *) continue ;; esac; tr "\\000" "\\n" < "$proc/environ" 2>/dev/null | grep -Fqx "SSH_CONNECTION=$connection" || continue; pid=${proc##*/}; [ "$pid" -gt "$best_pid" ] || continue; cwd=$(readlink "$proc/cwd" 2>/dev/null) || continue; best_pid=$pid; best_cwd=$cwd; done; [ -n "$best_cwd" ] && printf "%s\\n" "$best_cwd"\'';

export const stripAnsi = (input: string): string => input.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');

export const shouldInspectCwdOutput = (previousTail: string, shellChunk: string): boolean => {
  const suffix = `${previousTail.slice(-128)}${shellChunk.slice(-512)}`;
  if (suffix.includes('\x1b]7;file://')) return true;
  // The currently supported prompt format always ends in `] $` or `] #`.
  // Avoid scanning every full-screen redraw from Vim and other TUI programs.
  return /\]\s*[#$]\s*$/.test(stripAnsi(suffix));
};

export const resolveHomeToken = (connectionId: number, tokenPath: string): string => {
  const session = connectionSessionMap.get(connectionId);
  const fallbackHome = session?.username === 'root' ? '/root' : session?.username ? `/home/${session.username}` : '/';
  const home = connectionHomeMap.get(connectionId) || fallbackHome;
  if (tokenPath === '~') return home;
  if (tokenPath.startsWith('~/')) return path.posix.normalize(path.posix.join(home, tokenPath.slice(2)));
  return tokenPath;
};

const decodeOscPath = (rawPath: string): string => {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
};

export const updateCwdFromPrompt = (connectionId: number, shellChunk: string): void => {
  const previousTail = cwdOutputTailMap.get(connectionId) || '';
  const combined = `${previousTail}${shellChunk.slice(-8192)}`;
  const tail = combined.slice(-8192);
  cwdOutputTailMap.set(connectionId, tail.slice(-4096));
  if (!shouldInspectCwdOutput(previousTail, shellChunk)) return;

  const oscPattern = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let oscMatch: RegExpExecArray | null;
  let candidateIndex = -1;
  let candidatePath = '';
  while ((oscMatch = oscPattern.exec(tail)) !== null) {
    const oscPath = decodeOscPath(oscMatch[1]);
    if (oscPath.startsWith('/') && oscMatch.index >= candidateIndex) {
      candidateIndex = oscMatch.index;
      candidatePath = oscPath;
    }
  }

  const linePattern = /[^\r\n]+/g;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(tail)) !== null) {
    const line = stripAnsi(lineMatch[0]).trim();
    if (!line) continue;
    const matched = line.match(/\[[^\]\r\n]*?\s([~\/][^\]\r\n]*)\]\s*[#$]\s*$/);
    if (!matched?.[1]) continue;
    const cwd = resolveHomeToken(connectionId, matched[1].trim());
    if (cwd && lineMatch.index >= candidateIndex) {
      candidateIndex = lineMatch.index;
      candidatePath = cwd;
    }
  }
  if (candidatePath) lastKnownCwdMap.set(connectionId, candidatePath);
};

export const parseRemoteShellCwd = (output: string): string | null => {
  const paths = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'));
  return paths[paths.length - 1] || null;
};

export const getRemoteShellCwd = (client: Client): Promise<string | null> => new Promise((resolve) => {
  client.exec(REMOTE_SHELL_CWD_COMMAND, (error, stream) => {
    if (error) {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (cwd: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(cwd);
    };
    const timer = setTimeout(() => {
      stream.close();
      finish(null);
    }, 4000);
    timer.unref();
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 16384) output = output.slice(-16384);
    });
    stream.on('close', () => finish(parseRemoteShellCwd(output)));
    stream.on('error', () => finish(null));
  });
});
