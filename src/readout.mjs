import { createHash } from 'node:crypto';
import { decode } from './decode.mjs';

const MAX_FRAMES = 32;
const MAX_RETRANSMISSIONS = 2;

export function continuationPath(readPath, fcb) {
  const url = new URL(readPath, 'http://localhost');
  if (!url.pathname.endsWith('/read')) throw new Error('资料入口须以 /read 结尾');
  return `${url.pathname.replace(/\/read$/, '/next')}?fcb=${fcb}`;
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchFrame(client, path) {
  const result = await client.request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  let frame;
  try {
    frame = decode(result.bytes);
  } catch (error) {
    throw new Error(`帧无法解释：${error.message}`);
  }
  return { result, frame };
}

async function acceptFrame(session, catalog, { result, frame }, fcb) {
  const receipt = await catalog.accept({
    source: result.url,
    bytes: result.bytes,
    mediaType: result.headers['content-type'],
    preview: frame,
    session: session.id,
  });
  session.frames.push({
    digest: receipt.digest,
    bytes: result.bytes.length,
    fcb,
    access: frame.access,
    more: frame.more,
    records: frame.records,
    manufacturerTail: frame.manufacturerTail,
    receivedAt: receipt.receivedAt,
  });
  if (!session.device) {
    session.device = {
      primaryAddress: frame.address,
      identification: frame.identification,
      manufacturer: frame.manufacturer,
      manufacturerCode: frame.manufacturerCode,
      version: frame.version,
      medium: frame.medium,
      key: frame.identity,
    };
  }
}

// 执行一次设备资料领取：首帧之后按帧计数位续读，直到没有后续记录。
// 网关重发的旧帧不算新读数；身份不一致的帧绝不拼入本次领取。
// 任何中断都把已核对的进度与设备身份留在会话里。
export async function collect(session, { client, catalog, sessions }) {
  session.status = 'in-progress';
  session.error = null;
  try {
    if (session.frames.length === 0) {
      await acceptFrame(session, catalog, await fetchFrame(client, session.path), null);
      await sessions.save(session);
    }
    let retransmissions = 0;
    while (session.frames.at(-1).more) {
      if (session.frames.length >= MAX_FRAMES) throw new Error('续帧数量超出上限，采集中止');
      const fcb = session.fcb;
      const received = await fetchFrame(client, continuationPath(session.path, fcb));
      const digest = digestOf(received.result.bytes);
      if (session.frames.some(frame => frame.digest === digest)) {
        // 重传帧：不是新读数，换计数位再要
        retransmissions += 1;
        if (retransmissions > MAX_RETRANSMISSIONS) throw new Error('网关反复重发旧帧，采集未能推进');
        session.fcb = 1 - session.fcb;
        continue;
      }
      if (received.frame.identity !== session.device.key) {
        // 不同设备的帧：留证但不拼入
        const receipt = await catalog.accept({
          source: received.result.url,
          bytes: received.result.bytes,
          mediaType: received.result.headers['content-type'],
          preview: received.frame,
          session: session.id,
          rejected: true,
        });
        session.rejected.push({
          digest: receipt.digest,
          identity: received.frame.identity,
          receivedAt: receipt.receivedAt,
          reason: `帧身份 ${received.frame.identity} 与会话设备 ${session.device.key} 不一致`,
        });
        const error = new Error(`续帧身份不一致：期望 ${session.device.key}，收到 ${received.frame.identity}，已拒绝拼入`);
        error.identityMismatch = true;
        throw error;
      }
      await acceptFrame(session, catalog, received, fcb);
      session.fcb = 1 - session.fcb;
      retransmissions = 0;
      await sessions.save(session);
    }
    session.status = 'complete';
    session.completedAt = new Date().toISOString();
  } catch (error) {
    session.status = error.identityMismatch ? 'failed' : 'interrupted';
    session.error = error.message;
  }
  await sessions.save(session);
  return session;
}
