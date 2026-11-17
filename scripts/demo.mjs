import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  // 一次设备资料领取：首帧 + 续帧组合，数值对应记录定义/存储号/费率
  const readout = await fetch(`${app.base}/readouts`, { method: 'POST', body: '{}' }).then(response => response.json());
  process.stdout.write(`领取状态：${readout.status}，设备：${readout.device.key}，帧数：${readout.frames.length}\n`);
  for (const record of readout.ledger.records) {
    const text = record.status === 'resolved'
      ? `${record.value} ${record.unit.unit}（存储 ${record.storage}，费率 ${record.tariff}）`
      : `未入账（${record.status}）：${record.note}`;
    process.stdout.write(`  记录 ${record.sequence}: ${text}\n`);
  }
  const energy = await fetch(`${app.base}/readouts/${readout.id}/quantity?kind=energy`).then(response => response.json());
  process.stdout.write(`能量查询：${energy.status}\n${JSON.stringify(energy.values ?? energy.note, null, 2)}\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
