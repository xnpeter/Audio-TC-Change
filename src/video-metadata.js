import {
  framesToTimecode,
  parseFps,
} from "./timecode.js";

const VIDEO_SAMPLE_TYPES = new Set([
  "avc1", "avc3", "hvc1", "hev1", "mp4v",
  "apch", "apcn", "apcs", "apco", "ap4h", "ap4x",
]);

const AUDIO_SAMPLE_TYPES = new Set(["mp4a", "twos", "sowt", "lpcm", "in24", "in32", "fl32", "fl64"]);

function readAscii(view, pos, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(view.getUint8(pos + i));
  return out;
}

function readUint64(view, pos) {
  return Number(view.getBigUint64(pos));
}

function atomType(view, pos) {
  return readAscii(view, pos, 4);
}

function atomSize(view, pos, end) {
  if (pos + 8 > end) return null;
  let size = view.getUint32(pos);
  let headerSize = 8;
  if (size === 1) {
    if (pos + 16 > end) return null;
    size = readUint64(view, pos + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < headerSize || pos + size > end) return null;
  return { size, headerSize };
}

async function readView(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

async function readTopLevelAtoms(file) {
  const atoms = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const header = await readView(file, pos, 16);
    let size = header.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      size = readUint64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (!size || size < headerSize || pos + size > file.size) break;
    atoms.push({ type: atomType(header, 4), start: pos, size, headerSize });
    pos += size;
  }
  return atoms;
}

function children(view, start, end) {
  const items = [];
  let pos = start;
  while (pos + 8 <= end) {
    const parsed = atomSize(view, pos, end);
    if (!parsed) break;
    const type = atomType(view, pos + 4);
    items.push({
      type,
      start: pos,
      size: parsed.size,
      headerSize: parsed.headerSize,
      dataStart: pos + parsed.headerSize,
      end: pos + parsed.size,
    });
    pos += parsed.size;
  }
  return items;
}

function firstChild(view, start, end, type) {
  return children(view, start, end).find(item => item.type === type) || null;
}

function parseMdhd(view, box) {
  const version = view.getUint8(box.dataStart);
  const base = box.dataStart + 4;
  if (version === 1) {
    return {
      timescale: view.getUint32(base + 16),
      duration: readUint64(view, base + 20),
    };
  }
  return {
    timescale: view.getUint32(base + 8),
    duration: view.getUint32(base + 12),
  };
}

function parseTkhd(view, box) {
  const version = view.getUint8(box.dataStart);
  const base = box.dataStart + 4;
  const trackIdOffset = version === 1 ? 16 : 8;
  return {
    trackId: view.getUint32(base + trackIdOffset),
    width: view.getUint32(box.end - 8) / 65536,
    height: view.getUint32(box.end - 4) / 65536,
  };
}

function parseHdlr(view, box) {
  const handlerType = readAscii(view, box.dataStart + 8, 4);
  let name = "";
  const nameStart = box.dataStart + 24;
  if (nameStart < box.end) {
    name = readAscii(view, nameStart, box.end - nameStart).replace(/\0+$/, "").trim();
    if (name.length > 1 && name.charCodeAt(0) < 32) name = name.slice(1).trim();
  }
  return { handlerType, name };
}

function parseStts(view, box) {
  const count = view.getUint32(box.dataStart + 4);
  const entries = [];
  let pos = box.dataStart + 8;
  for (let i = 0; i < count && pos + 8 <= box.end; i++) {
    entries.push({
      sampleCount: view.getUint32(pos),
      sampleDelta: view.getUint32(pos + 4),
    });
    pos += 8;
  }
  return entries;
}

function parseStsz(view, box) {
  const sampleSize = view.getUint32(box.dataStart + 4);
  const sampleCount = view.getUint32(box.dataStart + 8);
  const sizes = [];
  let pos = box.dataStart + 12;
  if (!sampleSize) {
    for (let i = 0; i < sampleCount && pos + 4 <= box.end; i++) {
      sizes.push(view.getUint32(pos));
      pos += 4;
    }
  }
  return { sampleSize, sampleCount, sizes };
}

function parseStsc(view, box) {
  const count = view.getUint32(box.dataStart + 4);
  const entries = [];
  let pos = box.dataStart + 8;
  for (let i = 0; i < count && pos + 12 <= box.end; i++) {
    entries.push({
      firstChunk: view.getUint32(pos),
      samplesPerChunk: view.getUint32(pos + 4),
      sampleDescriptionIndex: view.getUint32(pos + 8),
    });
    pos += 12;
  }
  return entries;
}

function parseChunkOffsets(view, box) {
  const count = view.getUint32(box.dataStart + 4);
  const offsets = [];
  let pos = box.dataStart + 8;
  for (let i = 0; i < count && pos + (box.type === "co64" ? 8 : 4) <= box.end; i++) {
    offsets.push(box.type === "co64" ? readUint64(view, pos) : view.getUint32(pos));
    pos += box.type === "co64" ? 8 : 4;
  }
  return offsets;
}

function codecLabel(type, compressorName = "") {
  if (compressorName) return compressorName;
  const labels = {
    avc1: "H.264",
    avc3: "H.264",
    hvc1: "HEVC",
    hev1: "HEVC",
    apch: "Apple ProRes 422 HQ",
    apcn: "Apple ProRes 422",
    apcs: "Apple ProRes 422 LT",
    apco: "Apple ProRes 422 Proxy",
    ap4h: "Apple ProRes 4444",
    ap4x: "Apple ProRes 4444 XQ",
    mp4a: "AAC",
    twos: "PCM signed big-endian",
    sowt: "PCM signed little-endian",
    lpcm: "Linear PCM",
  };
  return labels[type] || type || "";
}

function audioEndianFor(type, flags = 0) {
  if (type === "sowt") return "little";
  if (type === "twos" || type === "in24" || type === "in32") return "big";
  if (flags & 2) return "big";
  return "little";
}

function parseAudioSampleEntry(view, entryStart, entryEnd, type) {
  const version = entryStart + 18 <= entryEnd ? view.getUint16(entryStart + 16) : 0;
  const info = {
    codec: codecLabel(type),
    version,
    channels: 0,
    sampleRate: 0,
    bitsPerSample: 0,
    bytesPerPacket: 0,
    framesPerPacket: 1,
    endian: audioEndianFor(type),
    floatingPoint: type === "fl32" || type === "fl64",
  };

  if (version === 2 && entryStart + 72 <= entryEnd) {
    const flags = view.getUint32(entryStart + 60);
    info.sampleRate = view.getFloat64(entryStart + 40);
    info.channels = view.getUint32(entryStart + 48);
    info.bitsPerSample = view.getUint32(entryStart + 56);
    info.bytesPerPacket = view.getUint32(entryStart + 64);
    info.framesPerPacket = view.getUint32(entryStart + 68) || 1;
    info.endian = audioEndianFor(type, flags);
    info.floatingPoint = Boolean(flags & 1) || info.floatingPoint;
    return info;
  }

  if (entryStart + 36 <= entryEnd) {
    info.channels = view.getUint16(entryStart + 24);
    info.bitsPerSample = view.getUint16(entryStart + 26);
    info.bytesPerPacket = Math.ceil(info.bitsPerSample / 8) * info.channels;
    info.sampleRate = view.getUint32(entryStart + 32) / 65536;
  }

  return info;
}

function parseCompressorName(view, entryStart, entryEnd) {
  const nameLenOffset = entryStart + 50;
  if (nameLenOffset >= entryEnd) return "";
  const len = Math.min(view.getUint8(nameLenOffset), 31, entryEnd - nameLenOffset - 1);
  if (!len) return "";
  return readAscii(view, nameLenOffset + 1, len).replace(/\0+$/, "").trim();
}

function parseNameAtom(view, start, end) {
  for (let pos = start; pos + 8 <= end; pos++) {
    if (readAscii(view, pos, 4) !== "name") continue;
    const dataStart = pos + 4;
    const len = dataStart + 2 <= end ? view.getUint16(dataStart) : 0;
    let valueStart = dataStart + 2;
    if (valueStart + 2 + len <= end && view.getUint16(valueStart) === 0) valueStart += 2;
    if (len && valueStart + len <= end) {
      return readAscii(view, valueStart, len).replace(/\0+$/, "").trim();
    }
  }

  for (const item of children(view, start, end)) {
    if (item.type !== "name" || item.dataStart >= item.end) continue;
    let pos = item.dataStart;
    if (pos + 2 <= item.end) {
      const len = view.getUint16(pos);
      pos += 2;
      if (pos + 2 + len <= item.end && view.getUint16(pos) === 0) pos += 2;
      if (pos + len <= item.end) return readAscii(view, pos, len).replace(/\0+$/, "").trim();
    }
    return readAscii(view, item.dataStart, item.end - item.dataStart).replace(/\0+$/, "").trim();
  }
  return "";
}

function parseStsd(view, box) {
  const entryCount = view.getUint32(box.dataStart + 4);
  const entries = [];
  let pos = box.dataStart + 8;
  for (let i = 0; i < entryCount && pos + 8 <= box.end; i++) {
    const size = view.getUint32(pos);
    const type = readAscii(view, pos + 4, 4);
    if (size < 8 || pos + size > box.end) break;
    const entry = { type, size };

    if (VIDEO_SAMPLE_TYPES.has(type) && pos + 36 <= box.end) {
      const compressorName = parseCompressorName(view, pos, pos + size);
      entry.width = view.getUint16(pos + 32);
      entry.height = view.getUint16(pos + 34);
      entry.codec = codecLabel(type, compressorName);
    } else if (AUDIO_SAMPLE_TYPES.has(type)) {
      Object.assign(entry, parseAudioSampleEntry(view, pos, pos + size, type));
    } else if (type === "tmcd" && pos + 33 <= pos + size) {
      const flags = view.getUint32(pos + 20);
      const timeScale = view.getUint32(pos + 24);
      const frameDuration = view.getUint32(pos + 28);
      const numFrames = view.getUint8(pos + 32);
      entry.timecode = {
        flags,
        drop: Boolean(flags & 1),
        timeScale,
        frameDuration,
        numFrames,
        reelName: pos + 36 <= pos + size ? parseNameAtom(view, pos + 36, pos + size) : "",
      };
    }

    entries.push(entry);
    pos += size;
  }
  return entries;
}

function parseTrack(view, trak) {
  const track = {};
  const tkhd = firstChild(view, trak.dataStart, trak.end, "tkhd");
  if (tkhd) Object.assign(track, parseTkhd(view, tkhd));

  const mdia = firstChild(view, trak.dataStart, trak.end, "mdia");
  if (!mdia) return track;
  const mdhd = firstChild(view, mdia.dataStart, mdia.end, "mdhd");
  const hdlr = firstChild(view, mdia.dataStart, mdia.end, "hdlr");
  if (mdhd) Object.assign(track, parseMdhd(view, mdhd));
  if (hdlr) Object.assign(track, parseHdlr(view, hdlr));

  const minf = firstChild(view, mdia.dataStart, mdia.end, "minf");
  const stbl = minf ? firstChild(view, minf.dataStart, minf.end, "stbl") : null;
  if (!stbl) return track;

  for (const box of children(view, stbl.dataStart, stbl.end)) {
    if (box.type === "stsd") track.sampleDescriptions = parseStsd(view, box);
    if (box.type === "stsc") track.stsc = parseStsc(view, box);
    if (box.type === "stts") track.stts = parseStts(view, box);
    if (box.type === "stsz") track.stsz = parseStsz(view, box);
    if (box.type === "stco" || box.type === "co64") track.chunkOffsets = parseChunkOffsets(view, box);
  }

  const firstDesc = track.sampleDescriptions?.[0];
  if (firstDesc) {
    track.sampleType = firstDesc.type;
    track.codec = firstDesc.codec || codecLabel(firstDesc.type);
    if (firstDesc.channels) track.channels = firstDesc.channels;
    if (firstDesc.sampleRate) track.audioSampleRate = firstDesc.sampleRate;
    if (firstDesc.bitsPerSample) track.bitsPerSample = firstDesc.bitsPerSample;
    if (firstDesc.bytesPerPacket) track.bytesPerPacket = firstDesc.bytesPerPacket;
    if (firstDesc.framesPerPacket) track.framesPerPacket = firstDesc.framesPerPacket;
    if (firstDesc.endian) track.endian = firstDesc.endian;
    if (firstDesc.floatingPoint) track.floatingPoint = true;
    if (firstDesc.width) track.width = firstDesc.width;
    if (firstDesc.height) track.height = firstDesc.height;
    if (firstDesc.timecode) track.timecodeDescription = firstDesc.timecode;
  }

  return track;
}

function rateFromTrack(track) {
  if (!track?.timescale || !track?.stts?.length) return null;
  if (track.stts.length === 1 && track.stts[0].sampleDelta) {
    return { n: track.timescale, d: track.stts[0].sampleDelta };
  }
  const sampleCount = track.stts.reduce((sum, item) => sum + item.sampleCount, 0);
  const duration = track.stts.reduce((sum, item) => sum + item.sampleCount * item.sampleDelta, 0);
  return sampleCount && duration ? { n: sampleCount * track.timescale, d: duration } : null;
}

function fpsValueFromRate(rate, drop = false) {
  if (!rate?.n || !rate?.d) return "";
  const numeric = rate.n / rate.d;
  const near = (value, target) => Math.abs(value - target) < 0.0002;
  if (near(numeric, 24000 / 1001)) return "23.976";
  if (near(numeric, 30000 / 1001)) return drop ? "29.97df" : "29.97";
  if (near(numeric, 60000 / 1001)) return drop ? "59.94df" : "59.94";
  if (near(numeric, 120000 / 1001)) return drop ? "119.88df" : "119.88";
  for (const value of [24, 25, 30, 48, 50, 60, 96, 100, 120]) {
    if (near(numeric, value)) return String(value);
  }
  return numeric.toFixed(3).replace(/\.?0+$/, "");
}

function fpsFromTimecodeDescription(desc) {
  if (!desc?.timeScale || !desc?.frameDuration) return "";
  return fpsValueFromRate({ n: desc.timeScale, d: desc.frameDuration }, desc.drop);
}

function firstSampleSize(track) {
  if (!track?.stsz) return 0;
  return track.stsz.sampleSize || track.stsz.sizes?.[0] || 0;
}

async function firstSampleView(file, track, maxBytes = 64 * 1024) {
  const offset = track?.chunkOffsets?.[0];
  const size = firstSampleSize(track);
  if (offset == null || !size) return null;
  return readView(file, offset, Math.min(size, maxBytes));
}

function firstSampleTruncated(track, maxBytes = 64 * 1024) {
  const size = firstSampleSize(track);
  return size > maxBytes;
}

function parseTmcdSample(view, fpsValue) {
  if (!view || view.byteLength < 4 || !fpsValue) return "";
  try {
    return framesToTimecode(BigInt(view.getUint32(0)), parseFps(fpsValue));
  } catch (error) {
    return "";
  }
}

function bcd(value) {
  const hi = value >> 4;
  const lo = value & 0x0f;
  if (hi > 9 || lo > 9) return null;
  return hi * 10 + lo;
}

function parseRtmdTimecode(view, fpsValue) {
  if (!view || !fpsValue) return "";
  let nominal = 60;
  try {
    nominal = Number(parseFps(fpsValue).nominal);
  } catch (error) {
    nominal = 60;
  }

  for (let pos = 0; pos + 8 <= view.byteLength; pos++) {
    if (view.getUint8(pos) !== 0x00 || view.getUint8(pos + 1) !== 0x08 ||
        view.getUint8(pos + 2) !== 0x10 || view.getUint8(pos + 3) !== 0x02) {
      continue;
    }
    const ff = bcd(view.getUint8(pos + 4));
    const ss = bcd(view.getUint8(pos + 5));
    const mm = bcd(view.getUint8(pos + 6));
    const hh = bcd(view.getUint8(pos + 7));
    if (hh == null || mm == null || ss == null || ff == null) continue;
    if (hh > 23 || mm > 59 || ss > 59 || ff >= nominal) continue;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
  }
  return "";
}

export async function probeVideoMetadata(file) {
  const atoms = await readTopLevelAtoms(file);
  const moovAtom = atoms.find(item => item.type === "moov");
  if (!moovAtom) return {};

  const moov = await readView(file, moovAtom.start, moovAtom.size);
  const tracks = children(moov, moovAtom.headerSize, moov.byteLength)
    .filter(item => item.type === "trak")
    .map(item => parseTrack(moov, item));

  const videoTrack = tracks.find(track => track.handlerType === "vide") ||
    tracks.find(track => VIDEO_SAMPLE_TYPES.has(track.sampleType));
  const audioTrack = tracks.find(track => track.handlerType === "soun") ||
    tracks.find(track => AUDIO_SAMPLE_TYPES.has(track.sampleType));
  const timecodeTrack = tracks.find(track => track.handlerType === "tmcd" || track.sampleType === "tmcd");
  const rtmdTrack = tracks.find(track => track.sampleType === "rtmd" || track.handlerType === "meta");
  const videoRate = rateFromTrack(videoTrack);
  let fpsValue = fpsValueFromRate(videoRate);

  let startTc = "";
  let reelName = "";
  let timecodeSource = "";
  if (timecodeTrack?.timecodeDescription) {
    fpsValue = fpsFromTimecodeDescription(timecodeTrack.timecodeDescription) || fpsValue;
    reelName = timecodeTrack.timecodeDescription.reelName || "";
    startTc = parseTmcdSample(await firstSampleView(file, timecodeTrack, 16), fpsValue);
    if (startTc) timecodeSource = "tmcd";
  }

  if (!startTc && rtmdTrack) {
    startTc = parseRtmdTimecode(await firstSampleView(file, rtmdTrack), fpsValue);
    if (startTc) timecodeSource = "rtmd";
    else if (firstSampleTruncated(rtmdTrack)) timecodeSource = "rtmd-truncated";
  }

  const durationSeconds = videoTrack?.timescale && videoTrack?.duration
    ? videoTrack.duration / videoTrack.timescale
    : null;

  return {
    fpsValue,
    startTc,
    timecodeSource,
    reelName,
    width: videoTrack?.width || 0,
    height: videoTrack?.height || 0,
    videoCodec: videoTrack?.codec || codecLabel(videoTrack?.sampleType || ""),
    audioCodec: audioTrack?.codec || codecLabel(audioTrack?.sampleType || ""),
    durationSeconds,
    tracks,
  };
}
