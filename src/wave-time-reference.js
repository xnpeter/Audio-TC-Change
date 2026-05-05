import {
  LITTLE,
  ascii,
  ixmlTimeReferenceValue,
  scanWave,
} from "./wave.js";

export function paddedDecimal(value, length, label) {
  const text = value.toString();
  if (text.length > length) throw new Error(`${label} 超出 iXML 字段宽度：${text.length}/${length}`);
  return text.padStart(length, "0");
}

export function decimalFits(value, length) {
  return value.toString().length <= length;
}

export function ixmlTimestampParts(value) {
  const base = 4294967296n;
  return {
    hi: value / base,
    lo: value % base,
  };
}

export async function writeAsciiAt(writable, position, text) {
  const data = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
  await writable.write({ type: "write", position, data });
}

export function ixmlNeedsRewrite(record, value) {
  if (!record.ixmlInfo) return false;
  const { timestampHi, timestampLo, timestampSampleRate } = record.ixmlInfo;
  const parts = ixmlTimestampParts(value);
  return Boolean(
    (timestampHi && !decimalFits(parts.hi, timestampHi.length)) ||
    (timestampLo && !decimalFits(parts.lo, timestampLo.length)) ||
    (timestampSampleRate && !decimalFits(BigInt(record.sampleRate), timestampSampleRate.length))
  );
}

export function replaceIxmlFieldText(xml, tag, value) {
  const pattern = new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`);
  return xml.replace(pattern, `$1${value}$2`);
}

export function rewriteIxmlChunkText(xml, record, value, targetIxmlInfo = record.ixmlInfo) {
  const parts = ixmlTimestampParts(value);
  const targetValue = ixmlTimeReferenceValue(targetIxmlInfo);
  const restoreTargetRaw = targetValue === value;
  let next = xml;
  if (record.ixmlInfo?.timestampHi || targetIxmlInfo?.timestampHi) {
    const text = restoreTargetRaw && targetIxmlInfo?.timestampHi
      ? targetIxmlInfo.timestampHi.raw
      : parts.hi.toString();
    next = replaceIxmlFieldText(next, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI", text);
  }
  if (record.ixmlInfo?.timestampLo || targetIxmlInfo?.timestampLo) {
    const text = restoreTargetRaw && targetIxmlInfo?.timestampLo
      ? targetIxmlInfo.timestampLo.raw
      : parts.lo.toString();
    next = replaceIxmlFieldText(next, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO", text);
  }
  if (record.ixmlInfo?.timestampSampleRate || targetIxmlInfo?.timestampSampleRate) {
    const text = restoreTargetRaw && targetIxmlInfo?.timestampSampleRate
      ? targetIxmlInfo.timestampSampleRate.raw
      : String(record.sampleRate);
    next = replaceIxmlFieldText(next, "TIMESTAMP_SAMPLE_RATE", text);
  }
  return next;
}

export function ixmlFieldShape(info) {
  if (!info) return "";
  return [
    info.timestampHi?.raw ?? "",
    info.timestampLo?.raw ?? "",
    info.timestampSampleRate?.raw ?? "",
  ].join("\u0000");
}

export function shouldRestoreIxmlShape(record, targetIxmlInfo, value) {
  if (!record.ixmlInfo || !targetIxmlInfo) return false;
  if (ixmlTimeReferenceValue(targetIxmlInfo) !== value) return false;
  return ixmlFieldShape(record.ixmlInfo) !== ixmlFieldShape(targetIxmlInfo);
}

export function chunkHeader(id, size) {
  const header = new Uint8Array(8);
  for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i);
  new DataView(header.buffer).setUint32(4, size, LITTLE);
  return header;
}

export function writeAsciiPadded(target, offset, length, text) {
  const safe = String(text).replace(/[^\x20-\x7e]/g, " ").slice(0, Math.max(0, length - 1));
  for (let i = 0; i < safe.length; i++) target[offset + i] = safe.charCodeAt(i);
}

export function writeAsciiPaddedMultiline(target, offset, length, text) {
  const safe = String(text).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ").slice(0, Math.max(0, length - 1));
  for (let i = 0; i < safe.length; i++) target[offset + i] = safe.charCodeAt(i);
}

export function writeAsciiFixed(target, offset, length, text) {
  const safe = String(text).replace(/[^\x20-\x7e]/g, " ").slice(0, length);
  for (let i = 0; i < safe.length; i++) target[offset + i] = safe.charCodeAt(i);
}

export function bextChunkData(record, value) {
  const data = new Uint8Array(602);
  const view = new DataView(data.buffer);
  const now = new Date();
  const yyyy = String(now.getFullYear()).padStart(4, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  writeAsciiPaddedMultiline(data, 0, 256, `Audio TC Change generated bext for ${record.name}`);
  writeAsciiPadded(data, 256, 32, "Audio TC Change");
  writeAsciiPadded(data, 288, 32, "AudioTCChange");
  writeAsciiFixed(data, 320, 10, `${yyyy}-${mm}-${dd}`);
  writeAsciiFixed(data, 330, 8, `${hh}:${mi}:${ss}`);
  view.setBigUint64(338, value, LITTLE);
  view.setUint16(346, 1, LITTLE);
  return data;
}

export async function rewriteWaveTimeReference(record, value, writable, targetIxmlInfo = record.ixmlInfo) {
  const file = await record.fileHandle.getFile();
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 12 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new Error(`${record.name}: 不是 RIFF/WAVE 文件`);
  }

  const descriptors = [];
  let hasBext = false;
  let pos = 12;
  const limit = Math.min(view.byteLength, view.getUint32(4, LITTLE) + 8);
  while (pos + 8 <= limit) {
    const id = ascii(view, pos, 4);
    const size = view.getUint32(pos + 4, LITTLE);
    const start = pos + 8;
    if (start + size > view.byteLength) throw new Error(`${record.name}: chunk 数据截断`);
    let data = new Uint8Array(buffer, start, size);

    if (id === "bext") {
      if (size < 346) throw new Error(`${record.name}: bext chunk 过短`);
      hasBext = true;
      data = new Uint8Array(data);
      new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(338, value, LITTLE);
    } else if (id === "iXML" && record.ixmlInfo) {
      const xml = new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
      data = new TextEncoder().encode(rewriteIxmlChunkText(xml, record, value, targetIxmlInfo));
    }

    descriptors.push({ id, data });
    pos = start + size + (size & 1);
  }

  if (!hasBext) {
    const insertAt = Math.max(1, descriptors.findIndex(descriptor => descriptor.id === "data"));
    const descriptor = { id: "bext", data: bextChunkData(record, value) };
    if (insertAt > 0) descriptors.splice(insertAt, 0, descriptor);
    else descriptors.push(descriptor);
  }

  let riffSize = 4;
  for (const descriptor of descriptors) {
    riffSize += 8 + descriptor.data.byteLength + (descriptor.data.byteLength & 1);
  }
  if (riffSize > 0xffffffff) throw new Error(`${record.name}: 文件超过 RIFF 4GB 大小限制`);

  const riffHeader = new Uint8Array(12);
  riffHeader.set([82, 73, 70, 70], 0);
  new DataView(riffHeader.buffer).setUint32(4, riffSize, LITTLE);
  riffHeader.set([87, 65, 86, 69], 8);

  let writePos = 0;
  await writable.write({ type: "write", position: writePos, data: riffHeader });
  writePos += riffHeader.byteLength;

  const pad = new Uint8Array([0]);
  for (const descriptor of descriptors) {
    const header = chunkHeader(descriptor.id, descriptor.data.byteLength);
    await writable.write({ type: "write", position: writePos, data: header });
    writePos += header.byteLength;
    await writable.write({ type: "write", position: writePos, data: descriptor.data });
    writePos += descriptor.data.byteLength;
    if (descriptor.data.byteLength & 1) {
      await writable.write({ type: "write", position: writePos, data: pad });
      writePos += 1;
    }
  }
  await writable.truncate(writePos);
}

export async function writeIxmlTimeReference(record, value, writable) {
  if (!record.ixmlInfo) return false;
  const { timestampHi, timestampLo, timestampSampleRate } = record.ixmlInfo;
  const parts = ixmlTimestampParts(value);
  let wrote = false;

  if (timestampHi) {
    await writeAsciiAt(writable, timestampHi.position, paddedDecimal(parts.hi, timestampHi.length, `${record.name} iXML timestamp HI`));
    wrote = true;
  }
  if (timestampLo) {
    await writeAsciiAt(writable, timestampLo.position, paddedDecimal(parts.lo, timestampLo.length, `${record.name} iXML timestamp LO`));
    wrote = true;
  }
  if (timestampSampleRate) {
    await writeAsciiAt(writable, timestampSampleRate.position, paddedDecimal(BigInt(record.sampleRate), timestampSampleRate.length, `${record.name} iXML timestamp sample rate`));
    wrote = true;
  }
  return wrote;
}

export async function writeTimeReference(preview, value, writable = null) {
  const record = (!writable && preview.fileHandle)
    ? await scanWave(preview.fileHandle, {
      relativePath: preview.relativePath,
      parentPath: preview.parentPath,
      parentHandle: preview.parentHandle,
    })
    : preview;
  const patch = new ArrayBuffer(8);
  new DataView(patch).setBigUint64(0, value, LITTLE);
  const ownWritable = !writable;
  const restoreShape = shouldRestoreIxmlShape(record, preview.ixmlInfo, value);
  const needsBext = !record.hasBext || record.timeReferenceOffset === null;
  const needsRewrite = needsBext || restoreShape || ixmlNeedsRewrite(record, value);
  const target = writable || await record.fileHandle.createWritable({ keepExistingData: !needsRewrite });
  try {
    if (needsRewrite) {
      await rewriteWaveTimeReference(record, value, target, restoreShape ? preview.ixmlInfo : record.ixmlInfo);
    } else {
      await target.write({ type: "write", position: record.timeReferenceOffset, data: patch });
      await writeIxmlTimeReference(record, value, target);
    }
  } finally {
    if (ownWritable) await target.close();
  }
}

export function verifyIxmlTimeReference(record, expected, label) {
  const ixmlValue = ixmlTimeReferenceValue(record.ixmlInfo);
  if (ixmlValue !== null && ixmlValue !== expected) {
    throw new Error(`${label}: iXML TimeReference 校验失败`);
  }
}
