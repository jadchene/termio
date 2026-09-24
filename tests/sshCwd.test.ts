import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Client, ClientChannel } from 'ssh2';
import { getRemoteShellCwd } from '../electron/main/ssh';

test('cwd requests share one probe and preserve split UTF-8 directory names', async () => {
  let calls = 0;
  let stream = new EventEmitter();
  const client = {
    exec: (_command: string, callback: (error: undefined, channel: EventEmitter) => void) => {
      calls += 1;
      callback(undefined, stream);
    },
  } as unknown as Client;
  const first = getRemoteShellCwd(client);
  const second = getRemoteShellCwd(client);
  assert.equal(first, second);
  const bytes = Buffer.from('/srv/目录\n');
  stream.emit('data', bytes.subarray(0, 6));
  stream.emit('data', bytes.subarray(6));
  stream.emit('close');
  assert.equal(await first, '/srv/目录');
  assert.equal(calls, 1);
  stream = new EventEmitter();
  const next = getRemoteShellCwd(client);
  stream.emit('data', Buffer.from('/new\n'));
  stream.emit('close');
  assert.equal(await next, '/new');
  assert.equal(calls, 2);
});

test('cwd timeout covers channel opening and closes a late channel', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let callback!: (error: undefined, stream: ClientChannel) => void;
  const client = { exec: (_command: string, done: typeof callback) => { callback = done; } } as unknown as Client;
  const request = getRemoteShellCwd(client);
  context.mock.timers.tick(4000);
  assert.equal(await request, null);
  let closed = false;
  callback(undefined, { close: () => { closed = true; } } as ClientChannel);
  assert.equal(closed, true);
});

test('failed cwd probes release the connection for retry', async () => {
  let calls = 0;
  const client = {
    exec: (_command: string, callback: (error: Error) => void) => {
      calls += 1;
      callback(new Error('channel unavailable'));
    },
  } as unknown as Client;
  assert.equal(await getRemoteShellCwd(client), null);
  assert.equal(await getRemoteShellCwd(client), null);
  assert.equal(calls, 2);
});
