import assert from 'node:assert/strict';
import test from 'node:test';
import { SshDataBuffer } from '../electron/main/sshDataBuffer';

test('SSH output is bounded and applies stream backpressure', () => {
  const sent: string[] = [];
  let pauses = 0;
  let resumes = 0;
  const buffer = new SshDataBuffer({
    send: (_, data) => sent.push(data),
    getShell: () => ({
      pause: () => { pauses += 1; },
      resume: () => { resumes += 1; },
    }),
    flushDelayMs: 60_000,
    maxIpcChunk: 8,
    maxBuffer: 128,
    highWatermark: 96,
    lowWatermark: 8,
  });

  buffer.enqueue(1, 'x'.repeat(256));
  assert.equal(buffer.bufferedLength(1) <= 128, true);
  assert.equal(pauses, 1);
  buffer.flush(1, true);
  assert.equal(buffer.bufferedLength(1), 0);
  assert.equal(resumes, 1);
  assert.equal(sent.join('').includes('truncated'), true);
});

test('SSH output chunking never splits an astral Unicode character', () => {
  const sent: string[] = [];
  const buffer = new SshDataBuffer({
    send: (_, data) => sent.push(data),
    getShell: () => undefined,
    flushDelayMs: 60_000,
    maxIpcChunk: 3,
    maxBuffer: 64,
    highWatermark: 48,
    lowWatermark: 8,
  });
  buffer.enqueue(1, 'ab😀cd');
  buffer.flush(1, true);
  assert.equal(sent.join(''), 'ab😀cd');
  assert.equal(sent.some((chunk) => chunk.includes('\ud83d') !== chunk.includes('\ude00')), false);
});
