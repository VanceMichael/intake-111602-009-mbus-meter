export function decode(bytes) {
  if (bytes.length < 21 || bytes[0] !== 0x68 || bytes[3] !== 0x68 || bytes[1] !== bytes[2] || bytes.length !== bytes[1] + 6 || bytes.at(-1) !== 0x16) throw new Error('不是完整 M-Bus 长帧');
  const body = bytes.subarray(4, -2);
  if ((body.reduce((sum, item) => sum + item, 0) & 255) !== bytes.at(-2)) throw new Error('帧校验和错误');
  if (body[2] !== 0x72) throw new Error('不支持此响应结构');
  const identification = [...body.subarray(3, 7)].reverse().map(item => item.toString(16).padStart(2, '0')).join('');
  const records = [];
  let offset = 15;
  let more = false;
  while (offset < body.length) {
    const dif = body[offset++];
    if (dif === 0x1f) { more = true; break; }
    if (dif === 0x0f) break;
    const vif = body[offset++];
    if ((dif & 15) !== 4 || offset + 4 > body.length) throw new Error('当前预览不支持此记录长度');
    records.push({ dif, vif, raw: body.readInt32LE(offset) }); offset += 4;
  }
  return { address: body[1], identification, access: body[11], records, more };
}
