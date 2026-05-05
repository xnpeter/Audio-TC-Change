import { LITTLE, readDataView } from "./wave.js";
import {
  combineSortValue,
  isZoomLrFile,
  recordKey,
  recordLabel,
  shortGroupLabel,
  zoomTrackNumber,
} from "./grouping.js";
import {
  chunkHeader,
  ixmlTimestampParts,
  writeAsciiFixed,
  writeAsciiPadded,
  writeAsciiPaddedMultiline,
} from "./wave-time-reference.js";

export function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function trackNameForSource(record, channelIndex) {
  if (isZoomLrFile(record)) return channelIndex === 0 ? "TrL" : "TrR";
  const track = zoomTrackNumber(record);
  if (track !== null) return `Tr${track}`;
  return record.channels === 1 ? record.name.replace(/\.[^.]+$/, "") : `A${channelIndex + 1}`;
}

export function sourceChannelIndex(record, channelIndex) {
  if (isZoomLrFile(record)) return channelIndex + 1;
  const track = zoomTrackNumber(record);
  if (track !== null) return track + 2;
  return channelIndex + 1;
}

export function combineTrackPlan(groupRecords) {
  const sorted = [...groupRecords].sort((a, b) => {
    const value = combineSortValue(a) - combineSortValue(b);
    if (value) return value;
    return recordLabel(a).localeCompare(recordLabel(b));
  });
  const tracks = [];
  for (const record of sorted) {
    for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
      tracks.push({
        record,
        channelIndex,
        channelName: trackNameForSource(record, channelIndex),
        channelIndexValue: sourceChannelIndex(record, channelIndex),
      });
    }
  }
  return tracks;
}

export function validateCombineGroup(groupRecords, options = {}) {
  const groupLabel = options.groupLabel || recordLabel;
  if (!groupRecords.length) throw new Error("没有可合并的分轨文件");
  const first = groupRecords[0];
  for (const record of groupRecords) {
    if (record.audioFormat !== first.audioFormat) throw new Error(`${recordLabel(record)}: 音频格式和其他分轨不同`);
    if (record.sampleRate !== first.sampleRate) throw new Error(`${recordLabel(record)}: 采样率和其他分轨不同`);
    if (record.bitsPerSample !== first.bitsPerSample) throw new Error(`${recordLabel(record)}: 位深和其他分轨不同`);
    if (record.oldTimeReference !== first.oldTimeReference) throw new Error(`${recordLabel(record)}: 起始 TimeReference 和其他分轨不同`);
  }
  const durations = groupRecords.map(record => record.durationSamples);
  const minDuration = durations.reduce((min, value) => value < min ? value : min, durations[0]);
  const maxDuration = durations.reduce((max, value) => value > max ? value : max, durations[0]);
  if (maxDuration !== minDuration) throw new Error(`${groupLabel(first)}: 分轨时长不同，暂不自动裁切或补静音`);
  const tracks = combineTrackPlan(groupRecords);
  const bytesPerSample = first.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample)) throw new Error(`${groupLabel(first)}: 不支持 ${first.bitsPerSample} bit 合并`);
  const blockAlign = tracks.length * bytesPerSample;
  const dataSize = Number(minDuration) * blockAlign;
  if (dataSize > 0xffffffff) throw new Error(`${groupLabel(first)}: 合并后超过 RIFF 4GB 限制`);
  return { first, tracks, bytesPerSample, blockAlign, durationSamples: minDuration, dataSize };
}

export function ixmlFieldValue(record, tag) {
  return record.ixmlInfo?.fields?.[tag]?.value || "";
}

export function commonValue(recordsToCheck, getter) {
  const values = recordsToCheck
    .map(getter)
    .filter(value => value !== null && value !== undefined && value !== "");
  if (!values.length) return "";
  return values.every(value => value === values[0]) ? values[0] : "";
}

export function combineBextDescription(sourceInfo, tracks) {
  const lines = ["zNOTE=Combined by Audio TC Change"];
  if (sourceInfo.scene) lines.unshift(`zSCENE=${sourceInfo.scene}`);
  if (sourceInfo.take) lines.splice(sourceInfo.scene ? 1 : 0, 0, `zTAKE=${sourceInfo.take}`);
  for (const track of tracks) {
    lines.push(`zTRK${track.channelIndexValue}=${track.channelName}`);
  }
  return lines.join("\r\n");
}

export function combineSourceInfo(groupRecords) {
  return {
    project: commonValue(groupRecords, record => ixmlFieldValue(record, "PROJECT")),
    scene: commonValue(groupRecords, record => ixmlFieldValue(record, "SCENE")),
    take: commonValue(groupRecords, record => ixmlFieldValue(record, "TAKE")),
    tape: commonValue(groupRecords, record => ixmlFieldValue(record, "TAPE")),
    timecodeRate: commonValue(groupRecords, record => record.ixmlInfo?.timecodeRate?.value || ""),
    timecodeFlag: commonValue(groupRecords, record => record.ixmlInfo?.timecodeFlag?.value || ""),
    originationDate: commonValue(groupRecords, record => record.bextInfo?.originationDate || ""),
    originationTime: commonValue(groupRecords, record => record.bextInfo?.originationTime || ""),
  };
}

export function bextChunkDataForCombine(baseRecord, sourceInfo, tracks) {
  const data = new Uint8Array(858);
  const view = new DataView(data.buffer);
  writeAsciiPaddedMultiline(data, 0, 256, combineBextDescription(sourceInfo, tracks));
  writeAsciiPadded(data, 256, 32, "Audio TC Change");
  writeAsciiPadded(data, 288, 32, "AudioTCChangeCombine");
  writeAsciiFixed(data, 320, 10, sourceInfo.originationDate);
  writeAsciiFixed(data, 330, 8, sourceInfo.originationTime);
  view.setBigUint64(338, baseRecord.oldTimeReference, LITTLE);
  view.setUint16(346, 1, LITTLE);
  return data;
}

export function ixmlOptionalLine(tag, value) {
  return value ? `\t<${tag}>${xmlEscape(value)}</${tag}>` : null;
}

export function ixmlTextForCombine(baseRecord, sourceInfo, tracks) {
  const parts = ixmlTimestampParts(baseRecord.oldTimeReference);
  const trackXml = tracks.map((track, index) => [
    "\t\t<TRACK>",
    `\t\t\t<CHANNEL_INDEX>${track.channelIndexValue}</CHANNEL_INDEX>`,
    `\t\t\t<INTERLEAVE_INDEX>${index + 1}</INTERLEAVE_INDEX>`,
    `\t\t\t<NAME>${xmlEscape(track.channelName)}</NAME>`,
    "\t\t</TRACK>",
  ].join("\r\n")).join("\r\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<BWFXML>",
    "\t<IXML_VERSION>1.5</IXML_VERSION>",
    ixmlOptionalLine("PROJECT", sourceInfo.project),
    ixmlOptionalLine("SCENE", sourceInfo.scene),
    ixmlOptionalLine("TAKE", sourceInfo.take),
    ixmlOptionalLine("TAPE", sourceInfo.tape),
    ixmlOptionalLine("TIMECODE_RATE", sourceInfo.timecodeRate),
    ixmlOptionalLine("TIMECODE_FLAG", sourceInfo.timecodeFlag),
    `\t<TIMESTAMP_SAMPLE_RATE>${baseRecord.sampleRate}</TIMESTAMP_SAMPLE_RATE>`,
    `\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>${parts.hi.toString().padStart(10, "0")}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>`,
    `\t<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>${parts.lo.toString().padStart(10, "0")}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>`,
    "\t<TRACK_LIST>",
    `\t\t<TRACK_COUNT>${tracks.length}</TRACK_COUNT>`,
    trackXml,
    "\t</TRACK_LIST>",
    "</BWFXML>",
    "",
  ].filter(line => line !== null).join("\r\n");
}

export function fmtChunkDataForCombine(baseRecord, channels, blockAlign) {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, baseRecord.audioFormat, LITTLE);
  view.setUint16(2, channels, LITTLE);
  view.setUint32(4, baseRecord.sampleRate, LITTLE);
  view.setUint32(8, baseRecord.sampleRate * blockAlign, LITTLE);
  view.setUint16(12, blockAlign, LITTLE);
  view.setUint16(14, baseRecord.bitsPerSample, LITTLE);
  return data;
}

export function safeWaveBaseName(value) {
  return String(value || "combined")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "combined";
}

export async function writeChunk(writable, state, id, data) {
  await writable.write({ type: "write", position: state.position, data: chunkHeader(id, data.byteLength) });
  state.position += 8;
  await writable.write({ type: "write", position: state.position, data });
  state.position += data.byteLength;
  if (data.byteLength & 1) {
    await writable.write({ type: "write", position: state.position, data: new Uint8Array([0]) });
    state.position += 1;
  }
}

export async function writeCombinedData(writable, state, plan, progressBase, progressTotal, onProgress = null) {
  const { first, tracks, bytesPerSample, blockAlign, durationSamples, dataSize } = plan;
  await writable.write({ type: "write", position: state.position, data: chunkHeader("data", dataSize) });
  state.position += 8;
  const framesPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / blockAlign));
  let framesDone = 0n;

  while (framesDone < durationSamples) {
    const framesLeft = durationSamples - framesDone;
    const framesThisChunk = Number(framesLeft < BigInt(framesPerChunk) ? framesLeft : BigInt(framesPerChunk));
    const sourceBuffers = new Map();
    for (const track of tracks) {
      if (sourceBuffers.has(recordKey(track.record))) continue;
      const bytesToRead = framesThisChunk * track.record.blockAlign;
      const position = track.record.dataOffset + Number(framesDone) * track.record.blockAlign;
      const sourceView = await readDataView(track.record.file, position, bytesToRead);
      sourceBuffers.set(recordKey(track.record), new Uint8Array(sourceView.buffer));
    }

    const out = new Uint8Array(framesThisChunk * blockAlign);
    for (let frame = 0; frame < framesThisChunk; frame++) {
      for (let outTrack = 0; outTrack < tracks.length; outTrack++) {
        const track = tracks[outTrack];
        const source = sourceBuffers.get(recordKey(track.record));
        const sourceOffset = frame * track.record.blockAlign + track.channelIndex * bytesPerSample;
        const destOffset = frame * blockAlign + outTrack * bytesPerSample;
        out.set(source.subarray(sourceOffset, sourceOffset + bytesPerSample), destOffset);
      }
    }

    await writable.write({ type: "write", position: state.position, data: out });
    state.position += out.byteLength;
    framesDone += BigInt(framesThisChunk);
    onProgress?.("正在合并 Poly…", recordLabel(first), progressBase + Number(framesDone) / Number(durationSamples), progressTotal);
  }
  if (dataSize & 1) {
    await writable.write({ type: "write", position: state.position, data: new Uint8Array([0]) });
    state.position += 1;
  }
}

export async function writeCombinedPolyToWritable(key, groupRecords, writable, outputName, options = {}) {
  const progressBase = options.progressBase ?? 0;
  const progressTotal = options.progressTotal ?? 1;
  const plan = validateCombineGroup(groupRecords, { groupLabel: options.groupLabel });
  const groupName = safeWaveBaseName(shortGroupLabel(key));
  const sourceInfo = combineSourceInfo(groupRecords);
  const state = { position: 0 };
  const riffHeader = new Uint8Array(12);
  riffHeader.set([82, 73, 70, 70], 0);
  riffHeader.set([87, 65, 86, 69], 8);

  try {
    await writable.write({ type: "write", position: 0, data: riffHeader });
    state.position = 12;
    await writeChunk(writable, state, "bext", bextChunkDataForCombine(plan.first, sourceInfo, plan.tracks));
    await writeChunk(writable, state, "iXML", new TextEncoder().encode(ixmlTextForCombine(plan.first, sourceInfo, plan.tracks)));
    await writeChunk(writable, state, "fmt ", fmtChunkDataForCombine(plan.first, plan.tracks.length, plan.blockAlign));
    await writeCombinedData(writable, state, plan, progressBase, progressTotal, options.onProgress);
    const riffSize = state.position - 8;
    if (riffSize > 0xffffffff) throw new Error(`${groupName}: 合并后超过 RIFF 4GB 限制`);
    const sizePatch = new Uint8Array(4);
    new DataView(sizePatch.buffer).setUint32(0, riffSize, LITTLE);
    await writable.write({ type: "write", position: 4, data: sizePatch });
    await writable.truncate(state.position);
  } finally {
    await writable.close();
  }
  return { name: outputName, channels: plan.tracks.length, durationSamples: plan.durationSamples, sampleRate: plan.first.sampleRate };
}
