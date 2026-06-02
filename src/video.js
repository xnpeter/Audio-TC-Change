import {
  framesToSamples,
  parseFps,
  timecodeToFrames,
} from "./timecode.js";
import { probeVideoMetadata } from "./video-metadata.js";

const MOV_PCM_SAMPLE_TYPES = new Set(["lpcm", "twos", "sowt", "in24", "in32", "fl32", "fl64"]);

function extensionLabel(name) {
  const match = String(name || "").match(/\.([^.]+)$/);
  return match ? match[1].toUpperCase() : "Video";
}

function videoMetadataFromElement(file) {
  return new Promise(resolve => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const url = URL.createObjectURL(file);
    let settled = false;

    function finish(meta) {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(meta);
    }

    video.onloadedmetadata = () => finish({
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
    });
    video.onerror = () => finish({ duration: null, width: null, height: null });
    video.src = url;
  });
}

function interleaveAudioBuffer(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const interleaved = new Float32Array(frames * channels);
  const channelData = Array.from({ length: channels }, (_, index) => audioBuffer.getChannelData(index));

  for (let frame = 0; frame < frames; frame++) {
    const base = frame * channels;
    for (let channel = 0; channel < channels; channel++) {
      interleaved[base + channel] = channelData[channel][frame] || 0;
    }
  }

  return interleaved;
}

async function decodeVideoAudio(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("当前浏览器不支持 Web Audio 解码视频音轨");

  const context = new AudioContextClass();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`${file.name}: 无法解码视频音轨；请确认浏览器支持此视频/音频编码，或先转成带 PCM/AAC 音轨的 MOV/MP4`);
  } finally {
    await context.close().catch(() => {});
  }
}

function audioTrackFromMetadata(containerMeta) {
  return (containerMeta.tracks || []).find(track =>
    track.handlerType === "soun" && MOV_PCM_SAMPLE_TYPES.has(track.sampleType)
  ) || null;
}

function chunkSampleEntry(stsc, chunkIndex) {
  if (!stsc?.length) return null;
  const oneBased = chunkIndex + 1;
  let entry = stsc[0];
  for (let i = 0; i < stsc.length; i++) {
    if (stsc[i].firstChunk > oneBased) break;
    entry = stsc[i];
  }
  return entry;
}

function readPcmSample(view, offset, bytesPerSample, bitsPerSample, littleEndian, floatingPoint) {
  if (floatingPoint && bitsPerSample === 32) return view.getFloat32(offset, littleEndian);
  if (floatingPoint && bitsPerSample === 64) return view.getFloat64(offset, littleEndian);
  if (bitsPerSample === 8) return (view.getInt8(offset)) / 128;
  if (bitsPerSample === 16) return view.getInt16(offset, littleEndian) / 32768;
  if (bitsPerSample === 24) {
    let value = littleEndian
      ? view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      : (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (bitsPerSample === 32) return view.getInt32(offset, littleEndian) / 2147483648;
  throw new Error(`不支持 ${bitsPerSample} bit MOV PCM 音轨`);
}

async function decodeMovPcmAudio(file, containerMeta) {
  const track = audioTrackFromMetadata(containerMeta);
  if (!track) throw new Error(`${file.name}: 未检测到可直接解析的 MOV PCM 音轨`);
  const channels = track.channels || 0;
  const sampleRate = Math.round(track.audioSampleRate || track.timescale || 0);
  const bitsPerSample = track.bitsPerSample || 0;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = track.stsz?.sampleCount || 0;
  const sampleSize = track.stsz?.sampleSize || 0;
  if (!channels || !sampleRate || !Number.isInteger(bytesPerSample) || !sampleCount) {
    throw new Error(`${file.name}: MOV PCM 音轨描述不完整`);
  }
  if ((track.framesPerPacket || 1) !== 1) {
    throw new Error(`${file.name}: 暂不支持每 packet 多帧的 MOV PCM 音轨`);
  }
  if (!sampleSize) throw new Error(`${file.name}: 暂不支持变长 MOV PCM sample table`);
  if (sampleSize < channels * bytesPerSample) throw new Error(`${file.name}: MOV PCM sample size 无效`);
  if (!track.chunkOffsets?.length || !track.stsc?.length) {
    throw new Error(`${file.name}: MOV PCM 音轨缺少 chunk table`);
  }

  const interleaved = new Float32Array(sampleCount * channels);
  const littleEndian = track.endian !== "big";
  let samplesDone = 0;

  for (let chunkIndex = 0; chunkIndex < track.chunkOffsets.length && samplesDone < sampleCount; chunkIndex++) {
    const entry = chunkSampleEntry(track.stsc, chunkIndex);
    const samplesInChunk = Math.min(entry?.samplesPerChunk || 0, sampleCount - samplesDone);
    if (!samplesInChunk) continue;
    const offset = track.chunkOffsets[chunkIndex];
    const byteLength = samplesInChunk * sampleSize;
    const view = new DataView(await file.slice(offset, offset + byteLength).arrayBuffer());
    for (let frame = 0; frame < samplesInChunk; frame++) {
      const sourceBase = frame * sampleSize;
      const targetBase = (samplesDone + frame) * channels;
      for (let channel = 0; channel < channels; channel++) {
        const sourceOffset = sourceBase + channel * bytesPerSample;
        interleaved[targetBase + channel] = readPcmSample(
          view,
          sourceOffset,
          bytesPerSample,
          bitsPerSample,
          littleEndian,
          Boolean(track.floatingPoint)
        );
      }
    }
    samplesDone += samplesInChunk;
  }

  if (samplesDone !== sampleCount) throw new Error(`${file.name}: MOV PCM 音轨数据不完整`);
  return {
    interleaved,
    sampleRate,
    channels,
    sourceBitsPerSample: bitsPerSample,
    source: "MOV PCM",
  };
}

function timeReferenceFromTimecode(timecode, fpsValue, sampleRate) {
  if (!timecode || !fpsValue) return 0n;
  try {
    const fps = parseFps(fpsValue);
    return framesToSamples(timecodeToFrames(timecode, fps), sampleRate, fps);
  } catch (error) {
    return 0n;
  }
}

function durationSamplesFromSeconds(seconds, sampleRate) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0n;
  return BigInt(Math.round(seconds * sampleRate));
}

export async function scanVideo(fileHandle, meta = {}) {
  const sourceFile = await fileHandle.getFile();
  const [elementResult, containerResult] = await Promise.allSettled([
    videoMetadataFromElement(sourceFile),
    probeVideoMetadata(sourceFile),
  ]);

  const elementMeta = elementResult.status === "fulfilled" ? elementResult.value : {};
  const containerOk = containerResult.status === "fulfilled";
  const containerMeta = containerOk ? containerResult.value : {};
  const shouldDecodeAudio = containerOk && Boolean(containerMeta.audioCodec);
  const audioResult = shouldDecodeAudio
    ? await decodeMovPcmAudio(sourceFile, containerMeta)
      .catch(() => decodeVideoAudio(sourceFile).then(audioBuffer => ({
        interleaved: interleaveAudioBuffer(audioBuffer),
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
        sourceBitsPerSample: 32,
        source: "Web Audio",
      })))
      .then(
        value => ({ status: "fulfilled", value }),
        reason => ({ status: "rejected", reason })
      )
    : { status: "rejected", reason: containerOk
      ? new Error(`${sourceFile.name}: 未检测到音轨`)
      : new Error(`${sourceFile.name}: 无法解析视频容器，跳过音轨解码`) };
  const decodedAudio = audioResult.status === "fulfilled" ? audioResult.value : null;
  const hasDecodedAudio = Boolean(decodedAudio?.channels && decodedAudio?.interleaved?.length);
  const interleaved = hasDecodedAudio ? decodedAudio.interleaved : new Float32Array();
  const pcmBlob = new Blob([interleaved.buffer], { type: "application/octet-stream" });
  const channels = hasDecodedAudio ? decodedAudio.channels : 0;
  const sampleRate = hasDecodedAudio ? decodedAudio.sampleRate : 48000;
  const bitsPerSample = 32;
  const blockAlign = channels ? channels * (bitsPerSample / 8) : 0;
  const width = containerMeta.width || elementMeta.width || 0;
  const height = containerMeta.height || elementMeta.height || 0;
  const resolution = width && height ? `${width}x${height}` : "";
  const durationSeconds = containerMeta.durationSeconds || elementMeta.duration || null;
  const durationSamples = hasDecodedAudio
    ? BigInt(Math.floor(interleaved.length / channels))
    : durationSamplesFromSeconds(durationSeconds, sampleRate);
  const oldTimeReference = timeReferenceFromTimecode(containerMeta.startTc, containerMeta.fpsValue, sampleRate);

  return {
    fileHandle: null,
    sourceFileHandle: fileHandle,
    sourceFile,
    file: pcmBlob,
    name: sourceFile.name,
    relativePath: meta.relativePath || sourceFile.name,
    parentPath: meta.parentPath || "",
    parentHandle: meta.parentHandle || null,
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    audioFormat: 3,
    hasBext: false,
    bextInfo: null,
    timeReferenceOffset: null,
    oldTimeReference,
    ixmlInfo: null,
    dataOffset: 0,
    dataSize: interleaved.byteLength,
    durationSamples,
    _video: {
      sourceType: "video",
      container: extensionLabel(sourceFile.name),
      fpsValue: containerMeta.fpsValue || "",
      startTc: containerMeta.startTc || "",
      timecodeSource: containerMeta.timecodeSource || "",
      reelName: containerMeta.reelName || "",
      resolution,
      videoCodec: containerMeta.videoCodec || extensionLabel(sourceFile.name),
      audioCodec: containerMeta.audioCodec || (hasDecodedAudio ? decodedAudio.source : ""),
      audioBitDepth: hasDecodedAudio ? String(decodedAudio.sourceBitsPerSample || bitsPerSample) : "",
      bitDepth: "",
      fieldDominance: "",
      dataLevel: "Auto",
      dateModified: sourceFile.lastModified ? new Date(sourceFile.lastModified).toLocaleString() : "",
      durationSeconds,
      audioDecodeError: audioResult.status === "rejected" ? audioResult.reason?.message || String(audioResult.reason) : "",
    },
  };
}
