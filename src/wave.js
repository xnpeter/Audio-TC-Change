export const LITTLE = true;

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
  if (!timestampHi && !timestampLo && !timestampSampleRate && !timecodeRate && !timecodeFlag && !Object.keys(fields).length) return null;
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

export async function scanWave(fileHandle, meta = {}) {
  const file = await fileHandle.getFile();
  const header = await readDataView(file, 0, Math.min(file.size, 12));
  const name = file.name;
  if (header.byteLength < 12 || ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WAVE") {
    throw new Error(`${name}: 不是 RIFF/WAVE 文件`);
  }

  const riffSize = header.getUint32(4, LITTLE);
  let pos = 12;
  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let blockAlign = null;
  let audioFormat = null;
  let timeReferenceOffset = null;
  let oldTimeReference = null;
  let hasBext = false;
  let bextInfo = null;
  let ixmlInfo = null;
  let dataOffset = null;
  let dataSize = null;

  while (pos + 8 <= Math.min(file.size, riffSize + 8)) {
    const chunkHeader = await readDataView(file, pos, 8);
    if (chunkHeader.byteLength < 8) throw new Error(`${name}: chunk header 截断`);
    const chunkId = ascii(chunkHeader, 0, 4);
    const chunkSize = chunkHeader.getUint32(4, LITTLE);
    const chunkStart = pos + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error(`${name}: fmt chunk 过短`);
      const fmt = await readDataView(file, chunkStart, Math.min(chunkSize, 40));
      audioFormat = fmt.getUint16(0, LITTLE);
      channels = fmt.getUint16(2, LITTLE);
      sampleRate = fmt.getUint32(4, LITTLE);
      blockAlign = fmt.getUint16(12, LITTLE);
      bitsPerSample = fmt.getUint16(14, LITTLE);
    } else if (chunkId === "bext") {
      if (chunkSize < 346) throw new Error(`${name}: bext chunk 过短`);
      hasBext = true;
      timeReferenceOffset = chunkStart + 338;
      const timeReference = await readDataView(file, timeReferenceOffset, 8);
      oldTimeReference = timeReference.getBigUint64(0, LITTLE);
      const bext = await readDataView(file, chunkStart, Math.min(chunkSize, 348));
      bextInfo = {
        description: paddedAsciiField(bext, 0, Math.min(256, bext.byteLength)),
        originator: bext.byteLength >= 288 ? paddedAsciiField(bext, 256, 32) : "",
        originatorReference: bext.byteLength >= 320 ? paddedAsciiField(bext, 288, 32) : "",
        originationDate: bext.byteLength >= 330 ? paddedAsciiField(bext, 320, 10) : "",
        originationTime: bext.byteLength >= 338 ? paddedAsciiField(bext, 330, 8) : "",
        version: bext.byteLength >= 348 ? bext.getUint16(346, LITTLE) : null,
      };
    } else if (chunkId === "iXML") {
      const ixml = await readDataView(file, chunkStart, chunkSize);
      ixmlInfo = parseIxmlInfo(ixml, chunkStart, chunkSize);
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    pos = chunkStart + chunkSize + (chunkSize & 1);
  }

  if (sampleRate === null || blockAlign === null) throw new Error(`${name}: 缺少 fmt chunk`);
  if (dataSize === null || dataOffset === null) throw new Error(`${name}: 缺少 data chunk`);
  if (dataSize % blockAlign !== 0) throw new Error(`${name}: data chunk 未按 block align 对齐`);
  if (oldTimeReference === null) {
    oldTimeReference = ixmlTimeReferenceValue(ixmlInfo) ?? 0n;
  }

  return {
    fileHandle,
    file,
    name,
    relativePath: meta.relativePath || name,
    parentPath: meta.parentPath || "",
    parentHandle: meta.parentHandle || null,
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    audioFormat,
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
