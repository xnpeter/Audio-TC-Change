import {
  framesToSamples,
  parseFps,
  timecodeToFrames,
} from "./timecode.js";

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 0;
const DEFAULT_BIT_DEPTH = 16;

function parseAle(text) {
  const lines = text.split(/\r?\n/);
  let headersLineIdx = -1;
  let dataStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "Column") headersLineIdx = i + 1;
    if (lines[i] === "Data") dataStartIdx = i;
  }
  if (headersLineIdx < 0 || dataStartIdx < 0) return [];

  const headers = lines[headersLineIdx].split("\t");
  const col = name => headers.indexOf(name);

  const rows = [];
  for (let i = dataStartIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length <= 1) continue;

    const name = fields[col("Name")] || "";
    if (!name) continue;

    rows.push({
      name,
      parentPath: fields[col("Clip Directory")] || "",
      duration: fields[col("Duration")] || "00:00:00:00",
      fps: fields[col("FPS")] || "",
      audioSR: fields[col("Audio SR")] || "",
      audioChannels: fields[col("Audio Channels")] || "",
      audioCodec: fields[col("Audio Codec")] || "",
      start: fields[col("Start")] || "",
      end: fields[col("End")] || "",
      startFrame: fields[col("StartFrameNumber")] || "",
      endFrame: fields[col("EndFrameNumber")] || "",
      length: fields[col("Length")] || "",
      bitDepth: fields[col("Bit Depth")] || "",
      fieldDominance: fields[col("Field Dominance")] || "",
      dataLevel: fields[col("Data Level")] || "",
      audioBitDepth: fields[col("Audio Bit Depth")] || "",
      dateModified: fields[col("Date Modified")] || "",
      resolution: fields[col("Resolution")] || "",
      videoCodec: fields[col("Video Codec")] || "",
    });
  }
  return rows;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const col = name => headers.indexOf(name);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length <= 1) continue;

    const name = fields[col("File Name")] || "";
    if (!name) continue;

    rows.push({
      name,
      parentPath: fields[col("Clip Directory")] || "",
      duration: fields[col("Duration TC")] || "00:00:00:00",
      fps: fields[col("Shot Frame Rate")] || "",
      audioSR: fields[col("Audio Sample Rate")] || "",
      audioChannels: fields[col("Audio Channels")] || "",
      audioCodec: fields[col("Audio Codec")] || "",
      start: fields[col("Start TC")] || "",
      end: fields[col("End TC")] || "",
      startFrame: fields[col("Start Frame")] || "",
      endFrame: fields[col("End Frame")] || "",
      length: fields[col("Frames")] || "",
      bitDepth: fields[col("Bit Depth")] || "",
      fieldDominance: fields[col("Field Dominance")] || "",
      dataLevel: fields[col("Data Level")] || "",
      audioBitDepth: fields[col("Audio Bit Depth")] || "",
      dateModified: fields[col("Date Modified")] || "",
      resolution: fields[col("Resolution")] || "",
      videoCodec: fields[col("Video Codec")] || "",
    });
  }
  return rows;
}

function normalizeFpsValue(raw) {
  const t = raw.trim();
  if (!t) return "24";
  // Remove trailing zeros from decimal: "24.000" -> "24"
  const parsed = parseFloat(t);
  if (isNaN(parsed)) return "24";
  // Map common values to preset keys
  const map = {
    23.976: "23.976",
    24: "24",
    25: "25",
    29.97: "29.97",
    30: "30",
    48: "48",
    50: "50",
    59.94: "59.94",
    60: "60",
    96: "96",
    100: "100",
    119.88: "119.88",
    120: "120",
  };
  return map[parsed] || String(parsed);
}

function metadataToRecord(meta) {
  const fpsValue = normalizeFpsValue(meta.fps);
  const fps = parseFps(fpsValue);
  const sampleRate = parseInt(meta.audioSR, 10) || DEFAULT_SAMPLE_RATE;
  const channels = parseInt(meta.audioChannels, 10) || DEFAULT_CHANNELS;
  const hasAudio = channels > 0;
  const bitsPerSample = hasAudio ? (parseInt(meta.audioBitDepth || meta.bitDepth, 10) || DEFAULT_BIT_DEPTH) : 0;

  const startTc = meta.start || "00:00:00:00";
  const durationTc = meta.duration || "00:00:00:00";

  const startFrames = timecodeToFrames(startTc, fps);
  const durationFrames = timecodeToFrames(durationTc, fps);
  const oldTimeReference = framesToSamples(startFrames, sampleRate, fps);
  const durationSamples = framesToSamples(durationFrames, sampleRate, fps);

  return {
    name: meta.name,
    relativePath: meta.name,
    parentPath: meta.parentPath || "",
    parentHandle: null,

    fileHandle: null,
    file: null,

    sampleRate,
    channels,
    bitsPerSample,
    blockAlign: hasAudio ? channels * Math.max(bitsPerSample / 8, 1) : 0,
    audioFormat: 1,

    hasBext: false,
    bextInfo: null,
    timeReferenceOffset: 0,
    oldTimeReference,

    ixmlInfo: null,

    dataOffset: 0,
    dataSize: 0,
    durationSamples,

    _meta: {
      fpsValue,
      resolution: meta.resolution || "",
      videoCodec: meta.videoCodec || "",
      audioCodec: meta.audioCodec || "",
      bitDepth: meta.bitDepth || "",
      fieldDominance: meta.fieldDominance || "",
      dataLevel: meta.dataLevel || "",
      audioBitDepth: meta.audioBitDepth || "",
      dateModified: meta.dateModified || "",
      startTc,
      endTc: meta.end || "",
      durationTc,
    },
  };
}

export function parseMetadataImport(text, suffix) {
  const isAle = suffix === ".ale" || /\.ale$/i.test(suffix);
  const rows = isAle ? parseAle(text) : parseCsv(text);
  return rows.map(metadataToRecord).filter(record => record.oldTimeReference !== undefined);
}
