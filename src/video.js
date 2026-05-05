import {
  framesToSamples,
  parseFps,
  timecodeToFrames,
} from "./timecode.js";
import { probeVideoMetadata } from "./video-metadata.js";

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
    ? await decodeVideoAudio(sourceFile).then(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason })
    )
    : { status: "rejected", reason: containerOk
      ? new Error(`${sourceFile.name}: 未检测到音轨`)
      : new Error(`${sourceFile.name}: 无法解析视频容器，跳过音轨解码`) };
  const audioBuffer = audioResult.status === "fulfilled" ? audioResult.value : null;
  const hasDecodedAudio = Boolean(audioBuffer?.numberOfChannels && audioBuffer?.length);
  const interleaved = hasDecodedAudio ? interleaveAudioBuffer(audioBuffer) : new Float32Array();
  const pcmBlob = new Blob([interleaved.buffer], { type: "application/octet-stream" });
  const channels = hasDecodedAudio ? audioBuffer.numberOfChannels : 0;
  const sampleRate = hasDecodedAudio ? audioBuffer.sampleRate : 48000;
  const bitsPerSample = 32;
  const blockAlign = channels ? channels * (bitsPerSample / 8) : 0;
  const width = containerMeta.width || elementMeta.width || 0;
  const height = containerMeta.height || elementMeta.height || 0;
  const resolution = width && height ? `${width}x${height}` : "";
  const durationSeconds = containerMeta.durationSeconds || elementMeta.duration || null;
  const durationSamples = hasDecodedAudio
    ? BigInt(audioBuffer.length)
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
      audioCodec: containerMeta.audioCodec || (hasDecodedAudio ? "Decoded audio" : ""),
      audioBitDepth: hasDecodedAudio ? String(bitsPerSample) : "",
      bitDepth: "",
      fieldDominance: "",
      dataLevel: "Auto",
      dateModified: sourceFile.lastModified ? new Date(sourceFile.lastModified).toLocaleString() : "",
      durationSeconds,
      audioDecodeError: audioResult.status === "rejected" ? audioResult.reason?.message || String(audioResult.reason) : "",
    },
  };
}
