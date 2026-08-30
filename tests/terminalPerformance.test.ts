import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldInspectCwdOutput } from '../electron/main/ssh';
import { shouldFlushTerminalInputImmediately } from '../src/utils/terminalInput';
import { TerminalWriteQueue } from '../src/utils/terminalWriteQueue';

test('Vim-style full-screen redraws skip expensive prompt parsing', () => {
  const redraw = '\x1b[H' + Array.from({ length: 200 }, (_, index) => `line ${index}\x1b[K`).join('\r\n');
  assert.equal(shouldInspectCwdOutput('', redraw), false);
  assert.equal(shouldInspectCwdOutput('', '\x1b]7;file://host/home/user\x07'), true);
  assert.equal(shouldInspectCwdOutput('', '[root@host /srv/app] # '), true);
});

test('printable input can coalesce while Vim and shell control sequences flush immediately', () => {
  assert.equal(shouldFlushTerminalInputImmediately('hello'), false);
  assert.equal(shouldFlushTerminalInputImmediately('j'), false);
  assert.equal(shouldFlushTerminalInputImmediately('\x1b[A'), true);
  assert.equal(shouldFlushTerminalInputImmediately('\x1b'), true);
  assert.equal(shouldFlushTerminalInputImmediately('\r'), true);
});

test('terminal write queue drains in order without repeated whole-buffer concatenation', () => {
  const queue = new TerminalWriteQueue(1024);
  for (let index = 0; index < 100; index += 1) queue.append(`${index},`);
  let output = '';
  while (queue.length > 0) output += queue.take(17);
  assert.equal(output, Array.from({ length: 100 }, (_, index) => `${index},`).join(''));
});

test('terminal write queue bounds renderer backlog and keeps newest output', () => {
  const queue = new TerminalWriteQueue(8);
  queue.append('12345678');
  queue.append('ABCDEFGH');
  const output = queue.take(1024);
  assert.match(output, /积压/);
  assert.equal(output.endsWith('ABCDEFGH'), true);
});

test('terminal write queue preserves astral Unicode at truncation and chunk boundaries', () => {
  const truncated = new TerminalWriteQueue(4);
  truncated.append('12😀3');
  assert.equal(truncated.take(1024).endsWith('😀3'), true);

  const chunked = new TerminalWriteQueue();
  chunked.append('A😀B');
  assert.equal(chunked.take(2), 'A😀');
  assert.equal(chunked.take(1), 'B');
});
