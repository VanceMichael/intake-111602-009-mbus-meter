import { parseFrame } from './mbus.mjs';

// 单帧预览：身份（识别号/厂家/版本/介质）、访问号、记录列表、续帧标记。
// 记录带当时的定义（DIF/VIF 原文、存储号、费率、单位），未理解的只留原字节。
export function decode(bytes) {
  const frame = parseFrame(bytes);
  return {
    address: frame.address,
    identification: frame.identity.identification,
    manufacturer: frame.identity.manufacturer,
    manufacturerCode: frame.identity.manufacturerCode,
    version: frame.identity.version,
    medium: frame.identity.medium,
    identity: frame.identity.key,
    access: frame.access,
    records: frame.records,
    more: frame.more,
    manufacturerTail: frame.manufacturerTail,
  };
}
