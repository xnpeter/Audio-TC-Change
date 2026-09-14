import {
  bextAspeedToFpsValue,
  bextDescriptionFieldBytes,
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
  updateBextDescriptionAspeed,
} from "./timecode.js";
import {
  LITTLE,
  paddedAsciiField,
  readWaveContainer,
  scanWave,
} from "./wave.js";
import {
  chunkHeader,
  ixmlTimestampParts,
  writeAsciiAt,
} from "./wave-time-reference.js";

const COPY_CHUNK_SIZE = 8 * 1024 * 1024;

export function ixmlFpsMetadataForValue(value) {
  const fps = parseFps(value);
  const rate = fps.rate || fps;
  return {
    timecodeRate: `${rate.n}/${rate.d}`,
    timecodeFlag: fps.drop ? "DF" : "NDF",
  };
}

function ixmlAlreadyMatches(record, targetValue) {
  const oldValue = ixmlRateToFpsValue(record.ixmlInfo);
  const oldFlag = record.ixmlInfo?.timecodeFlag?.value?.trim().toUpperCase() || "";
  const expected = ixmlFpsMetadataForValue(targetValue);
  return Boolean(
    record.ixmlInfo?.timecodeRate &&
    record.ixmlInfo?.timecodeFlag &&
    oldValue &&
    fpsValueEquivalent(oldValue, targetValue) &&
    oldFlag === expected.timecodeFlag
  );
}

function aspeedAlreadyMatches(record, targetValue) {
  const oldValue = bextAspeedToFpsValue(record.bextInfo);
  return Boolean(oldValue && fpsValueEquivalent(oldValue, targetValue));
}

export function planFpsWrite(record, targetValue, policy = "existing") {
  const hasIxmlChunk = Boolean(record.ixmlInfo);
  const hasAspeed = Boolean(bextAspeedToFpsValue(record.bextInfo));
  const hasBext = Boolean(record.hasBext || record.bextInfo);
  const ixmlMatches = ixmlAlreadyMatches(record, targetValue);
  const aspeedMatches = aspeedAlreadyMatches(record, targetValue);

  let writeIxml = false;
  let createIxml = false;
  let writeAspeed = false;
  let createAspeed = false;

  if (policy === "ixml") {
    createIxml = !hasIxmlChunk;
    writeIxml = createIxml || !ixmlMatches;
  } else if (policy === "bext") {
    writeAspeed = hasBext && hasAspeed && !aspeedMatches;
  } else if (policy === "both") {
    createIxml = !hasIxmlChunk;
    writeIxml = createIxml || !ixmlMatches;
    createAspeed = hasBext && !hasAspeed;
    writeAspeed = hasBext && (createAspeed || !aspeedMatches);
  } else if (policy === "existing") {
    writeIxml = hasIxmlChunk && !ixmlMatches;
    writeAspeed = hasAspeed && !aspeedMatches;
  }

  const willWrite = writeIxml || writeAspeed;
  let action = "unchanged";
  if (!willWrite) {
    if (policy === "skip") action = "skip-policy";
    else if (policy === "bext" && !hasAspeed) action = "skip-no-aspeed";
    else if (!hasIxmlChunk && !hasAspeed) action = "skip-no-fps";
    else action = "unchanged";
  } else {
    const parts = [];
    if (writeIxml) parts.push(createIxml ? "create-ixml" : "update-ixml");
    if (writeAspeed) parts.push(createAspeed ? "create-aspeed" : "update-aspeed");
    action = parts.join("+");
  }

  return {
    writeIxml,
    createIxml,
    writeAspeed,
    createAspeed,
    willWrite,
    action,
  };
}

export function fpsActionLabel(action) {
  const labels = {
    "update-ixml": "待更新 iXML",
    "create-ixml": "将创建 iXML",
    "update-aspeed": "待更新 aSPEED",
    "create-aspeed": "将写入 aSPEED",
    "update-ixml+update-aspeed": "待更新 iXML+aSPEED",
    "create-ixml+update-aspeed": "将创建 iXML，更新 aSPEED",
    "create-ixml+create-aspeed": "将创建 iXML+aSPEED",
    "update-ixml+create-aspeed": "待更新 iXML，写入 aSPEED",
    "skip-no-fps": "跳过：无帧率元数据",
    "skip-no-aspeed": "跳过：无 aSPEED",
    "skip-policy": "跳过",
    unchanged: "无需更改",
    "skip-missing-ixml": "跳过：无 iXML",
  };
  return labels[action] || action;
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readIxmlChunkBytes(record) {
  if (!record.ixmlInfo) return null;
  const file = await record.fileHandle.getFile();
  return blobBytes(file.slice(
    record.ixmlInfo.chunkStart,
    record.ixmlInfo.chunkStart + record.ixmlInfo.chunkSize,
  ));
}

function replaceXmlField(xml, tag, value) {
  const pattern = new RegExp(`(<${tag}>)[\\s\\S]*?(</${tag}>)`, "i");
  return pattern.test(xml) ? xml.replace(pattern, `$1${value}$2`) : null;
}

export function updateIxmlFpsText(xml, timecodeRate, timecodeFlag) {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  let next = xml;
  const rateReplaced = replaceXmlField(next, "TIMECODE_RATE", timecodeRate);
  if (rateReplaced !== null) next = rateReplaced;
  const flagReplaced = replaceXmlField(next, "TIMECODE_FLAG", timecodeFlag);
  if (flagReplaced !== null) next = flagReplaced;

  const missingRate = rateReplaced === null;
  const missingFlag = flagReplaced === null;
  if (!missingRate && !missingFlag) return next;

  const newLines = [
    missingRate ? `\t\t<TIMECODE_RATE>${timecodeRate}</TIMECODE_RATE>` : null,
    missingFlag ? `\t\t<TIMECODE_FLAG>${timecodeFlag}</TIMECODE_FLAG>` : null,
  ].filter(Boolean).join(newline);

  if (/<\/SPEED\s*>/i.test(next)) {
    return next.replace(/<\/SPEED\s*>/i, `${newLines}${newline}\t</SPEED>`);
  }
  if (!/<\/BWFXML\s*>/i.test(next)) {
    throw new Error("iXML 缺少 BWFXML 结束标签，无法安全写入帧率");
  }
  const speed = [
    "\t<SPEED>",
    newLines,
    "\t</SPEED>",
  ].join(newline);
  return next.replace(/<\/BWFXML\s*>/i, `${speed}${newline}</BWFXML>`);
}

export function newIxmlFpsText(record, timecodeRate, timecodeFlag) {
  const parts = ixmlTimestampParts(record.oldTimeReference);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<BWFXML>",
    "\t<IXML_VERSION>3.01</IXML_VERSION>",
    "\t<SPEED>",
    `\t\t<TIMECODE_RATE>${timecodeRate}</TIMECODE_RATE>`,
    `\t\t<TIMECODE_FLAG>${timecodeFlag}</TIMECODE_FLAG>`,
    `\t\t<TIMESTAMP_SAMPLE_RATE>${record.sampleRate}</TIMESTAMP_SAMPLE_RATE>`,
    `\t\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>${parts.hi}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>`,
    `\t\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>${parts.lo}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>`,
    "\t</SPEED>",
    "</BWFXML>",
    "",
  ].join("\r\n");
}

async function copyRange(file, writable, sourceStart, sourceEnd, delta) {
  if (sourceEnd <= sourceStart || delta === 0) return;
  if (delta > 0) {
    for (let end = sourceEnd; end > sourceStart;) {
      const start = Math.max(sourceStart, end - COPY_CHUNK_SIZE);
      const data = await blobBytes(file.slice(start, end));
      await writable.write({ type: "write", position: start + delta, data });
      end = start;
    }
    return;
  }
  for (let start = sourceStart; start < sourceEnd;) {
    const end = Math.min(sourceEnd, start + COPY_CHUNK_SIZE);
    const data = await blobBytes(file.slice(start, end));
    await writable.write({ type: "write", position: start + delta, data });
    start = end;
  }
}

export async function replaceIxmlChunk(record, replacementBytes) {
  const file = await record.fileHandle.getFile();
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  const { container } = readWaveContainer(header, record.name);

  const oldStart = record.ixmlInfo ? record.ixmlInfo.chunkStart - 8 : record.dataOffset - 8;
  const oldSize = record.ixmlInfo?.chunkSize || 0;
  const oldTotal = record.ixmlInfo ? 8 + oldSize + (oldSize & 1) : 0;
  const newSize = replacementBytes?.byteLength || 0;
  const newTotal = replacementBytes ? 8 + newSize + (newSize & 1) : 0;
  const delta = newTotal - oldTotal;
  const newFileSize = file.size + delta;
  const use64 = container === "RF64" || container === "BW64" || Boolean(record.ds64);

  const writable = await record.fileHandle.createWritable({ keepExistingData: true });
  try {
    await copyRange(file, writable, oldStart + oldTotal, file.size, delta);
    if (replacementBytes) {
      const headerBytes = chunkHeader("iXML", newSize);
      await writable.write({ type: "write", position: oldStart, data: headerBytes });
      await writable.write({ type: "write", position: oldStart + 8, data: replacementBytes });
      if (newSize & 1) {
        await writable.write({ type: "write", position: oldStart + 8 + newSize, data: new Uint8Array([0]) });
      }
    }
    if (use64 && record.ds64) {
      const newRiffSize = BigInt(record.ds64.riffSize) + BigInt(delta);
      if (newRiffSize < 4n) throw new Error(`${record.name}: 修改后的 RF64 大小无效`);
      const riffSizePatch = new Uint8Array(8);
      new DataView(riffSizePatch.buffer).setBigUint64(0, newRiffSize, LITTLE);
      await writable.write({ type: "write", position: record.ds64.chunkStart, data: riffSizePatch });
    } else {
      const oldRiffSize = header.getUint32(4, LITTLE);
      const newRiffSize = oldRiffSize + delta;
      if (newRiffSize < 4 || newRiffSize > 0xffffffff) {
        throw new Error(`${record.name}: 修改后的文件超过 RIFF 4GB 限制`);
      }
      const riffSizePatch = new Uint8Array(4);
      new DataView(riffSizePatch.buffer).setUint32(0, newRiffSize, LITTLE);
      await writable.write({ type: "write", position: 4, data: riffSizePatch });
    }
    await writable.truncate(newFileSize);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

function fieldFits(field, value) {
  return Boolean(field && value.length <= field.length);
}

export async function readBextDescriptionBytes(record) {
  if (!record.bextInfo) return null;
  const file = await record.fileHandle.getFile();
  return blobBytes(file.slice(record.bextInfo.chunkStart, record.bextInfo.chunkStart + 256));
}

async function writeBextAspeed(record, fpsValue, { create = false } = {}) {
  if (!record.bextInfo) throw new Error(`${record.name}: 没有 bext，无法写入 aSPEED`);
  const originalDescriptionBytes = await readBextDescriptionBytes(record);
  const currentText = paddedAsciiField(new DataView(
    originalDescriptionBytes.buffer,
    originalDescriptionBytes.byteOffset,
    originalDescriptionBytes.byteLength,
  ), 0, 256);
  const nextText = updateBextDescriptionAspeed(currentText, fpsValue, { create });
  if (nextText == null) throw new Error(`${record.name}: 没有 aSPEED，且未允许创建`);
  const bytes = bextDescriptionFieldBytes(nextText);
  const writable = await record.fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.write({ type: "write", position: record.bextInfo.chunkStart, data: bytes });
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return originalDescriptionBytes;
}

async function writeIxmlFps(record, fpsValue, { createIxml = false } = {}) {
  const { timecodeRate, timecodeFlag } = ixmlFpsMetadataForValue(fpsValue);
  const originalIxmlBytes = await readIxmlChunkBytes(record);

  if (!record.ixmlInfo && !createIxml) {
    throw new Error(`${record.name}: 没有 iXML，且未允许创建`);
  }

  const rateField = record.ixmlInfo?.timecodeRate;
  const flagField = record.ixmlInfo?.timecodeFlag;
  if (fieldFits(rateField, timecodeRate) && fieldFits(flagField, timecodeFlag)) {
    const writable = await record.fileHandle.createWritable({ keepExistingData: true });
    try {
      await writeAsciiAt(writable, rateField.position, timecodeRate.padEnd(rateField.length, " "));
      await writeAsciiAt(writable, flagField.position, timecodeFlag.padEnd(flagField.length, " "));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  } else {
    let text;
    if (originalIxmlBytes) {
      const xml = new TextDecoder("utf-8", { ignoreBOM: true }).decode(originalIxmlBytes);
      text = updateIxmlFpsText(xml, timecodeRate, timecodeFlag);
    } else {
      text = newIxmlFpsText(record, timecodeRate, timecodeFlag);
    }
    await replaceIxmlChunk(record, new TextEncoder().encode(text));
  }

  return originalIxmlBytes;
}

export async function writeFpsMetadata(record, fpsValue, plan = {}) {
  const {
    writeIxml = false,
    createIxml = false,
    writeAspeed = false,
    createAspeed = false,
  } = plan;
  if (!writeIxml && !writeAspeed) {
    throw new Error(`${record.name}: 没有需要写入的帧率来源`);
  }

  let originalDescriptionBytes = null;
  let originalIxmlBytes = null;
  if (writeAspeed) {
    originalDescriptionBytes = await writeBextAspeed(record, fpsValue, { create: createAspeed });
  }
  if (writeIxml) {
    originalIxmlBytes = await writeIxmlFps(record, fpsValue, { createIxml });
  }

  return {
    fileHandle: record.fileHandle,
    name: record.name,
    relativePath: record.relativePath,
    parentPath: record.parentPath,
    parentHandle: record.parentHandle,
    originalIxmlBytes,
    originalDescriptionBytes,
    wroteIxml: writeIxml,
    wroteAspeed: writeAspeed,
    oldTimeReference: record.oldTimeReference,
  };
}

async function restoreBextDescription(record, originalDescriptionBytes) {
  if (!record.bextInfo || !originalDescriptionBytes) return;
  const writable = await record.fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.write({
      type: "write",
      position: record.bextInfo.chunkStart,
      data: originalDescriptionBytes,
    });
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

export async function restoreFpsMetadata(undoItem) {
  const meta = {
    relativePath: undoItem.relativePath,
    parentPath: undoItem.parentPath,
    parentHandle: undoItem.parentHandle,
  };
  if (undoItem.wroteIxml) {
    const fresh = await scanWave(undoItem.fileHandle, meta);
    await replaceIxmlChunk(fresh, undoItem.originalIxmlBytes);
  }
  if (undoItem.wroteAspeed) {
    const fresh = await scanWave(undoItem.fileHandle, meta);
    await restoreBextDescription(fresh, undoItem.originalDescriptionBytes);
  }
}

export function verifyFpsMetadata(
  record,
  fpsValue,
  expectedTimeReference,
  label = record.name,
  expectedAudio = {},
  plan = {},
) {
  if (plan.writeIxml) {
    const actualValue = ixmlRateToFpsValue(record.ixmlInfo);
    if (!actualValue || !fpsValueEquivalent(actualValue, fpsValue)) {
      throw new Error(`${label}: iXML 帧率校验失败`);
    }
    const expected = ixmlFpsMetadataForValue(fpsValue);
    const actualFlag = record.ixmlInfo?.timecodeFlag?.value?.trim().toUpperCase();
    if (actualFlag !== expected.timecodeFlag) {
      throw new Error(`${label}: iXML DF/NDF 标记校验失败`);
    }
  }
  if (plan.writeAspeed) {
    const actualAspeed = bextAspeedToFpsValue(record.bextInfo);
    if (!actualAspeed || !fpsValueEquivalent(actualAspeed, fpsValue)) {
      throw new Error(`${label}: bext aSPEED 校验失败`);
    }
  }
  if (record.oldTimeReference !== expectedTimeReference) {
    throw new Error(`${label}: TimeReference 校验失败`);
  }
  if (expectedAudio.sampleRate !== undefined && record.sampleRate !== expectedAudio.sampleRate) {
    throw new Error(`${label}: 音频采样率校验失败`);
  }
  if (expectedAudio.dataSize !== undefined && record.dataSize !== expectedAudio.dataSize) {
    throw new Error(`${label}: 音频 data 大小校验失败`);
  }
}
