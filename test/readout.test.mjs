import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';
import { SessionStore } from '../src/sessions.mjs';
import { lookupQuantity } from '../src/ledger.mjs';

async function setup(scenario = 'ledger') {
  const directory = await mkdtemp(join(tmpdir(), 'readout-test-'));
  const source = await startSource({ scenario });
  const app = await startApplication({ source: source.base, root: directory });
  return { directory, source, app,
    async cleanup() { await app.close(); await source.close(); await rm(directory, { recursive: true, force: true }); } };
}

const post = (app, path, body = {}) => fetch(`${app.base}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(response => response.json());
const get = (app, path) => fetch(`${app.base}${path}`).then(response => response.json());

test('一次完整领取：续帧组合、数值对应记录定义/存储号/费率', async () => {
  const { app, cleanup } = await setup();
  try {
    const session = await post(app, '/readouts', { path: '/meter/2/read' });
    assert.equal(session.status, 'complete');
    assert.equal(session.device.key, '11223344-2c2d-1-2');
    assert.equal(session.frames.length, 3);
    assert.deepEqual(session.frames.map(frame => frame.fcb), [null, 1, 0]);
    const energy = session.ledger.records.filter(record => record.unit?.kind === 'energy' && record.status === 'resolved');
    assert.equal(energy.length, 4);
    const byStorage = Object.fromEntries(energy.map(record => [`${record.storage}/${record.tariff}/${record.value}`, true]));
    assert.ok(byStorage['0/0/12345000']);
    assert.ok(byStorage['1/0/11000000']);
    assert.ok(byStorage['0/1/345000']);
    assert.ok(byStorage['0/0/1.5']);
    // 厂家扩展与特殊值保留原字节，不在数值列表
    assert.equal(session.ledger.uninterpreted.length, 3);
    assert.ok(session.ledger.uninterpreted.every(record => record.value === null && record.rawBytes));
    assert.equal(session.ledger.frames.at(-1).manufacturerTail, 'deadbeef');
    // 帧原件可按摘要回读核对
    const list = await get(app, '/readouts');
    assert.equal(list.length, 1);
    const detail = await get(app, `/readouts/${session.id}`);
    assert.equal(detail.ledger.records.length, session.ledger.records.length);
  } finally { await cleanup(); }
});

test('网关重发旧帧不算新读数，卡死时保留进度', async () => {
  const { app, cleanup } = await setup();
  try {
    const session = await post(app, '/readouts', { path: '/meter/3/read' });
    assert.equal(session.status, 'interrupted');
    assert.match(session.error, /重发旧帧/);
    assert.equal(session.frames.length, 1); // 重传帧没有重复入账
    assert.equal(session.progress.nextFcb, 1); // 换过计数位仍未推进
  } finally { await cleanup(); }
});

test('采集中断后进度与设备身份可核对，恢复后续采完成', async () => {
  const { app, directory, cleanup } = await setup();
  try {
    const interrupted = await post(app, '/readouts', { path: '/meter/4/read' });
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.frames.length, 1);
    assert.equal(interrupted.device.key, '22222222-2c2d-1-2');
    // 重新打开存储：进度与身份仍在
    const reopened = await new SessionStore(directory).get(interrupted.id);
    assert.equal(reopened.device.key, '22222222-2c2d-1-2');
    assert.equal(reopened.frames.length, 1);
    assert.equal(reopened.fcb, 1);
    const resumed = await post(app, `/readouts/${interrupted.id}/resume`);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.frames.length, 2);
    assert.equal(resumed.device.key, '22222222-2c2d-1-2');
  } finally { await cleanup(); }
});

test('续帧身份不一致：拒绝拼入，保留证据与原进度', async () => {
  const { app, cleanup } = await setup();
  try {
    const session = await post(app, '/readouts', { path: '/meter/5/read' });
    assert.equal(session.status, 'failed');
    assert.match(session.error, /身份不一致/);
    assert.equal(session.frames.length, 1);
    assert.equal(session.ledger.records.every(record => record.frameDigest === session.frames[0].digest), true);
    assert.equal(session.rejected.length, 1);
    assert.equal(session.rejected[0].identity, '44444444-2c2d-1-2');
    // 拒收帧原件仍可回读核对
    const rejected = await fetch(`${app.base}/objects/${session.rejected[0].digest}`);
    assert.equal(rejected.status, 200);
  } finally { await cleanup(); }
});

test('换表后主地址沿用：中断的会话不会被新表的帧拼上', async () => {
  const { app, source, cleanup } = await setup();
  try {
    const interrupted = await post(app, '/readouts', { path: '/meter/4/read' });
    assert.equal(interrupted.status, 'interrupted');
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });
    const resumed = await post(app, `/readouts/${interrupted.id}/resume`);
    assert.equal(resumed.status, 'failed');
    assert.match(resumed.error, /身份不一致/);
    assert.equal(resumed.frames.length, 1); // 只有旧表首帧
    assert.equal(resumed.rejected[0].identity, '77777777-2c2d-1-2');
    // 新表应作为新设备重新领取
    const fresh = await post(app, '/readouts', { path: '/meter/4/read' });
    assert.equal(fresh.status, 'complete');
    assert.equal(fresh.device.key, '77777777-2c2d-1-2');
  } finally { await cleanup(); }
});

test('换表后新领取是新设备，旧会话原样保留', async () => {
  const { app, source, cleanup } = await setup();
  try {
    const before = await post(app, '/readouts', { path: '/meter/2/read' });
    assert.equal(before.device.key, '11223344-2c2d-1-2');
    await fetch(`${source.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'advance' }) });
    const after = await post(app, '/readouts', { path: '/meter/2/read' });
    assert.equal(after.status, 'complete');
    assert.equal(after.device.key, '55667788-2c2d-1-2');
    assert.notEqual(after.id, before.id);
    const kept = await get(app, `/readouts/${before.id}`);
    assert.equal(kept.device.key, '11223344-2c2d-1-2');
    assert.equal(kept.ledger.records.length, before.ledger.records.length);
  } finally { await cleanup(); }
});

test('量查询区分：已得数值 / 未提供 / 尚未读完 / 不能解释', async () => {
  const { app, cleanup } = await setup();
  try {
    const complete = await post(app, '/readouts', { path: '/meter/2/read' });
    const energy = await get(app, `/readouts/${complete.id}/quantity?kind=energy`);
    assert.equal(energy.status, 'resolved');
    assert.equal(energy.values.length, 4);
    const stored = await get(app, `/readouts/${complete.id}/quantity?kind=energy&storage=1`);
    assert.deepEqual(stored.values.map(item => item.value), [11000000]);
    const tariffed = await get(app, `/readouts/${complete.id}/quantity?kind=energy&tariff=1`);
    assert.deepEqual(tariffed.values.map(item => item.value), [345000]);
    const volume = await get(app, `/readouts/${complete.id}/quantity?kind=volume`);
    assert.deepEqual(volume.values.map(item => item.value), [987.654]);
    const missing = await get(app, `/readouts/${complete.id}/quantity?kind=mass`);
    assert.equal(missing.status, 'not-provided');
    assert.match(missing.note, /无法解释/); // 有厂家扩展记录，不能排除相关

    const interrupted = await post(app, '/readouts', { path: '/meter/4/read' });
    const pending = await get(app, `/readouts/${interrupted.id}/quantity?kind=volume`);
    assert.equal(pending.status, 'incomplete');
    const partial = await get(app, `/readouts/${interrupted.id}/quantity?kind=energy`);
    assert.equal(partial.status, 'resolved');
    assert.equal(partial.partial, true); // 已得数值但尚未读完

    // 收到但不能解释：仅有特殊值的量
    const synthetic = {
      status: 'complete', fcb: null, device: { key: 'x' },
      frames: [{ digest: 'a', records: [
        { unit: { kind: 'energy', unit: 'Wh', exponent: 0 }, status: 'special-value', storage: 0, tariff: 0, rawBytes: 'ff', value: null },
      ] }],
    };
    const uninterpreted = lookupQuantity(synthetic, { kind: 'energy' });
    assert.equal(uninterpreted.status, 'uninterpreted');
    assert.equal(uninterpreted.records[0].rawBytes, 'ff');
  } finally { await cleanup(); }
});
