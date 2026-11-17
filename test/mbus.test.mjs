import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decode } from '../src/decode.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/ledger.json', import.meta.url), 'utf8'));
const frame = (meter, index, phase = 0) =>
  decode(Buffer.from(fixture.phases[phase].meters[meter].frames[index], 'base64'));

test('记录定义包含存储号、费率与单位，数值按定义换算', () => {
  const first = frame('2', 0);
  assert.equal(first.identity, '11223344-2c2d-1-2');
  assert.equal(first.manufacturer, 'KAM');
  assert.equal(first.more, true);
  const [base, stored, tariffed] = first.records;
  assert.deepEqual(
    { storage: base.storage, tariff: base.tariff, value: base.value, unit: base.unit },
    { storage: 0, tariff: 0, value: 12345000, unit: { kind: 'energy', unit: 'Wh', exponent: 3 } });
  assert.equal(stored.storage, 1);
  assert.equal(stored.value, 11000000);
  assert.equal(tariffed.tariff, 1);
  assert.equal(tariffed.value, 345000);
  assert.equal(tariffed.dife.length, 1);
});

test('特殊 BCD、厂家扩展与未理解单位只留原字节，不按普通数字入账', () => {
  const second = frame('2', 1);
  const [volume, broken, vendor, extended] = second.records;
  assert.equal(volume.unit.kind, 'volume');
  assert.equal(volume.value, 987.654);
  assert.equal(broken.status, 'special-value');
  assert.equal(broken.value, null);
  assert.equal(broken.rawValue, null);
  assert.match(broken.rawBytes, /f2$/);
  assert.equal(vendor.status, 'manufacturer-specific');
  assert.equal(vendor.value, null);
  assert.equal(extended.status, 'unknown-unit');
  assert.equal(extended.value, null);
  assert.ok(extended.vife.length > 0);
});

test('浮点、温度与厂家专用尾部', () => {
  const last = frame('2', 2);
  assert.equal(last.more, false);
  assert.equal(last.manufacturerTail, 'deadbeef');
  const [power, temperature, real] = last.records;
  assert.deepEqual({ value: power.value, unit: power.unit.unit }, { value: 4200, unit: 'W' });
  assert.equal(temperature.value, 65);
  assert.equal(temperature.unit.kind, 'temperature');
  assert.equal(real.value, 1.5);
  assert.equal(real.dataType, 'float32');
});

test('身份不一致的续帧身份键不同', () => {
  assert.notEqual(frame('5', 0).identity, frame('5', 1).identity);
});

test('损坏帧仍被拒绝', () => {
  const bytes = Buffer.from(fixture.phases[0].meters['2'].frames[0], 'base64');
  bytes[20] ^= 1;
  assert.throws(() => decode(bytes), /校验/);
});
