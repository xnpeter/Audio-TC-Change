import {
  LITTLE,
  chunkSize32,
  ds64ChunkData,
  ixmlTimeReferenceValue,
  listWaveChunks,
  scanWave,
  toSafeNumber,
  waveFileHeader,
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
  new DataView(header.buffer).setUint32(4, chunkSize32(size), LITTLE);
  return header;
}

const COPY_CHUNK_SIZE = 8 * 1024 * 1024;

async function copyFileRange(file, writable, sourceStart, sourceSize, destPos) {
  let remaining = sourceSize;
  let src = sourceStart;
  let dest = destPos;
  while (remaining > 0) {
    const bytes = Math.min(COPY_CHUNK_SIZE, remaining);
    const data = new Uint8Array(await file.slice(src, src + bytes).arrayBuffer());
    await writable.write({ type: "write", position: dest, data });
    src += bytes;
    dest += bytes;
    remaining -= bytes;
  }
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
  const listed = await listWaveChunks(file, record.name);
  const smallChunkMax = 4 * 1024 * 1024;
  const descriptors = [];
  let hasBext = false;
  let outDataSize = 0n;

  for (const chunk of listed.chunks) {
    if (chunk.id === "ds64") continue;
    const size = toSafeNumber(chunk.size, `${record.name} ${chunk.id} chunk`);
    if (chunk.id === "data" || size > smallChunkMax) {
      if (chunk.id === "data") outDataSize = chunk.size;
      descriptors.push({ id: chunk.id, fileOffset: chunk.start, size: chunk.size, stream: true });
      continue;
    }

    let data = new Uint8Array(await file.slice(chunk.start, chunk.start + size).arrayBuffer());
    if (chunk.id === "bext") {
      if (data.byteLength < 346) throw new Error(`${record.name}: bext chunk 过短`);
      hasBext = true;
      data = new Uint8Array(data);
      new DataView(data.buffer).setBigUint64(338, value, LITTLE);
    } else if (chunk.id === "iXML" && record.ixmlInfo) {
      const xml = new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
      data = new TextEncoder().encode(rewriteIxmlChunkText(xml, record, value, targetIxmlInfo));
    }
    descriptors.push({ id: chunk.id, data });
  }

  if (!hasBext) {
    const insertAt = Math.max(0, descriptors.findIndex(descriptor => descriptor.id === "data"));
    const descriptor = { id: "bext", data: bextChunkData(record, value) };
    if (insertAt >= 0) descriptors.splice(insertAt, 0, descriptor);
    else descriptors.push(descriptor);
  }

  let estimated = 4;
  for (const descriptor of descriptors) {
    const size = descriptor.stream ? toSafeNumber(descriptor.size, `${record.name} ${descriptor.id}`) : descriptor.data.byteLength;
    estimated += 8 + size + (size & 1);
  }
  const keep64 = listed.container === "RF64" || listed.container === "BW64";
  const use64 = keep64 || estimated > 0xffffffff;
  const outContainer = listed.container === "BW64" ? "BW64" : use64 ? "RF64" : "RIFF";

  let writePos = 0;
  await writable.write({
    type: "write",
    position: 0,
    data: waveFileHeader(outContainer, outContainer === "RIFF" ? 0 : 0xffffffff),
  });
  writePos = 12;

  let ds64Pos = null;
  if (outContainer !== "RIFF") {
    ds64Pos = writePos;
    const placeholder = new Uint8Array(36);
    placeholder.set([0x64, 0x73, 0x36, 0x34], 0);
    new DataView(placeholder.buffer).setUint32(4, 28, LITTLE);
    await writable.write({ type: "write", position: writePos, data: placeholder });
    writePos += placeholder.byteLength;
  }

  const pad = new Uint8Array([0]);
  for (const descriptor of descriptors) {
    const size = descriptor.stream ? descriptor.size : BigInt(descriptor.data.byteLength);
    if (descriptor.id === "data") outDataSize = size;
    const sizeNumber = toSafeNumber(size, `${record.name} ${descriptor.id}`);
    await writable.write({ type: "write", position: writePos, data: chunkHeader(descriptor.id, size) });
    writePos += 8;
    if (descriptor.stream) {
      await copyFileRange(file, writable, descriptor.fileOffset, sizeNumber, writePos);
    } else {
      await writable.write({ type: "write", position: writePos, data: descriptor.data });
    }
    writePos += sizeNumber;
    if (sizeNumber & 1) {
      await writable.write({ type: "write", position: writePos, data: pad });
      writePos += 1;
    }
  }

  const riffSize = writePos - 8;
  if (outContainer === "RIFF") {
    if (riffSize > 0xffffffff) throw new Error(`${record.name}: 文件超过 RIFF 4GB 大小限制`);
    const sizePatch = new Uint8Array(4);
    new DataView(sizePatch.buffer).setUint32(0, riffSize, LITTLE);
    await writable.write({ type: "write", position: 4, data: sizePatch });
  } else {
    const sampleCount = record.blockAlign
      ? outDataSize / BigInt(record.blockAlign)
      : record.durationSamples || 0n;
    await writable.write({
      type: "write",
      position: ds64Pos + 8,
      data: ds64ChunkData({ riffSize, dataSize: outDataSize, sampleCount }),
    });
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
  const patch = new Uint8Array(8);
  new DataView(patch.buffer).setBigUint64(0, value, LITTLE);
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
