import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { MutableRefObject } from 'react';
import type { Settings } from '../types';
import { getTerminalTheme } from '../utils/terminalTheme';
import { normalizeTerminalDataInput, shouldFlushTerminalInputImmediately } from '../utils/terminalInput';
import { getTerminalSelectionText } from '../utils/terminalSelection';
import { appendBoundedUtf8, materializeBoundedUtf8, type BoundedText } from '../utils/boundedText';
import { disposeTerminalResources } from '../utils/terminalResourceCleanup';
import { mountTerminal } from '../utils/terminalMount';
import { canWriteTerminalOutputImmediately } from '../utils/terminalOutput';
import { TerminalWriteQueue } from '../utils/terminalWriteQueue';

const MAX_TERMINAL_WRITE_CHUNK = 128 * 1024;
const MAX_PAUSED_OUTPUT_BYTES = 8 * 1024 * 1024;
const TRUNCATED_OUTPUT_NOTICE = '\r\n\x1b[33m[暂停期间输出超过 8 MiB，已丢弃最旧内容]\x1b[0m\r\n';

type UseTerminalRuntimeParams = {
  activeSessionIdRef: MutableRefObject<number | null>;
  disconnectedByTabRef: MutableRefObject<Map<number, boolean>>;
  sendInput: (payload: { sessionId: number; input: string }) => void;
  resizePty: (payload: { sessionId: number; cols: number; rows: number }) => Promise<boolean>;
};

export function useTerminalRuntime(params: UseTerminalRuntimeParams) {
  const { activeSessionIdRef, disconnectedByTabRef, sendInput, resizePty } = params;
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalMapRef = useRef<Map<number, Terminal>>(new Map());
  const fitMapRef = useRef<Map<number, FitAddon>>(new Map());
  const fitFrameRef = useRef<Map<number, number>>(new Map());
  const stabilizedFitTimerRef = useRef<Map<number, ReturnType<typeof setTimeout>[]>>(new Map());
  const pausedByScrollRef = useRef<Map<number, boolean>>(new Map());
  const pendingOutputRef = useRef<Map<number, BoundedText>>(new Map());
  const pendingWriteRef = useRef<Map<number, TerminalWriteQueue>>(new Map());
  const pendingWriteFrameRef = useRef<Map<number, number>>(new Map());
  const writeInFlightRef = useRef<Map<number, boolean>>(new Map());
  const scheduleTerminalWriteRef = useRef<(sessionId: number) => void>(() => undefined);
  const pauseSyncFrameRef = useRef<Map<number, number>>(new Map());
  const pendingResizeRef = useRef<Map<number, { cols: number; rows: number }>>(new Map());
  const lastResizeRef = useRef<Map<number, { cols: number; rows: number }>>(new Map());
  const resizeFrameRef = useRef<Map<number, number>>(new Map());
  const pendingInputRef = useRef<Map<number, string>>(new Map());
  const pendingInputTimerRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const reconnectHandlerRef = useRef<((tabId: number) => void) | null>(null);
  const autoCopySelectionRef = useRef<Map<number, boolean>>(new Map());
  const selectionCopyTimerRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [pausedOutput, setPausedOutput] = useState(false);

  const setReconnectHandler = useCallback((handler: (tabId: number) => void) => {
    reconnectHandlerRef.current = handler;
  }, []);

  const flushPendingInput = useCallback((sessionId: number) => {
    const timer = pendingInputTimerRef.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      pendingInputTimerRef.current.delete(sessionId);
    }
    const input = pendingInputRef.current.get(sessionId);
    if (!input) return;
    pendingInputRef.current.delete(sessionId);
    try {
      sendInput({ sessionId, input });
    } catch (error) {
      console.warn('[Terminal] Failed to send input:', error);
    }
  }, [sendInput]);

  const queueInput = useCallback((sessionId: number, input: string, flushNow = false) => {
    const current = pendingInputRef.current.get(sessionId) || '';
    pendingInputRef.current.set(sessionId, current + input);
    if (flushNow) {
      flushPendingInput(sessionId);
      return;
    }
    if (pendingInputTimerRef.current.has(sessionId)) return;
    const timer = setTimeout(() => flushPendingInput(sessionId), 1);
    pendingInputTimerRef.current.set(sessionId, timer);
  }, [flushPendingInput]);

  const scheduleSelectionCopy = useCallback((sessionId: number, term: Terminal) => {
    const oldTimer = selectionCopyTimerRef.current.get(sessionId);
    if (oldTimer) {
      clearTimeout(oldTimer);
      selectionCopyTimerRef.current.delete(sessionId);
    }
    if (!autoCopySelectionRef.current.get(sessionId)) return;
    const selected = getTerminalSelectionText(term);
    if (!selected) return;
    const timer = setTimeout(async () => {
      selectionCopyTimerRef.current.delete(sessionId);
      if (!autoCopySelectionRef.current.get(sessionId)) return;
      const latest = getTerminalSelectionText(term);
      if (!latest) return;
      try {
        await window.terminalApi.writeClipboardText(latest);
      } catch (error) {
        console.warn('[Terminal] Failed to copy selection:', error);
      } finally {
        if (activeSessionIdRef.current === sessionId) {
          requestAnimationFrame(() => term.focus());
        }
      }
    }, 80);
    selectionCopyTimerRef.current.set(sessionId, timer);
  }, [activeSessionIdRef]);

  const isAtBottom = useCallback((term: Terminal): boolean => term.buffer.active.viewportY >= term.buffer.active.baseY, []);

  const appendPendingOutput = useCallback((sessionId: number, data: string) => {
    const old = pendingOutputRef.current.get(sessionId);
    pendingOutputRef.current.set(sessionId, appendBoundedUtf8(old, data, MAX_PAUSED_OUTPUT_BYTES));
  }, []);

  scheduleTerminalWriteRef.current = (sessionId: number) => {
    if (writeInFlightRef.current.has(sessionId) || pendingWriteFrameRef.current.has(sessionId)) return;
    const frame = requestAnimationFrame(() => {
      pendingWriteFrameRef.current.delete(sessionId);
      const pending = pendingWriteRef.current.get(sessionId);
      if (!pending || pending.length === 0) {
        pendingWriteRef.current.delete(sessionId);
        return;
      }
      const chunk = pending.take(MAX_TERMINAL_WRITE_CHUNK);
      if (pending.length === 0) pendingWriteRef.current.delete(sessionId);
      const current = terminalMapRef.current.get(sessionId);
      if (!current) return;
      writeInFlightRef.current.set(sessionId, true);
      current.write(chunk, () => {
        writeInFlightRef.current.delete(sessionId);
        scheduleTerminalWriteRef.current(sessionId);
      });
    });
    pendingWriteFrameRef.current.set(sessionId, frame);
  };

  const writeTerminalOutput = useCallback((sessionId: number, data: string, term?: Terminal) => {
    const target = term ?? terminalMapRef.current.get(sessionId);
    if (!target || !data) return;
    if (
      canWriteTerminalOutputImmediately(data) &&
      !pendingWriteRef.current.has(sessionId) &&
      !pendingWriteFrameRef.current.has(sessionId) &&
      !writeInFlightRef.current.has(sessionId)
    ) {
      writeInFlightRef.current.set(sessionId, true);
      target.write(data, () => {
        writeInFlightRef.current.delete(sessionId);
        scheduleTerminalWriteRef.current(sessionId);
      });
      return;
    }
    let queue = pendingWriteRef.current.get(sessionId);
    if (!queue) {
      queue = new TerminalWriteQueue();
      pendingWriteRef.current.set(sessionId, queue);
    }
    queue.append(data);
    scheduleTerminalWriteRef.current(sessionId);
  }, []);

  const queueResize = useCallback((sessionId: number, cols: number, rows: number) => {
    pendingResizeRef.current.set(sessionId, { cols, rows });
    if (resizeFrameRef.current.has(sessionId)) return;
    const frame = requestAnimationFrame(() => {
      resizeFrameRef.current.delete(sessionId);
      const next = pendingResizeRef.current.get(sessionId);
      pendingResizeRef.current.delete(sessionId);
      if (!next) return;
      const previous = lastResizeRef.current.get(sessionId);
      if (previous?.cols === next.cols && previous.rows === next.rows) return;
      lastResizeRef.current.set(sessionId, next);
      void resizePty({ sessionId, ...next }).catch(() => null);
    });
    resizeFrameRef.current.set(sessionId, frame);
  }, [resizePty]);

  const flushPendingOutput = useCallback((sessionId: number, term?: Terminal) => {
    const target = term ?? terminalMapRef.current.get(sessionId);
    if (!target) return;
    const pending = pendingOutputRef.current.get(sessionId);
    if (!pending || pending.byteLength === 0) return;
    pendingOutputRef.current.delete(sessionId);
    writeTerminalOutput(
      sessionId,
      `${pending.truncated ? TRUNCATED_OUTPUT_NOTICE : ''}${materializeBoundedUtf8(pending)}`,
      target,
    );
  }, [writeTerminalOutput]);

  const disposeTerminal = useCallback((sessionId: number) => {
    disposeTerminalResources(sessionId, {
      terminal: terminalMapRef.current,
      fit: fitMapRef.current,
      fitFrame: fitFrameRef.current,
      writeFrame: pendingWriteFrameRef.current,
      writeInFlight: writeInFlightRef.current,
      pauseFrame: pauseSyncFrameRef.current,
      resizeFrame: resizeFrameRef.current,
      stabilizedTimers: stabilizedFitTimerRef.current,
      inputTimer: pendingInputTimerRef.current,
      selectionTimer: selectionCopyTimerRef.current,
      pendingOutput: pendingOutputRef.current,
      pendingWrite: pendingWriteRef.current,
      pendingInput: pendingInputRef.current,
      pendingResize: pendingResizeRef.current,
      lastResize: lastResizeRef.current,
      pausedByScroll: pausedByScrollRef.current,
      autoCopySelection: autoCopySelectionRef.current,
      disconnected: disconnectedByTabRef.current,
    });
  }, [disconnectedByTabRef]);

  useEffect(() => () => {
    for (const sessionId of Array.from(terminalMapRef.current.keys())) disposeTerminal(sessionId);
  }, [disposeTerminal]);

  const setPausedByScroll = useCallback((sessionId: number, paused: boolean, term?: Terminal) => {
      pausedByScrollRef.current.set(sessionId, paused);
      if (activeSessionIdRef.current === sessionId) {
        setPausedOutput(paused);
      }
      if (!paused) {
        flushPendingOutput(sessionId, term);
      }
    },
    [activeSessionIdRef, flushPendingOutput],
  );

  const syncPauseStateWithViewport = useCallback((sessionId: number, term?: Terminal) => {
    const target = term ?? terminalMapRef.current.get(sessionId);
    if (!target) return;
    if (target.buffer.active.type === 'alternate') {
      const current = pausedByScrollRef.current.get(sessionId) || false;
      if (current) setPausedByScroll(sessionId, false, target);
      return;
    }
    const paused = !isAtBottom(target);
    const current = pausedByScrollRef.current.get(sessionId) || false;
    if (paused !== current) {
      setPausedByScroll(sessionId, paused, target);
    }
  }, [isAtBottom, setPausedByScroll]);

  const schedulePauseStateSync = useCallback((sessionId: number, term?: Terminal) => {
    if (pauseSyncFrameRef.current.has(sessionId)) return;
    const frame = requestAnimationFrame(() => {
      pauseSyncFrameRef.current.delete(sessionId);
      syncPauseStateWithViewport(sessionId, term);
    });
    pauseSyncFrameRef.current.set(sessionId, frame);
  }, [syncPauseStateWithViewport]);

  const runFitTerminal = useCallback((sessionId: number) => {
    const fit = fitMapRef.current.get(sessionId);
    if (fit) fit.fit();
  }, []);

  const fitTerminal = useCallback((sessionId: number) => {
    if (fitFrameRef.current.has(sessionId)) return;
    const frame = requestAnimationFrame(() => {
      fitFrameRef.current.delete(sessionId);
      runFitTerminal(sessionId);
    });
    fitFrameRef.current.set(sessionId, frame);
  }, [runFitTerminal]);

  const fitTerminalStabilized = useCallback((sessionId: number) => {
    const oldTimers = stabilizedFitTimerRef.current.get(sessionId) || [];
    oldTimers.forEach((timer) => clearTimeout(timer));
    stabilizedFitTimerRef.current.delete(sessionId);
    fitTerminal(sessionId);
    requestAnimationFrame(() => fitTerminal(sessionId));
    const timers = [
      setTimeout(() => fitTerminal(sessionId), 80),
      setTimeout(() => {
        fitTerminal(sessionId);
        stabilizedFitTimerRef.current.delete(sessionId);
      }, 220),
    ];
    stabilizedFitTimerRef.current.set(sessionId, timers);
  }, [fitTerminal]);

  const focusTerminalInput = useCallback((sessionId: number, autoSwitchEnglishInputMethod = false) => {
    const term = terminalMapRef.current.get(sessionId);
    if (!term) return;
    if (autoSwitchEnglishInputMethod) {
      void window.terminalApi.switchToEnglishInputMethod();
    }
    requestAnimationFrame(() => term.focus());
    setTimeout(() => term.focus(), 30);
  }, []);

  const getPausedByScroll = useCallback((sessionId: number) => pausedByScrollRef.current.get(sessionId) || false, []);

  const attachTerminal = useCallback((sessionId: number, localSettings: Settings) => {
    if (!terminalContainerRef.current) return;
    let term = terminalMapRef.current.get(sessionId);
    let fit = fitMapRef.current.get(sessionId);
    autoCopySelectionRef.current.set(sessionId, !!localSettings.behavior.autoCopySelection);

    if (!term) {
      term = new Terminal({
        fontFamily: localSettings.theme.terminalFontFamily || 'Consolas',
        fontSize: localSettings.theme.terminalFontSize || 16,
        fontWeight: 'bold',
        cursorStyle: localSettings.theme.terminalCursorStyle || 'block',
        cursorBlink: localSettings.theme.terminalCursorBlink ?? true,
        cursorWidth: Math.max(1, Math.min(8, Number(localSettings.theme.terminalCursorWidth || 2))),
        theme: getTerminalTheme(localSettings.theme.mode),
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          void window.terminalApi.openExternal(uri);
        }),
      );
      const runtimeTerm = term;
      term.onData((input) => {
        if (!runtimeTerm) return;
        if (disconnectedByTabRef.current.get(sessionId)) {
          if (input.toLowerCase() === 'r') {
            reconnectHandlerRef.current?.(sessionId);
          }
          return;
        }
        const paused = pausedByScrollRef.current.get(sessionId) || false;
        if (paused) {
          runtimeTerm.scrollToBottom();
          setPausedByScroll(sessionId, false, runtimeTerm);
          schedulePauseStateSync(sessionId, runtimeTerm);
        }
        const normalizedInput = normalizeTerminalDataInput(input);
        queueInput(
          sessionId,
          normalizedInput,
          shouldFlushTerminalInputImmediately(normalizedInput),
        );
      });
      term.onResize(({ cols, rows }) => {
        queueResize(sessionId, cols, rows);
      });
      term.onSelectionChange(() => {
        if (!runtimeTerm) return;
        scheduleSelectionCopy(sessionId, runtimeTerm);
      });
      term.onScroll(() => {
        schedulePauseStateSync(sessionId, runtimeTerm);
      });
      terminalMapRef.current.set(sessionId, term);
      fitMapRef.current.set(sessionId, fit);
      pausedByScrollRef.current.set(sessionId, false);
      disconnectedByTabRef.current.set(sessionId, false);
    }

    term.options.fontFamily = localSettings.theme.terminalFontFamily || 'Consolas';
    term.options.fontSize = localSettings.theme.terminalFontSize || 16;
    term.options.fontWeight = 'bold';
    term.options.cursorStyle = localSettings.theme.terminalCursorStyle || 'block';
    term.options.cursorBlink = localSettings.theme.terminalCursorBlink ?? true;
    term.options.cursorWidth = Math.max(1, Math.min(8, Number(localSettings.theme.terminalCursorWidth || 2)));
    term.options.theme = getTerminalTheme(localSettings.theme.mode);

    mountTerminal(terminalContainerRef.current, term);
    fitTerminalStabilized(sessionId);
    focusTerminalInput(sessionId, !!localSettings.behavior.autoSwitchEnglishInputMethod);
    const paused = !isAtBottom(term);
    setPausedByScroll(sessionId, paused, term);
  }, [
    disconnectedByTabRef,
    focusTerminalInput,
    fitTerminalStabilized,
    isAtBottom,
    queueResize,
    setPausedByScroll,
    schedulePauseStateSync,
    queueInput,
  ]);

  return {
    terminalContainerRef,
    terminalMapRef,
    pausedOutput,
    setPausedOutput,
    appendPendingOutput,
    flushPendingOutput,
    writeTerminalOutput,
    setPausedByScroll,
    syncPauseStateWithViewport,
    fitTerminal,
    fitTerminalStabilized,
    focusTerminalInput,
    getPausedByScroll,
    attachTerminal,
    disposeTerminal,
    setReconnectHandler,
    isAtBottom,
  };
}
