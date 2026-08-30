import { memo, useRef, type MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { ConnectionState, Settings } from '../types';
import { hasMultilineInput, prepareTerminalPaste } from '../utils/terminalInput';
import { getTerminalSelectionText } from '../utils/terminalSelection';

type TerminalZoneProps = {
  activeSessionId: number | null;
  pausedOutput: boolean;
  connectionState: ConnectionState | null;
  settings: Settings;
  terminalContainerRef: MutableRefObject<HTMLDivElement | null>;
  terminalMapRef: MutableRefObject<Map<number, Terminal>>;
  syncPauseStateWithViewport: (sessionId: number, term?: Terminal) => void;
  askConfirm: (message: string, title?: string) => Promise<boolean>;
  showAlert: (message: string, title?: string) => Promise<void>;
};

function TerminalZoneInner(props: TerminalZoneProps) {
  const {
    activeSessionId,
    pausedOutput,
    connectionState,
    settings,
    terminalContainerRef,
    terminalMapRef,
    syncPauseStateWithViewport,
    askConfirm,
    showAlert,
  } = props;
  const pauseSyncFrameRef = useRef<number | null>(null);

  const switchToEnglishInputMethod = () => {
    if (!settings.behavior.autoSwitchEnglishInputMethod) return;
    void window.terminalApi.switchToEnglishInputMethod();
  };

  const scheduleViewportPauseSync = () => {
    if (!activeSessionId || pauseSyncFrameRef.current != null) return;
    const term = terminalMapRef.current.get(activeSessionId);
    if (!term) return;
    pauseSyncFrameRef.current = requestAnimationFrame(() => {
      pauseSyncFrameRef.current = null;
      syncPauseStateWithViewport(activeSessionId, term);
    });
  };

  const pasteClipboardText = async (text: string) => {
    if (!activeSessionId || !text) return;
    const term = terminalMapRef.current.get(activeSessionId);
    if (settings.behavior.multilineWarning && hasMultilineInput(text)) {
      if (!(await askConfirm('检测到多行内容，确认粘贴到终端吗？'))) return;
    }
    try {
      await window.terminalApi.sshSend({
        sessionId: activeSessionId,
        input: prepareTerminalPaste(text, !!term?.modes.bracketedPasteMode),
      });
      term?.focus();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), '粘贴失败');
    }
  };

  const resumeOutput = () => {
    if (!activeSessionId) return;
    const term = terminalMapRef.current.get(activeSessionId);
    term?.scrollToBottom();
    syncPauseStateWithViewport(activeSessionId, term);
    requestAnimationFrame(() => term?.focus());
  };

  return (
    <section className="terminal-zone">
      {!activeSessionId && (
        <div className="terminal-empty-state">
          <strong>选择一个 SSH 会话开始连接</strong>
          <span>可在左侧单击会话；右键可新建独立连接</span>
        </div>
      )}
      {activeSessionId && connectionState === 'connecting' && (
        <div className="terminal-connecting" role="status">正在建立 SSH 连接…</div>
      )}
      {activeSessionId && pausedOutput && <button className="pause-banner" onClick={resumeOutput}>正在查看历史输出 · 点击或输入任意内容继续</button>}
      <div
        ref={terminalContainerRef}
        className="terminal-container"
        onFocus={switchToEnglishInputMethod}
        onMouseDown={switchToEnglishInputMethod}
        onPasteCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const text = event.clipboardData.getData('text');
          void pasteClipboardText(text);
        }}
        onCopyCapture={(event) => {
          if (!activeSessionId) return;
          const term = terminalMapRef.current.get(activeSessionId);
          if (!term?.hasSelection()) return;
          const selected = getTerminalSelectionText(term);
          if (!selected) return;
          event.clipboardData.setData('text/plain', selected);
          event.preventDefault();
          void window.terminalApi.writeClipboardText(selected);
          requestAnimationFrame(() => term.focus());
        }}
        onWheel={scheduleViewportPauseSync}
        onMouseUp={scheduleViewportPauseSync}
        onContextMenu={async (event) => {
          event.preventDefault();
          if (!activeSessionId || !settings.behavior.rightClickPaste) return;
          let text = '';
          try {
            text = await navigator.clipboard.readText();
          } catch (error) {
            await showAlert(error instanceof Error ? error.message : String(error), '读取剪贴板失败');
            return;
          }
          await pasteClipboardText(text);
        }}
      />
    </section>
  );
}

export const TerminalZone = memo(TerminalZoneInner);
