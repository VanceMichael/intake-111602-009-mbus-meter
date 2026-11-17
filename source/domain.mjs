// 本地网关模型：/meter/<n>/read 给出首帧，/meter/<n>/next?fcb=N 按帧计数位推进。
// 计数位不变 → 重发当前帧（通讯确认，不是新读数）；计数位翻转 → 给出下一帧。
// 帧队列与身份由场景 fixtures 的 meters 配置给出，换表即换身份。
export function dispatch({ url, phase, state, config }) {
  if (url.pathname === '/meter/1/identity') return { json: { primaryAddress: 1,
    secondaryAddress: phase ? '87654321-2c2d-1-4' : '12345678-2c2d-1-4', accessNumber: 5 } };

  const match = /^\/meter\/(\d+)\/(read|next|identity)$/.exec(url.pathname);
  if (!match) return null;
  const meter = config?.meters?.[match[1]];
  if (!meter) return null;
  const slot = state[`meter:${match[1]}`] ??= { index: 0, fcb: '0', dropped: false };
  const frameAt = index => ({ base64: meter.frames[index],
    headers: { 'content-type': 'application/octet-stream' } });

  if (match[2] === 'identity') {
    return { json: { primaryAddress: Number(match[1]),
      secondaryAddress: meter.identity, accessNumber: 0 } };
  }
  if (match[2] === 'read') {
    slot.index = 0;
    slot.fcb = '0';
    return frameAt(0);
  }
  const fcb = url.searchParams.get('fcb');
  if (fcb === slot.fcb) return frameAt(slot.index); // 重发上一帧
  if (meter.dropOnce && !slot.dropped) {
    slot.dropped = true; // 断连前不把计数位让给下一帧
    return { disconnect: true, base64: meter.frames[slot.index],
      headers: { 'content-type': 'application/octet-stream' } };
  }
  if (slot.index < meter.frames.length - 1) {
    slot.index += 1;
    slot.fcb = fcb;
  }
  return frameAt(slot.index);
}
