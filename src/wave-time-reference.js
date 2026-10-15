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

function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function findBytes(haystack, needle, from = 0) {
  if (!needle.length) return -1;
  const limit = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

export function replaceIxmlFieldBytes(data, tag, value) {
  const open = asciiBytes(`<${tag}>`);
  const close = asciiBytes(`</${tag}>`);
  const openAt = findBytes(data, open);
  if (openAt < 0) return data;
  const valueStart = openAt + open.length;
  const closeAt = findBytes(data, close, valueStart);
  if (closeAt < 0) return data;
  const replacement = asciiBytes(String(value));
  const next = new Uint8Array(valueStart + replacement.length + (data.length - closeAt));
  next.set(data.subarray(0, valueStart), 0);
  next.set(replacement, valueStart);
  next.set(data.subarray(closeAt), valueStart + replacement.length);
  return next;
}

export function rewriteIxmlChunkBytes(data, record, value, targetIxmlInfo = record.ixmlInfo) {
  const parts = ixmlTimestampParts(value);
  const targetValue = ixmlTimeReferenceValue(targetIxmlInfo);
  const restoreTargetRaw = targetValue === value;
  const fields = [
    ["TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI", record.ixmlInfo?.timestampHi, targetIxmlInfo?.timestampHi, parts.hi],
    ["TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO", record.ixmlInfo?.timestampLo, targetIxmlInfo?.timestampLo, parts.lo],
    ["TIMESTAMP_SAMPLE_RATE", record.ixmlInfo?.timestampSampleRate, targetIxmlInfo?.timestampSampleRate, BigInt(record.sampleRate)],
  ];
  let next = data;
  for (const [tag, sourceField, targetField, numeric] of fields) {
    if (!sourceField && !targetField) continue;
    const text = restoreTargetRaw && targetField ? targetField.raw : numeric.toString();
    next = replaceIxmlFieldBytes(next, tag, text);
  }
  return next;
}

function ds64ExtensionTable(ds64, descriptors) {
  const entries = [];
  if (ds64?.table) {
    for (const [id, size] of ds64.table) entries.push({ id, size });
  }
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
  for (const descriptor of descriptors) {
    const size = descriptor.stream ? descriptor.size : BigInt(descriptor.data.byteLength);
    const index = indexById.get(descriptor.id);
    if (index !== undefined) {
      entries[index] = { id: descriptor.id, size };
    } else if (size > 0xffffffffn) {
      indexById.set(descriptor.id, entries.length);
      entries.push({ id: descriptor.id, size });
    }
  }
  return entries;
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
      data = rewriteIxmlChunkBytes(data, record, value, targetIxmlInfo);
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
  const ds64Table = outContainer === "RIFF" ? [] : ds64ExtensionTable(listed.ds64, descriptors);
  if (outContainer !== "RIFF") {
    ds64Pos = writePos;
    const placeholder = ds64ChunkData({ riffSize: 0, dataSize: 0, sampleCount: 0, table: ds64Table });
    const header = chunkHeader("ds64", placeholder.byteLength);
    await writable.write({ type: "write", position: writePos, data: header });
    await writable.write({ type: "write", position: writePos + header.byteLength, data: placeholder });
    writePos += header.byteLength + placeholder.byteLength;
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
      data: ds64ChunkData({ riffSize, dataSize: outDataSize, sampleCount, table: ds64Table }),
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
    if (ownWritable) await target.close();
  } catch (error) {
    if (ownWritable) await target.abort().catch(() => {});
    throw error;
  }
}

export function verifyIxmlTimeReference(record, expected, label) {
  const ixmlValue = ixmlTimeReferenceValue(record.ixmlInfo);
  if (ixmlValue !== null && ixmlValue !== expected) {
    throw new Error(`${label}: iXML TimeReference 校验失败`);
  }
}
