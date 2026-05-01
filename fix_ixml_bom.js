#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = process.argv[2];
const apply = process.argv.includes("--apply");
const reportPath = process.argv.includes("--report")
  ? process.argv[process.argv.indexOf("--report") + 1]
  : null;

if (!root) {
  console.error("Usage: node fix_ixml_bom.js <folder> [--apply] [--report report.json]");
  process.exit(2);
}

function ascii(buffer, offset, length) {
  return buffer.toString("ascii", offset, offset + length);
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(wav|bwf)$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function readHeader(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  if (bytes !== length) throw new Error(`short read at ${position}`);
  return buffer;
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function inspect(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const header = readHeader(fd, 0, 12);
    if (ascii(header, 0, 4) !== "RIFF" || ascii(header, 8, 4) !== "WAVE") {
      return { file, error: "not RIFF/WAVE" };
    }
    const riffSize = header.readUInt32LE(4);
    const limit = Math.min(stat.size, riffSize + 8);
    let pos = 12;
    let ixml = null;
    let bext = null;
    let chunkCount = 0;
    while (pos + 8 <= limit) {
      const chunkHeader = readHeader(fd, pos, 8);
      const id = ascii(chunkHeader, 0, 4);
      const size = chunkHeader.readUInt32LE(4);
      const start = pos + 8;
      if (start + size > stat.size) throw new Error(`chunk ${id} truncated`);
      chunkCount += 1;

      if (id === "bext" && size >= 346) {
        const tr = readHeader(fd, start + 338, 8).readBigUInt64LE(0);
        bext = { timeReference: tr.toString() };
      } else if (id === "iXML") {
        const first = readHeader(fd, start, Math.min(size, 16));
        const xmlBuffer = Buffer.alloc(size);
        fs.readSync(fd, xmlBuffer, 0, size, start);
        const xml = xmlBuffer.toString("utf8");
        ixml = {
          offset: pos,
          start,
          size,
          hasBom: first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf,
          timecodeRate: readTag(xml, "TIMECODE_RATE"),
          timecodeFlag: readTag(xml, "TIMECODE_FLAG"),
          timestampHi: readTag(xml, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI"),
          timestampLo: readTag(xml, "TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO"),
          timestampSampleRate: readTag(xml, "TIMESTAMP_SAMPLE_RATE"),
        };
      }
      pos = start + size + (size & 1);
    }
    return { file, size: stat.size, riffSize, chunkCount, bext, ixml };
  } catch (err) {
    return { file, error: err.message };
  } finally {
    fs.closeSync(fd);
  }
}

function copyRange(inFd, outFd, start, length) {
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let remaining = length;
  let readPos = start;
  while (remaining > 0) {
    const want = Math.min(buffer.length, remaining);
    const bytes = fs.readSync(inFd, buffer, 0, want, readPos);
    if (bytes <= 0) throw new Error(`short copy at ${readPos}`);
    fs.writeSync(outFd, buffer, 0, bytes);
    readPos += bytes;
    remaining -= bytes;
  }
}

function fixFile(file) {
  const before = inspect(file);
  if (before.error) throw new Error(before.error);
  if (!before.ixml?.hasBom) return { file, changed: false, before, after: before };

  const oldIxmlSize = before.ixml.size;
  const newIxmlSize = oldIxmlSize - 3;
  if (newIxmlSize < 0) throw new Error("invalid iXML size");
  const oldPad = oldIxmlSize & 1;
  const newPad = newIxmlSize & 1;
  const riffDelta = -3 + newPad - oldPad;
  const newRiffSize = before.riffSize + riffDelta;
  if (newRiffSize < 4 || newRiffSize > 0xffffffff) throw new Error("invalid resulting RIFF size");

  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmp = path.join(dir, `.${base}.ixml-bom-fix.tmp`);
  const inFd = fs.openSync(file, "r");
  const outFd = fs.openSync(tmp, "w", fs.statSync(file).mode);
  try {
    const riffHeader = readHeader(inFd, 0, 12);
    riffHeader.writeUInt32LE(newRiffSize, 4);
    fs.writeSync(outFd, riffHeader);

    let pos = 12;
    const limit = Math.min(before.size, before.riffSize + 8);
    while (pos + 8 <= limit) {
      const header = readHeader(inFd, pos, 8);
      const id = ascii(header, 0, 4);
      const size = header.readUInt32LE(4);
      const start = pos + 8;
      if (id === "iXML" && start === before.ixml.start) {
        header.writeUInt32LE(newIxmlSize, 4);
        fs.writeSync(outFd, header);
        copyRange(inFd, outFd, start + 3, newIxmlSize);
        if (newPad) fs.writeSync(outFd, Buffer.from([0]));
      } else {
        fs.writeSync(outFd, header);
        copyRange(inFd, outFd, start, size);
        if (size & 1) copyRange(inFd, outFd, start + size, 1);
      }
      pos = start + size + (size & 1);
    }
    if (before.size > limit) copyRange(inFd, outFd, limit, before.size - limit);
    fs.fsyncSync(outFd);
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }

  const stat = fs.statSync(file);
  fs.chmodSync(tmp, stat.mode);
  fs.renameSync(tmp, file);
  fs.utimesSync(file, stat.atime, stat.mtime);

  const after = inspect(file);
  return { file, changed: true, before, after };
}

const files = walk(root).sort();
const before = files.map(inspect);
const bomFiles = before.filter(item => item.ixml?.hasBom);
const errorsBefore = before.filter(item => item.error);

const changes = [];
const errors = [];
if (apply) {
  for (const item of bomFiles) {
    try {
      changes.push(fixFile(item.file));
    } catch (err) {
      errors.push({ file: item.file, error: err.message });
    }
  }
}

const after = files.map(inspect);
const summary = {
  root,
  mode: apply ? "apply" : "dry-run",
  total: files.length,
  before: {
    bom: before.filter(item => item.ixml?.hasBom).length,
    noBom: before.filter(item => item.ixml && !item.ixml.hasBom).length,
    noIxml: before.filter(item => !item.error && !item.ixml).length,
    errors: errorsBefore.length,
  },
  after: {
    bom: after.filter(item => item.ixml?.hasBom).length,
    noBom: after.filter(item => item.ixml && !item.ixml.hasBom).length,
    noIxml: after.filter(item => !item.error && !item.ixml).length,
    errors: after.filter(item => item.error).length,
  },
  changed: changes.filter(item => item.changed).length,
  errors,
  changedFiles: changes
    .filter(item => item.changed)
    .map(item => ({
      file: path.relative(root, item.file),
      beforeIxmlSize: item.before.ixml.size,
      afterIxmlSize: item.after.ixml.size,
      beforeTimecodeRate: item.before.ixml.timecodeRate,
      afterTimecodeRate: item.after.ixml.timecodeRate,
      beforeTimecodeFlag: item.before.ixml.timecodeFlag,
      afterTimecodeFlag: item.after.ixml.timecodeFlag,
      beforeTimeReference: item.before.bext?.timeReference,
      afterTimeReference: item.after.bext?.timeReference,
    })),
};

if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
