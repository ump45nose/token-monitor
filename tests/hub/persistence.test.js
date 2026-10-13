'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHub } = require('../../src/hub/server');

function fixture(t, persistIntervalMs = 300000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-persistence-'));
  const dataFile = path.join(dir, 'devices.json');
  const hub = createHub({ port: 0, host: '127.0.0.1', dataFile, persistIntervalMs });
  t.after(async () => {
    await hub.stop();
    fs.rmSync(dir, { recursive: true });
  });
  return { hub, dataFile };
}

function readStore(dataFile) {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

test('continuous uploads stay live and share the first save deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 1 } });
  t.mock.timers.tick(299999);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 9 } });
  hub.ingest({ deviceId: 'b', today: { totalTokens: 4 } });
  assert.equal(fs.existsSync(dataFile), false);
  assert.equal(hub.getStats().periods.today.totalTokens, 13);
  t.mock.timers.tick(1);
  const store = readStore(dataFile);
  assert.equal(store.devices.a.periods.today.totalTokens, 9);
  assert.equal(store.devices.b.periods.today.totalTokens, 4);
  const inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(600000);
  assert.equal(fs.statSync(dataFile).ino, inode);
});

test('normal stop saves pending records and they survive reopening', async (t) => {
  const { hub, dataFile } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'a', today: { totalTokens: 7 } });
  await hub.stop();
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 7);
  const restored = createHub({ dataFile });
  assert.equal(restored.getDevices()[0].periods.today.totalTokens, 7);
});

test('subscription edits and device deletion save pending uploads immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 3 } });
  hub.setSubscriptions([], hub.getSubscriptions().updatedAt);
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 3);
  let inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(300000);
  assert.equal(fs.statSync(dataFile).ino, inode);
  hub.ingest({ deviceId: 'b', today: { totalTokens: 5 } });
  hub.deleteDevice('a');
  const store = readStore(dataFile);
  assert.equal(store.devices.a, undefined);
  assert.equal(store.devices.b.periods.today.totalTokens, 5);
  inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(300000);
  assert.equal(fs.statSync(dataFile).ino, inode);
});

test('default persistence stays synchronous and uses compact JSON', (t) => {
  const { hub, dataFile } = fixture(t, 0);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 3 } });
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 3);
  const text = fs.readFileSync(dataFile, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`);
  assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
});

test('standalone SIGTERM saves an accepted upload before exiting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-signal-'));
  const dataFile = path.join(dir, 'devices.json');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [
    path.resolve(__dirname, '../../src/hub/server.js'),
    `--port=${port}`, '--host=127.0.0.1', `--dataFile=${dataFile}`,
    '--persistIntervalMs=300000'
  ], { env: { ...process.env, TOKEN_MONITOR_SECRET: 'test-secret' } });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true });
  });
  const exited = once(child, 'exit');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('hub listening')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Hub exited before listening: ${code}`)));
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
    body: JSON.stringify({ deviceId: 'signal-test', today: { totalTokens: 11 } })
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(fs.existsSync(dataFile), false);
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(readStore(dataFile).devices['signal-test'].periods.today.totalTokens, 11);
});
