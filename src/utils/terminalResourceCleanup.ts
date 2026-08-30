type DisposableTerminal = { dispose: () => void };

export type TerminalResourceMaps = {
  terminal: Map<number, DisposableTerminal>;
  fit: Map<number, any>;
  fitFrame: Map<number, number>;
  writeFrame: Map<number, number>;
  writeInFlight?: Map<number, boolean>;
  pauseFrame: Map<number, number>;
  resizeFrame?: Map<number, number>;
  stabilizedTimers: Map<number, ReturnType<typeof setTimeout>[]>;
  inputTimer: Map<number, ReturnType<typeof setTimeout>>;
  selectionTimer: Map<number, ReturnType<typeof setTimeout>>;
  pendingOutput: Map<number, any>;
  pendingWrite: Map<number, any>;
  pendingInput: Map<number, any>;
  pendingResize?: Map<number, any>;
  lastResize?: Map<number, any>;
  pausedByScroll: Map<number, any>;
  autoCopySelection: Map<number, any>;
  disconnected: Map<number, any>;
};

export function disposeTerminalResources(
  sessionId: number,
  resources: TerminalResourceMaps,
  cancelFrame: (frame: number) => void = cancelAnimationFrame,
  cancelTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
): void {
  for (const frameMap of [resources.fitFrame, resources.writeFrame, resources.pauseFrame, resources.resizeFrame]) {
    if (!frameMap) continue;
    const frame = frameMap.get(sessionId);
    if (frame !== undefined) cancelFrame(frame);
    frameMap.delete(sessionId);
  }
  for (const timer of resources.stabilizedTimers.get(sessionId) || []) cancelTimer(timer);
  resources.stabilizedTimers.delete(sessionId);
  for (const timerMap of [resources.inputTimer, resources.selectionTimer]) {
    const timer = timerMap.get(sessionId);
    if (timer !== undefined) cancelTimer(timer);
    timerMap.delete(sessionId);
  }
  for (const map of [
    resources.fit,
    resources.pendingOutput,
    resources.pendingWrite,
    resources.pendingInput,
    resources.pendingResize,
    resources.lastResize,
    resources.writeInFlight,
    resources.pausedByScroll,
    resources.autoCopySelection,
    resources.disconnected,
  ]) map?.delete(sessionId);
  const terminal = resources.terminal.get(sessionId);
  resources.terminal.delete(sessionId);
  terminal?.dispose();
}
