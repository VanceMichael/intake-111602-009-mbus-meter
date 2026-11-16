import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('抄表续帧与重传帧保留同一设备身份，换表后身份变化', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const first = decode((await client.request('/meter/1/read')).bytes);
    const repeat = decode((await client.request('/meter/1/next?fcb=0')).bytes);
    const last = decode((await client.request('/meter/1/next?fcb=1')).bytes);
    assert.deepEqual(first, repeat);
    assert.equal(first.more, true); assert.equal(last.more, false);
    assert.equal(first.identification, last.identification);
    await client.control({ action: 'advance' });
    const replaced = decode((await client.request('/meter/1/read')).bytes);
    assert.equal(replaced.address, first.address);
    assert.notEqual(replaced.identification, first.identification);
    const broken = Buffer.from((await client.request('/meter/1/read')).bytes); broken[20] ^= 1;
    assert.throws(() => decode(broken), /校验/);
  } finally { await source.close(); }
});
