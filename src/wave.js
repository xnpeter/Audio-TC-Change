export const LITTLE = true;
export const MAX_RIFF32 = 0xffffffff;
export const WAVE_CONTAINERS = new Set(["RIFF", "RF64", "BW64"]);
export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_IEEE_FLOAT = 3;
export const WAVE_FORMAT_EXTENSIBLE = 65534;

const GUID_PCM = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const GUID_IEEE_FLOAT = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export function ascii(view, pos, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(view.getUint8(pos + i));
  return out;
}

export async function readDataView(file, start, length) {
  const blob = file.slice(start, start + length);
  return new DataView(await blob.arrayBuffer());
}

export function asciiFromView(view, pos, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(view.getUint8(pos + i));
  return out;
}

export function paddedAsciiField(view, pos, len) {
  return asciiFromView(view, pos, len).replace(/\0.*$/, "").trim();
}

export function findAsciiInView(view, pattern, from = 0) {
  const codes = Array.from(pattern, c => c.charCodeAt(0));
  const limit = view.byteLength - codes.length;
  for (let i = from; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < codes.length; j++) {
      if (view.getUint8(i + j) !== codes[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export function readIxmlField(view, chunkStart, tag) {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const open = findAsciiInView(view, openTag);
  if (open < 0) return null;
  const valueStart = open + openTag.length;
  const close = findAsciiInView(view, closeTag, valueStart);
  if (close < 0) return null;
  const raw = asciiFromView(view, valueStart, close - valueStart);
  return {
    position: chunkStart + valueStart,
    length: close - valueStart,
    raw,
    value: raw.trim(),
  };
}

export function parseIxmlInfo(view, chunkStart, chunkSize) {
  const fieldTags = ["PROJECT", "SCENE", "TAKE", "TAPE", "FILE_UID", "UBITS", "NOTE", "CIRCLED"];
  const fields = {};
  for (const tag of fieldTags) {
    const field = readIxmlField(view, chunkStart, tag);
    if (field) fields[tag] = field;
  }
  const timestampHi = readIxmlField(view, chunkStart, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI");
  const timestampLo = readIxmlField(view, chunkStart, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO");
  const timestampSampleRate = readIxmlField(view, chunkStart, "TIMESTAMP_SAMPLE_RATE");
  const timecodeRate = readIxmlField(view, chunkStart, "TIMECODE_RATE");
  const timecodeFlag = readIxmlField(view, chunkStart, "TIMECODE_FLAG");
  return {
    chunkStart,
    chunkSize,
    fields,
    timestampHi,
    timestampLo,
    timestampSampleRate,
    timecodeRate,
    timecodeFlag,
  };
}

export function toSafeNumber(value, label = "数值") {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label}超出可安全处理的范围`);
  return number;
}

export function isWaveContainerId(id) {
  return WAVE_CONTAINERS.has(id);
}

export function isIeeeFloat(record) {
  return Boolean(record?.isFloat) || record?.audioFormat === WAVE_FORMAT_IEEE_FLOAT;
}

function guidEquals(view, offset, guid) {
  if (view.byteLength < offset + 16) return false;
  for (let i = 0; i < 16; i++) {
    if (view.getUint8(offset + i) !== guid[i]) return false;
  }
  return true;
}

export function readWaveContainer(view, name = "") {
  const prefix = name ? `${name}: ` : "";
  if (view.byteLength < 12) throw new Error(`${prefix}文件头过短`);
  const container = ascii(view, 0, 4);
  const form = ascii(view, 8, 4);
  if (container === "riff") throw new Error(`${prefix}暂不支持 Sony Wave64（.w64）文件`);
  if (container === "FORM") throw new Error(`${prefix}暂不支持 AIFF 文件`);
  if (container === "caff") throw new Error(`${prefix}暂不支持 CAF 文件`);
  if (!isWaveContainerId(container) || form !== "WAVE") {
    throw new Error(`${prefix}不是 RIFF/WAVE/RF64/BW64 文件`);
  }
  return {
    container,
    size32: view.getUint32(4, LITTLE),
  };
}

export function parseWaveFmt(view, chunkSize, name = "") {
  const prefix = name ? `${name}: ` : "";
  if (chunkSize < 16 || view.byteLength < 16) throw new Error(`${prefix}fmt chunk 过短`);
  const fmtTag = view.getUint16(0, LITTLE);
  const channels = view.getUint16(2, LITTLE);
  const sampleRate = view.getUint32(4, LITTLE);
  const byteRate = view.getUint32(8, LITTLE);
  const blockAlign = view.getUint16(12, LITTLE);
  const bitsPerSample = view.getUint16(14, LITTLE);
  let audioFormat = fmtTag;
  let isFloat = fmtTag === WAVE_FORMAT_IEEE_FLOAT;
  let validBitsPerSample = bitsPerSample;
  let channelMask = 0;

  if (fmtTag === WAVE_FORMAT_EXTENSIBLE) {
    if (chunkSize < 40 || view.byteLength < 40) throw new Error(`${prefix}WAVEFORMATEXTENSIBLE fmt chunk 过短`);
    validBitsPerSample = view.getUint16(18, LITTLE) || bitsPerSample;
    channelMask = view.getUint32(20, LITTLE);
    if (guidEquals(view, 24, GUID_IEEE_FLOAT)) {
      audioFormat = WAVE_FORMAT_IEEE_FLOAT;
      isFloat = true;
    } else if (guidEquals(view, 24, GUID_PCM)) {
      audioFormat = WAVE_FORMAT_PCM;
      isFloat = false;
    }
  }

  return {
    fmtTag,
    audioFormat,
    isFloat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    validBitsPerSample,
    channelMask,
  };
}

export function parseDs64View(view, chunkStart, chunkSize, name = "") {
  const prefix = name ? `${name}: ` : "";
  if (chunkSize < 28 || view.byteLength < 28) throw new Error(`${prefix}ds64 chunk 过短`);
  const tableLength = view.getUint32(24, LITTLE);
  const table = new Map();
  let offset = 28;
  for (let i = 0; i < tableLength; i++) {
    if (offset + 12 > view.byteLength) throw new Error(`${prefix}ds64 扩展表截断`);
    table.set(ascii(view, offset, 4), view.getBigUint64(offset + 4, LITTLE));
    offset += 12;
  }
  return {
    chunkStart,
    chunkSize,
    riffSize: view.getBigUint64(0, LITTLE),
    dataSize: view.getBigUint64(8, LITTLE),
    sampleCount: view.getBigUint64(16, LITTLE),
    tableLength,
    table,
  };
}

export function resolveChunkSize(id, size32, ds64, name = "") {
  if (size32 !== MAX_RIFF32) return BigInt(size32);
  const prefix = name ? `${name}: ` : "";
  if (!ds64) throw new Error(`${prefix}${id} chunk 大小为 4GB 标记，但缺少 ds64`);
  if (id === "data") return ds64.dataSize;
  if (ds64.table.has(id)) return ds64.table.get(id);
  throw new Error(`${prefix}${id} chunk 大小为 4GB 标记，但 ds64 没有对应项`);
}

export function waveFileHeader(container, size32 = MAX_RIFF32) {
  const header = new Uint8Array(12);
  for (let i = 0; i < 4; i++) header[i] = container.charCodeAt(i);
  new DataView(header.buffer).setUint32(4, size32, LITTLE);
  header.set([0x57, 0x41, 0x56, 0x45], 8);
  return header;
}

export function ds64ChunkData({ riffSize, dataSize, sampleCount, table = [] }) {
  const data = new Uint8Array(28 + table.length * 12);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, BigInt(riffSize), LITTLE);
  view.setBigUint64(8, BigInt(dataSize), LITTLE);
  view.setBigUint64(16, BigInt(sampleCount), LITTLE);
  view.setUint32(24, table.length, LITTLE);
  let offset = 28;
  for (const entry of table) {
    for (let i = 0; i < 4; i++) data[offset + i] = entry.id.charCodeAt(i);
    view.setBigUint64(offset + 4, BigInt(entry.size), LITTLE);
    offset += 12;
  }
  return data;
}

export function chunkSize32(size) {
  const value = typeof size === "bigint" ? size : BigInt(size);
  return value > BigInt(MAX_RIFF32) ? MAX_RIFF32 : Number(value);
}

export async function listWaveChunks(file, name = file.name) {
  const header = await readDataView(file, 0, Math.min(file.size, 12));
  const { container, size32 } = readWaveContainer(header, name);
  const chunks = [];
  let ds64 = null;
  let pos = 12;
  let limit = file.size;
  if (container === "RIFF" && size32 !== MAX_RIFF32) {
    limit = Math.min(limit, size32 + 8);
  }

  while (pos + 8 <= limit) {
    const headerView = await readDataView(file, pos, 8);
    if (headerView.byteLength < 8) throw new Error(`${name}: chunk header 截断`);
    const id = ascii(headerView, 0, 4);
    const rawSize = headerView.getUint32(4, LITTLE);
    const start = pos + 8;

    if ((container === "RF64" || container === "BW64") && chunks.length === 0 && id !== "ds64") {
      throw new Error(`${name}: ${container} 的第一个 chunk 必须是 ds64`);
    }

    if (id === "ds64") {
      const ds64View = await readDataView(file, start, rawSize);
      ds64 = parseDs64View(ds64View, start, rawSize, name);
      chunks.push({ id, start, size: BigInt(rawSize), size32: rawSize });
      const declaredEnd = toSafeNumber(ds64.riffSize + 8n, `${name} RF64 大小`);
      limit = Math.min(file.size, declaredEnd);
      pos = start + rawSize + (rawSize & 1);
      continue;
    }

    const size = resolveChunkSize(id, rawSize, ds64, name);
    chunks.push({ id, start, size, size32: rawSize });
    const padded = toSafeNumber(size + (size & 1n), `${name} ${id} chunk`);
    pos = start + padded;
  }

  if ((container === "RF64" || container === "BW64") && !ds64) {
    throw new Error(`${name}: ${container} 文件缺少 ds64 chunk`);
  }

  return { container, size32, ds64, chunks, fileSize: file.size };
}

export async function scanWave(fileHandle, meta = {}) {
  const file = await fileHandle.getFile();
  const name = file.name;
  const listed = await listWaveChunks(file, name);

  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let blockAlign = null;
  let audioFormat = null;
  let fmtTag = null;
  let isFloat = false;
  let timeReferenceOffset = null;
  let oldTimeReference = null;
  let hasBext = false;
  let bextInfo = null;
  let ixmlInfo = null;
  let dataOffset = null;
  let dataSize = null;

  for (const chunk of listed.chunks) {
    const chunkSize = toSafeNumber(chunk.size, `${name} ${chunk.id} chunk`);
    if (chunk.id === "fmt ") {
      const fmt = await readDataView(file, chunk.start, Math.min(chunkSize, 40));
      const parsed = parseWaveFmt(fmt, chunkSize, name);
      fmtTag = parsed.fmtTag;
      audioFormat = parsed.audioFormat;
      isFloat = parsed.isFloat;
      channels = parsed.channels;
      sampleRate = parsed.sampleRate;
      blockAlign = parsed.blockAlign;
      bitsPerSample = parsed.bitsPerSample;
    } else if (chunk.id === "bext") {
      if (chunkSize < 346) throw new Error(`${name}: bext chunk 过短`);
      hasBext = true;
      timeReferenceOffset = chunk.start + 338;
      const timeReference = await readDataView(file, timeReferenceOffset, 8);
      oldTimeReference = timeReference.getBigUint64(0, LITTLE);
      const bext = await readDataView(file, chunk.start, Math.min(chunkSize, 348));
      bextInfo = {
        chunkStart: chunk.start,
        description: paddedAsciiField(bext, 0, Math.min(256, bext.byteLength)),
        originator: bext.byteLength >= 288 ? paddedAsciiField(bext, 256, 32) : "",
        originatorReference: bext.byteLength >= 320 ? paddedAsciiField(bext, 288, 32) : "",
        originationDate: bext.byteLength >= 330 ? paddedAsciiField(bext, 320, 10) : "",
        originationTime: bext.byteLength >= 338 ? paddedAsciiField(bext, 330, 8) : "",
        version: bext.byteLength >= 348 ? bext.getUint16(346, LITTLE) : null,
      };
    } else if (chunk.id === "iXML") {
      const ixml = await readDataView(file, chunk.start, chunkSize);
      ixmlInfo = parseIxmlInfo(ixml, chunk.start, chunkSize);
    } else if (chunk.id === "data") {
      dataOffset = chunk.start;
      dataSize = chunkSize;
    }
  }

  if (sampleRate === null || blockAlign === null) throw new Error(`${name}: 缺少 fmt chunk`);
  if (dataSize === null || dataOffset === null) throw new Error(`${name}: 缺少 data chunk`);
  if (dataSize % blockAlign !== 0) throw new Error(`${name}: data chunk 未按 block align 对齐`);
  if (oldTimeReference === null) {
    oldTimeReference = ixmlTimeReferenceValue(ixmlInfo) ?? 0n;
  }

  const ds64 = listed.ds64
    ? {
      chunkStart: listed.ds64.chunkStart,
      riffSize: toSafeNumber(listed.ds64.riffSize, `${name} ds64 riffSize`),
      dataSize: toSafeNumber(listed.ds64.dataSize, `${name} ds64 dataSize`),
      sampleCount: listed.ds64.sampleCount,
    }
    : null;

  return {
    fileHandle,
    file,
    name,
    relativePath: meta.relativePath || name,
    parentPath: meta.parentPath || "",
    parentHandle: meta.parentHandle || null,
    container: listed.container,
    ds64,
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    audioFormat,
    fmtTag,
    isFloat,
    hasBext,
    bextInfo,
    timeReferenceOffset,
    oldTimeReference,
    ixmlInfo,
    dataOffset,
    dataSize,
    durationSamples: BigInt(dataSize / blockAlign),
  };
}


export function ixmlTimeReferenceValue(ixmlInfo) {
  if (!ixmlInfo?.timestampHi || !ixmlInfo?.timestampLo) return null;
  return BigInt(ixmlInfo.timestampHi.value || "0") * 4294967296n + BigInt(ixmlInfo.timestampLo.value || "0");
}
