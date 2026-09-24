const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const assert = require('node:assert/strict');
const test = require('node:test');

const target = path.resolve(__dirname, '../../dist-electron/electron/main/nativeFileDrag.js');

/** 驱动真实主进程编译模块，仅替换网络、原生子进程和 Electron 外部边界。 */
const check = async (scenario) => {
  const parent = path.resolve(process.env.TERMIO_TEST_ROOT || os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'termio-protocol-'));
  const handlers = new Map();
  const batches = new Map();
  const clients = [];
  const downloads = [];
  const events = [];
  const completed = new Set();
  const errors = [];
  let active = 0, peak = 0, result, manifestPath, expectedFiles = [], finished = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const send = (line) => child.stdout.write(`${line}\n`);
  const end = (hr = 0, effect = 1) => {
    if (finished) return;
    finished = true;
    queueMicrotask(() => {
      send(`TRANSFER_END\t${hr}\t${effect}`);
      send(`END\t262400\t${effect}`);
      child.emit('close', 0);
    });
  };
  const startContents = (items) => {
    expectedFiles = items.filter((item) => !item.IsDirectory);
    if (!expectedFiles.length) { end(); return; }
    const requested = expectedFiles.at(-1).Index;
    send(`REQUEST\t${requested}`);
    send(`REQUEST\t${requested}`);
  };
  child.stdin = { destroyed: false, on: () => {}, write: (line) => {
    const parts = line.trim().split('\t');
    if (parts[0] === 'MANIFEST_READY') {
      startContents(JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'expanded-items.json'), 'utf8')));
    } else if (parts[0] === 'READY') {
      const index = Number(parts[1]);
      assert.equal(fs.readFileSync(path.join(path.dirname(manifestPath), `${index}.data`), 'utf8'), 'hello');
      completed.add(index);
      if (completed.size === expectedFiles.length) end();
    } else if (parts[0] === 'CANCEL') end(-2147023673, 0);
    else if (parts[0] === 'ERROR' || parts[0] === 'MANIFEST_ERROR') end(-2147467259, 0);
  } };
  child.kill = () => { child.killed = true; end(-2147023673, 0); };

  const client = () => {
    const pending = new Set();
    const value = {
      closed: false,
      list: async () => {
        if (scenario === 'manifest-failure') throw new Error('list failed');
        return scenario === 'empty' ? [] : Array.from({ length: 8 }, (_, index) => ({ name: `${index}.txt`, type: '-', size: 5 }));
      },
      fastGet: (remote, local) => new Promise((resolve, reject) => {
        assert.equal(value.closed, false);
        downloads.push(remote);
        active += 1;
        peak = Math.max(peak, active);
        const complete = (error) => {
          if (!pending.delete(complete)) return;
          clearTimeout(timer);
          active -= 1;
          if (error) reject(error);
          else { fs.writeFileSync(local, 'hello'); resolve(); }
        };
        pending.add(complete);
        const timer = setTimeout(() => complete(scenario === 'failure' && remote.endsWith('/7.txt') ? new Error('read failed') : null), 15);
        if (scenario === 'cancel' && active === 3) {
          queueMicrotask(() => {
            const control = batches.get('batch');
            control.cancelled = true;
            control.onCancel();
            for (const channel of control.clients) void channel.end();
          });
        }
      }),
      end: async () => {
        value.closed = true;
        for (const complete of [...pending]) complete(new Error('closed'));
      },
    };
    clients.push(value);
    return value;
  };

  const mocks = {
    electron: { app: { getPath: () => scratch, isPackaged: false }, BrowserWindow: { fromWebContents: () => undefined } },
    'node:child_process': { spawn: (_exe, args) => {
      manifestPath = args[0];
      setImmediate(() => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.equal(downloads.length, 0);
        send('DROPPED\t1');
        if (manifest.ExpandDirectories) send('REQUEST_MANIFEST');
        else startContents(manifest.Items);
      });
      return child;
    } },
    './state': { sftpBatchControlMap: batches, sftpProgressThrottleMap: new Map(), DEFAULT_TRANSFER_CONCURRENCY: 3 },
    './session': { requireConnected: () => {}, getSessionForConnection: async () => ({}) },
    './window': { safeSend: (name, payload) => {
      events.push(name);
      if (name === 'sftp:batch-complete') result = payload;
      if (name === 'sftp:native-drag-ended' && result) finish();
    } },
    './ipcSecurity': { registerTrustedHandle: (name, handler) => handlers.set(name, handler), registerTrustedOn: (name, handler) => handlers.set(name, handler) },
    './sftp': {
      buildRemotePath: (dir, name) => `${dir}/${name}`, createBatchId: () => 'batch',
      createStandaloneSftp: async () => client(), createWorkerSftpClients: async (_id, _session, count) => Array.from({ length: count }, client),
      resolveRemotePath: async (_client, remote) => remote, emitSftpBatchError: (payload) => errors.push(payload), emitSftpProgressMaybe: () => {},
      runWithConcurrency: async (count, concurrency, worker) => {
        let next = 0;
        await Promise.all(Array.from({ length: concurrency }, async (_, id) => { while (next < count) await worker(next++, id); }));
      },
    },
  };
  const originalLoad = Module._load;
  let drag;
  try {
    Module._load = function(request, origin, ...rest) {
      if (origin?.filename === target && mocks[request]) return mocks[request];
      return originalLoad.call(this, request, origin, ...rest);
    };
    delete require.cache[require.resolve(target)];
    drag = require(target);
  } finally { Module._load = originalLoad; }
  let timeout;
  try {
    drag.registerNativeFileDragIpc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const roots = scenario === 'files'
      ? Array.from({ length: 8 }, (_, index) => ({ remotePath: `/folder/${index}.txt`, name: `${index}.txt`, isDirectory: false, size: 5 }))
      : [{ remotePath: '/folder', name: 'folder', isDirectory: true, size: 0 }];
    handlers.get('sftp:start-native-drag')({ sender: {} }, { token: 'test_drag_token', sessionId: 7, items: roots });
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('protocol timeout')), 5000); })]);
    assert.equal(active, 0);
    assert.equal(clients.every((value) => value.closed), true);
    assert.equal(batches.size, 0);
    assert.equal(events[0], 'sftp:native-drag-ended');
    assert.equal(new Set(downloads).size, downloads.length);
    if (['files', 'directory'].includes(scenario)) {
      assert.equal(peak, 3);
      assert.equal(downloads.slice(0, 3).includes('/folder/7.txt'), true);
      assert.equal(result.successCount, 8);
      assert.equal(result.failedCount, 0);
      assert.equal(result.cancelled, false);
    } else if (scenario === 'cancel') assert.equal(result.cancelled, true);
    else if (scenario === 'failure') assert.equal(errors.length, 1);
    else if (scenario === 'empty') assert.equal(downloads.length, 0);
    else assert.equal(result.successCount, 0);
  } finally {
    clearTimeout(timeout);
    drag.cancelAllNativeFileDrags();
    const relative = path.relative(parent, path.resolve(scratch));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(scratch, { recursive: true, force: true });
  }
};

for (const scenario of ['files', 'directory', 'empty', 'cancel', 'failure', 'manifest-failure']) {
  test(`native drag protocol: ${scenario}`, { skip: process.platform !== 'win32' }, () => check(scenario));
}
