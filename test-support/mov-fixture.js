// Minimal MOV with PCM and optional tmcd tracks, parsed through the real reader.
function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function words(...values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}

function atom(type, ...parts) {
  const data = concat(...parts);
  return concat(words(data.length + 8), new TextEncoder().encode(type), data);
}

function track(type, description, offset, size, count, rate) {
  const handler = new Uint8Array(32);
  handler.set(new TextEncoder().encode(type), 8);
  return atom("trak", atom("mdia",
    atom("mdhd", words(0, 0, 0, rate, count)),
    atom("hdlr", handler),
    atom("minf", atom("stbl",
      atom("stsd", words(0, 1), description),
      atom("stsz", words(0, size, count)),
      atom("stsc", words(0, 1, 1, count, 1)),
      atom("stco", words(0, 1, offset)),
    )),
  ));
}

export function movBytes({ timecode = true } = {}) {
  const pcm = new Uint8Array(128);
  const pcmView = new DataView(pcm.buffer);
  for (let i = 0; i < 64; i++) pcmView.setInt16(i * 2, i * 256, true);
  const audio = new Uint8Array(28);
  const audioView = new DataView(audio.buffer);
  audioView.setUint16(16, 1); // channels
  audioView.setUint16(18, 16);
  audioView.setUint32(24, 48000 * 65536);
  const tc = new Uint8Array(28);
  const tcView = new DataView(tc.buffer);
  tcView.setUint32(16, 25);
  tcView.setUint32(20, 1);
  tc[24] = 25;
  const tracks = [track("soun", atom("sowt", audio), 12, 2, 64, 48000)];
  if (timecode) tracks.push(track("tmcd", atom("tmcd", tc), 8, 4, 1, 25));
  return concat(atom("mdat", words(3600 * 25), pcm), atom("moov", ...tracks));
}
