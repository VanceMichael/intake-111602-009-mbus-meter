// EN 13757-3 长帧与数据记录解释。
// 原则：能理解的给出数值与单位；未理解的单位、厂家扩展与特殊数值只保留原字节，
// 绝不按普通数字入账。

const DATA_FIELDS = {
  0x0: { size: 0, kind: 'none' },
  0x1: { size: 1, kind: 'int' },
  0x2: { size: 2, kind: 'int' },
  0x3: { size: 3, kind: 'int' },
  0x4: { size: 4, kind: 'int' },
  0x5: { size: 4, kind: 'float32' },
  0x6: { size: 6, kind: 'int' },
  0x7: { size: 8, kind: 'int' },
  0x8: { size: 0, kind: 'readout-selection' },
  0x9: { size: 1, kind: 'bcd' },
  0xa: { size: 2, kind: 'bcd' },
  0xb: { size: 3, kind: 'bcd' },
  0xc: { size: 4, kind: 'bcd' },
  0xd: { size: null, kind: 'variable' },
  0xe: { size: 6, kind: 'bcd' },
};

const FUNCTION_FIELDS = ['instantaneous', 'maximum', 'minimum', 'error-value'];

const TIME_UNITS = ['s', 'min', 'h', 'd'];

// 主 VIF 表（EN 13757-3 常用部分）：返回 { kind, unit, exponent }，
// 数值 = 原始值 × 10^exponent，单位为 unit。返回 null 表示本地不理解。
function primaryVif(code) {
  if (code <= 0x07) return { kind: 'energy', unit: 'Wh', exponent: code - 0x00 - 3 };
  if (code <= 0x0f) return { kind: 'energy', unit: 'J', exponent: code - 0x08 - 3 };
  if (code <= 0x17) return { kind: 'volume', unit: 'm3', exponent: code - 0x10 - 6 };
  if (code <= 0x1f) return { kind: 'mass', unit: 'kg', exponent: code - 0x18 - 6 };
  if (code <= 0x23) return { kind: 'time', unit: TIME_UNITS[code - 0x20], exponent: 0, role: 'on-time' };
  if (code <= 0x27) return { kind: 'time', unit: TIME_UNITS[code - 0x24], exponent: 0, role: 'operating-time' };
  if (code <= 0x2f) return { kind: 'power', unit: 'W', exponent: code - 0x28 - 3 };
  if (code <= 0x37) return { kind: 'power', unit: 'J/h', exponent: code - 0x30 - 3 };
  if (code <= 0x3f) return { kind: 'volume-flow', unit: 'm3/h', exponent: code - 0x38 - 6 };
  if (code <= 0x47) return { kind: 'volume-flow', unit: 'm3/min', exponent: code - 0x40 - 7 };
  if (code <= 0x4f) return { kind: 'volume-flow', unit: 'm3/s', exponent: code - 0x48 - 5 };
  if (code <= 0x57) return { kind: 'mass-flow', unit: 'kg/h', exponent: code - 0x50 - 3 };
  if (code <= 0x5b) return { kind: 'temperature', unit: '°C', exponent: code - 0x58 - 3, role: 'flow-temperature' };
  if (code <= 0x5f) return { kind: 'temperature', unit: '°C', exponent: code - 0x5c - 3, role: 'return-temperature' };
  if (code <= 0x63) return { kind: 'temperature-difference', unit: 'K', exponent: code - 0x60 - 3 };
  if (code <= 0x67) return { kind: 'temperature', unit: '°C', exponent: code - 0x64 - 3, role: 'external-temperature' };
  if (code <= 0x6b) return { kind: 'pressure', unit: 'bar', exponent: code - 0x68 - 3 };
  if (code === 0x6e) return { kind: 'hca', unit: 'HCA', exponent: 0 };
  if (code <= 0x73) return { kind: 'time', unit: TIME_UNITS[code - 0x70], exponent: 0, role: 'averaging-duration' };
  if (code <= 0x77) return { kind: 'time', unit: TIME_UNITS[code - 0x74], exponent: 0, role: 'actuality-duration' };
  return null;
}

export function manufacturerLetters(word) {
  const letter = shift => String.fromCharCode(64 + ((word >> shift) & 0x1f));
  return `${letter(10)}${letter(5)}${letter(0)}`;
}

function decodeBcd(bytes) {
  let value = 0n;
  let factor = 1n;
  for (const byte of bytes) {
    const low = byte & 0x0f;
    const high = byte >> 4;
    if (low > 9 || high > 9) return null; // 特殊/无效数值，不能按普通数字
    value += BigInt(low + high * 10) * factor;
    factor *= 100n;
  }
  return value;
}

function safeNumber(value) {
  return value <= 9007199254740991n && value >= -9007199254740991n ? Number(value) : null;
}

function scaleValue(raw, exponent) {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw)) return null;
  return exponent >= 0 ? raw * 10 ** exponent : raw / 10 ** -exponent;
}

// 解析一条记录，返回 { record, offset }；offset 指向下一条记录。
function parseRecord(body, offset) {
  const start = offset;
  const dif = body[offset++];
  const field = DATA_FIELDS[dif & 0x0f];
  const dife = [];
  let extension = (dif & 0x80) !== 0;
  let storage = (dif & 0x40) !== 0 ? 1 : 0;
  let tariff = 0;
  let subunit = 0;
  let tariffShift = 0;
  let subunitShift = 0;
  let storageShift = 1;
  while (extension) {
    if (offset >= body.length) throw new Error('记录数据越界');
    const byte = body[offset++];
    dife.push(byte);
    if (byte & 0x40) storage |= 1 << storageShift;
    tariff |= ((byte >> 4) & 0x03) << tariffShift;
    subunit |= (byte & 0x0f) << subunitShift;
    storageShift += 1;
    tariffShift += 2;
    subunitShift += 4;
    extension = (byte & 0x80) !== 0;
  }
  if (offset >= body.length) throw new Error('记录数据越界');
  const vif = body[offset++];
  const vife = [];
  let vifExtension = (vif & 0x80) !== 0;
  while (vifExtension) {
    if (offset >= body.length) throw new Error('记录数据越界');
    const byte = body[offset++];
    vife.push(byte);
    vifExtension = (byte & 0x80) !== 0;
  }
  const vifCode = vif & 0x7f;

  let size = field?.size ?? null;
  let variable = null;
  if (field?.kind === 'variable') {
    if (offset >= body.length) throw new Error('记录数据越界');
    const lvar = body[offset++];
    if (lvar <= 0xbf) size = lvar;
    else if (lvar <= 0xcf) size = lvar - 0xc0; // 每字节两位 BCD
    else size = null; // 长度语义未理解，无法继续拆分
    variable = lvar;
    if (size === null) {
      return {
        record: {
          dif, dife, vif, vife, dataType: 'variable', storage, tariff, subunit,
          fn: FUNCTION_FIELDS[(dif >> 4) & 0x03], unit: null, rawValue: null, value: null,
          status: 'unsupported-coding',
          note: `可变长度编码 0x${lvar.toString(16)} 未理解，其后字节按原文保留`,
          rawBytes: Buffer.from(body.subarray(start)).toString('hex'),
        },
        offset: body.length,
        tail: Buffer.from(body.subarray(start)).toString('hex'),
      };
    }
  }
  if (size === null || offset + size > body.length) throw new Error('记录数据越界');
  const data = body.subarray(offset, offset + size);
  offset += size;

  const record = {
    dif, dife, vif, vife,
    dataType: field.kind === 'int' ? `int${size * 8}` : field.kind === 'bcd' ? `bcd${size * 2}` : field.kind,
    storage, tariff, subunit,
    fn: FUNCTION_FIELDS[(dif >> 4) & 0x03],
    unit: null, rawValue: null, value: null,
    status: 'resolved', note: null,
    rawBytes: Buffer.from(body.subarray(start, offset)).toString('hex'),
  };
  if (variable !== null) record.lvar = variable;

  // 原始数值与特殊值判定
  let special = false;
  if (field.kind === 'int') {
    const raw = size <= 6
      ? BigInt(Buffer.from(data).readIntLE(0, size))
      : Buffer.from(data).readBigInt64LE(0);
    const number = safeNumber(raw);
    record.rawValue = number ?? raw.toString(10);
    if (number === null) record.note = '数值超出安全整数范围，原始文本保留在 rawValue';
  } else if (field.kind === 'float32') {
    const raw = Buffer.from(data).readFloatLE(0);
    if (Number.isNaN(raw) || !Number.isFinite(raw)) special = true;
    else record.rawValue = raw;
  } else if (field.kind === 'bcd') {
    const raw = decodeBcd(data);
    if (raw === null) special = true;
    else {
      const number = safeNumber(raw);
      record.rawValue = number ?? raw.toString(10);
    }
  } else if (field.kind === 'none' || field.kind === 'readout-selection') {
    record.status = 'no-data';
    record.note = '该记录不带数值';
  } else if (field.kind === 'variable') {
    record.status = 'unsupported-coding';
    record.note = '可变长度数据暂未解释，原字节已保留';
  }

  // 单位判定：厂家扩展与未理解单位只保留原字节
  if (vifCode === 0x7f) {
    record.status = 'manufacturer-specific';
    record.note = '厂家专用记录，原字节保留';
  } else if (vifCode === 0x7c || vifCode === 0x7e) {
    record.status = 'unknown-unit';
    record.note = 'VIF 由后续内容给出，本地未解释';
  } else if (vife.length > 0) {
    record.status = 'unknown-unit';
    record.note = 'VIF 扩展未理解，不按普通数字入账';
  } else {
    const unit = primaryVif(vifCode);
    if (unit) record.unit = unit;
    else if (record.status === 'resolved') {
      record.status = 'unknown-unit';
      record.note = `VIF 0x${vifCode.toString(16).padStart(2, '0')} 未理解，不按普通数字入账`;
    }
  }

  if (special) {
    record.status = 'special-value';
    record.note = '数值为特殊/无效编码，不按普通数字入账';
    record.rawValue = null;
    record.value = null;
    return { record, offset };
  }
  if (record.status === 'resolved' && record.unit) {
    const scaled = scaleValue(record.rawValue, record.unit.exponent);
    if (scaled === null) {
      record.status = 'special-value';
      record.note = '数值超出可精确表示范围，不按普通数字入账';
    } else {
      record.value = scaled;
    }
  } else {
    record.value = null;
  }
  return { record, offset };
}

// 解析一帧：身份、记录、续帧标记、厂家专用尾部。
export function parseFrame(bytes) {
  if (bytes.length < 21 || bytes[0] !== 0x68 || bytes[3] !== 0x68 || bytes[1] !== bytes[2] || bytes.length !== bytes[1] + 6 || bytes.at(-1) !== 0x16) throw new Error('不是完整 M-Bus 长帧');
  const body = bytes.subarray(4, -2);
  if ((body.reduce((sum, item) => sum + item, 0) & 255) !== bytes.at(-2)) throw new Error('帧校验和错误');
  if (body[2] !== 0x72) throw new Error('不支持此响应结构');

  const identification = [...body.subarray(3, 7)].reverse().map(item => item.toString(16).padStart(2, '0')).join('');
  const manufacturerWord = body[7] | (body[8] << 8);
  const identity = {
    identification,
    manufacturer: manufacturerLetters(manufacturerWord),
    manufacturerCode: manufacturerWord.toString(16).padStart(4, '0'),
    version: body[9],
    medium: body[10],
  };
  identity.key = `${identity.identification}-${identity.manufacturerCode}-${identity.version}-${identity.medium}`;

  const records = [];
  let more = false;
  let tail = null;
  let offset = 15;
  while (offset < body.length) {
    const dif = body[offset];
    if ((dif & 0x0f) === 0x0f) {
      if (dif === 0x1f) { more = true; offset += 1; }
      else if (dif === 0x0f) offset += 1;
      else if (dif === 0x2f) { offset += 1; continue; } // 填充字节
      else offset += 1; // 未识别的特殊功能：余下按原文保留
      if (offset < body.length) tail = Buffer.from(body.subarray(offset)).toString('hex');
      break;
    }
    const parsed = parseRecord(body, offset);
    records.push(parsed.record);
    offset = parsed.offset;
    if (parsed.tail !== undefined) { tail = parsed.tail; break; }
  }
  return { address: body[1], identity, access: body[11], records, more, manufacturerTail: tail };
}
