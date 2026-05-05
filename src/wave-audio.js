import { LITTLE, readDataView } from "./wave.js";

export function readAudioSample(view, offset, record) {
  const bytes = record.bitsPerSample / 8;
  if (!Number.isInteger(bytes)) throw new Error(`${record.name}: 不支持 ${record.bitsPerSample} bit 音频`);
  if (record.audioFormat === 3 && record.bitsPerSample === 32) return view.getFloat32(offset, LITTLE);
  if (record.audioFormat !== 1 && record.audioFormat !== 65534) {
    throw new Error(`${record.name}: 当前只支持 PCM / Extensible PCM WAV`);
  }
  if (record.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (record.bitsPerSample === 16) return view.getInt16(offset, LITTLE) / 32768;
  if (record.bitsPerSample === 24) {
    let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (record.bitsPerSample === 32) return view.getInt32(offset, LITTLE) / 2147483648;
  throw new Error(`${record.name}: 不支持 ${record.bitsPerSample} bit 音频`);
}

export function writeSilenceSample(view, offset, record) {
  if (record.bitsPerSample === 8 && record.audioFormat === 1) {
    view.setUint8(offset, 128);
    return;
  }
  const bytes = record.bitsPerSample / 8;
  for (let i = 0; i < bytes; i++) view.setUint8(offset + i, 0);
}

export async function muteLtcChannel(record, channelIndex, writable, progressBase, progressTotal, onProgress = null) {
  const bytesPerSample = record.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample)) throw new Error(`${record.name}: 不支持 ${record.bitsPerSample} bit 静音`);
  const framesPerChunk = Math.max(1, Math.floor((4 * 1024 * 1024) / record.blockAlign));
  const channelByteOffset = channelIndex * bytesPerSample;
  let framesDone = 0n;

  while (framesDone < record.durationSamples) {
    const framesLeft = record.durationSamples - framesDone;
    const framesThisChunk = Number(framesLeft < BigInt(framesPerChunk) ? framesLeft : BigInt(framesPerChunk));
    const position = record.dataOffset + Number(framesDone) * record.blockAlign;
    const bytesToRead = framesThisChunk * record.blockAlign;
    const view = await readDataView(record.file, position, bytesToRead);

    for (let frame = 0; frame < framesThisChunk; frame++) {
      writeSilenceSample(view, frame * record.blockAlign + channelByteOffset, record);
    }

    await writable.write({ type: "write", position, data: new Uint8Array(view.buffer) });
    framesDone += BigInt(framesThisChunk);
    const recordProgress = Number(framesDone) / Number(record.durationSamples);
    onProgress?.("正在静音 LTC 轨…", record.name, progressBase + recordProgress, progressTotal);
  }
}
