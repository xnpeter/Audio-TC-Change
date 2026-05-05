import { parseFps } from "./timecode.js";

export function formatDuration(samples, sampleRate) {
  const seconds = Number(samples) / sampleRate;
  return `${seconds.toFixed(3)}s`;
}

export function toCsvValue(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resolveFpsLabel(fpsValue) {
  const fps = parseFps(fpsValue);
  const numeric = Number(fps.rate.n) / Number(fps.rate.d);
  return numeric.toFixed(3);
}

export function aleFpsLabel(fpsValue) {
  const label = resolveFpsLabel(fpsValue);
  return label.replace(/\.000$/, "");
}

export function audioCodecLabel(record) {
  if (record.audioFormat === 3) return "IEEE Float";
  if (record.audioFormat === 1) return "Linear PCM";
  return `WAVE format ${record.audioFormat}`;
}

export function resolveMetadataCsv(items, options) {
  const { samplesToTimecode } = options;
  const headers = [
    "File Name", "Clip Directory", "Duration TC", "Shot Frame Rate",
    "Audio Sample Rate", "Audio Channels", "Audio Codec", "Description",
    "Start TC", "End TC", "Audio Bit Depth"
  ];
  const rows = items.map(({ record, newTimeReference, fps, fpsValue, description }) => {
    const start = newTimeReference;
    const end = start + record.durationSamples;
    const startTc = samplesToTimecode(start, record.sampleRate, fps, { precise: false });
    return {
      "File Name": record.name,
      "Clip Directory": record.parentPath || "",
      "Duration TC": samplesToTimecode(record.durationSamples, record.sampleRate, fps, { precise: false }),
      "Shot Frame Rate": resolveFpsLabel(fpsValue),
      "Audio Sample Rate": record.sampleRate,
      "Audio Channels": record.channels,
      "Audio Codec": audioCodecLabel(record),
      "Description": `${description} -> ${startTc}`,
      "Start TC": startTc,
      "End TC": samplesToTimecode(end, record.sampleRate, fps, { precise: false }),
      "Audio Bit Depth": record.bitsPerSample,
    };
  });
  return [headers.join(","), ...rows.map(row => headers.map(h => toCsvValue(row[h] ?? "")).join(","))].join("\r\n");
}

export function toAleValue(value) {
  return String(value ?? "").replace(/\t/g, " ").replace(/[\r\n]+/g, " ").trim();
}

export function aleTracksLabel(record) {
  return Array.from({ length: record.channels }, (_, index) => `A${index + 1}`).join("");
}

export function aleMetadataText(items, defaultFpsValue, options) {
  const { samplesToTimecode, recordLabel } = options;
  const first = items[0];
  const fpsText = first ? aleFpsLabel(first.fpsValue) : aleFpsLabel(defaultFpsValue);
  const headers = ["Name", "Start", "End", "Duration", "Tracks", "FPS", "Source File", "File Name", "Comments"];
  const rows = items.map(({ record, newTimeReference, fps, fpsValue, description }) => {
    const start = newTimeReference;
    const end = start + record.durationSamples;
    return [
      record.name.replace(/\.[^.]+$/, ""),
      samplesToTimecode(start, record.sampleRate, fps, { precise: false }),
      samplesToTimecode(end, record.sampleRate, fps, { precise: false }),
      samplesToTimecode(record.durationSamples, record.sampleRate, fps, { precise: false }),
      aleTracksLabel(record),
      aleFpsLabel(fpsValue),
      recordLabel(record),
      record.name,
      description,
    ].map(toAleValue).join("\t");
  });
  return [
    "Heading",
    "FIELD_DELIM\tTABS",
    "VIDEO_FORMAT\t1080",
    `FPS\t${fpsText}`,
    "",
    "Column",
    headers.join("\t"),
    "",
    "Data",
    ...rows,
    "",
  ].join("\n");
}

export function utf16LeCsvBlob(text) {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return new Blob([bytes], { type: "text/csv;charset=utf-16le" });
}

export function manifestCsv(previews, options) {
  const {
    fpsSelectLabel,
    recordFps,
    recordFpsSource,
    recordFpsValue,
    recordLabel,
    samplesToTimecode,
  } = options;
  const headers = [
    "file", "sample_rate", "channels", "bits_per_sample", "fps", "fps_source", "time_reference_offset_byte",
    "offset_tc", "offset_frames", "offset_samples", "old_time_reference",
    "new_time_reference", "duration_samples", "old_start_tc", "new_start_tc",
    "old_end_tc", "new_end_tc"
  ];
  const rows = previews.map(p => ({
    file: recordLabel(p),
    sample_rate: p.sampleRate,
    channels: p.channels,
    bits_per_sample: p.bitsPerSample,
    fps: fpsSelectLabel(p.fpsValue || recordFpsValue(p)),
    fps_source: p.fpsSource || recordFpsSource(p),
    time_reference_offset_byte: p.timeReferenceOffset,
    offset_tc: p.offset.label,
    offset_frames: p.offset.frames,
    offset_samples: p.sampleOffset,
    old_time_reference: p.oldTimeReference,
    new_time_reference: p.newTimeReference,
    duration_samples: p.durationSamples,
    old_start_tc: samplesToTimecode(p.oldTimeReference, p.sampleRate, p.fps || recordFps(p)),
    new_start_tc: samplesToTimecode(p.newTimeReference, p.sampleRate, p.fps || recordFps(p)),
    old_end_tc: samplesToTimecode(p.oldTimeReference + p.durationSamples, p.sampleRate, p.fps || recordFps(p)),
    new_end_tc: samplesToTimecode(p.newTimeReference + p.durationSamples, p.sampleRate, p.fps || recordFps(p)),
  }));
  return [headers.join(","), ...rows.map(row => headers.map(h => toCsvValue(row[h])).join(","))].join("\n");
}
