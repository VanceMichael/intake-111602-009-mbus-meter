// 台账组合：把一次领取的各帧记录按顺序汇总，数值始终与当时的记录定义、
// 存储号、费率放在一起；未理解的记录保留原字节，不进数值列表。

export function buildLedger(session) {
  const records = [];
  session.frames.forEach((frame, frameIndex) => {
    frame.records.forEach((record, recordIndex) => {
      records.push({ sequence: records.length, frameIndex, recordIndex, frameDigest: frame.digest, ...record });
    });
  });
  return {
    device: session.device,
    status: session.status,
    complete: session.status === 'complete',
    frames: session.frames.map(frame => ({
      digest: frame.digest, bytes: frame.bytes, access: frame.access,
      more: frame.more, manufacturerTail: frame.manufacturerTail, receivedAt: frame.receivedAt,
    })),
    records,
    uninterpreted: records.filter(record => record.status !== 'resolved' && record.status !== 'no-data'),
  };
}

// 管理人员视角的量查询：区分 已得数值 / 设备未提供 / 尚未读完 / 收到但不能解释。
export function lookupQuantity(session, { kind, storage = null, tariff = null }) {
  if (!kind) throw new Error('缺少 kind 参数');
  const ledger = buildLedger(session);
  const partial = session.status !== 'complete';
  const matches = ledger.records.filter(record =>
    record.unit?.kind === kind &&
    (storage === null || record.storage === storage) &&
    (tariff === null || record.tariff === tariff));
  const resolved = matches.filter(record => record.status === 'resolved');
  const base = {
    kind, storage, tariff,
    device: session.device,
    readout: session.status,
    partial,
    progress: {
      frames: session.frames.length,
      records: ledger.records.length,
      nextFcb: session.status === 'complete' ? null : session.fcb,
    },
  };
  if (resolved.length > 0) {
    return { ...base, status: 'resolved',
      values: resolved.map(record => ({
        value: record.value, unit: record.unit.unit, kind: record.unit.kind,
        storage: record.storage, tariff: record.tariff, fn: record.fn,
        frameDigest: record.frameDigest, sequence: record.sequence,
      })) };
  }
  if (partial) return { ...base, status: 'incomplete', note: '采集尚未读完，暂不能断定设备是否提供该量' };
  if (matches.length > 0) {
    return { ...base, status: 'uninterpreted', note: '收到该量记录但不能解释，原字节已保留',
      records: matches.map(record => ({
        sequence: record.sequence, status: record.status, note: record.note,
        storage: record.storage, tariff: record.tariff, rawBytes: record.rawBytes,
      })) };
  }
  const unattributed = ledger.records.filter(record =>
    record.status === 'unknown-unit' || record.status === 'manufacturer-specific' || record.status === 'unsupported-coding');
  return { ...base, status: 'not-provided',
    note: unattributed.length > 0
      ? `设备未提供可识别的该量；另有 ${unattributed.length} 条记录无法解释，不能排除与该量有关`
      : '设备在本次完整领取中未提供该量' };
}
