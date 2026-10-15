function concat(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text) {
  return Uint8Array.from(text, char => char.charCodeAt(0));
}

function chunk(id, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(ascii(id), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function fmtChunk() {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 48000, true);
  view.setUint32(8, 96000, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, 16, true);
  return chunk("fmt ", data);
}

function dataChunk(samples = 64) {
  const payload = new Uint8Array(samples * 2);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;
  return chunk("data", payload);
}

function bextChunk(timeReference = 0n) {
  const data = new Uint8Array(602);
  const view = new DataView(data.buffer);
  view.setBigUint64(338, timeReference, true);
  view.setUint16(346, 1, true);
  return chunk("bext", data);
}

function ixmlChunk(timeReference = 0n) {
  const lo = timeReference.toString().padStart(10, "0");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><BWFXML><SPEED><TIMESTAMP_SAMPLE_RATE>48000</TIMESTAMP_SAMPLE_RATE><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>0</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>${lo}</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO></SPEED></BWFXML>`;
  return chunk("iXML", ascii(xml));
}

export function wavBytes({ bext = false, ixml = false, timeReference = 0n, samples = 64 } = {}) {
  const chunks = [fmtChunk()];
  if (bext) chunks.push(bextChunk(timeReference));
  if (ixml) chunks.push(ixmlChunk(timeReference));
  chunks.push(dataChunk(samples));
  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(ascii("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length + 4, true);
  out.set(ascii("WAVE"), 8);
  out.set(body, 12);
  return out;
}

export function memoryWavHandle(bytes, name, hooks = {}) {
  let committed = Uint8Array.from(bytes);
  const calls = [];
  return {
    name,
    calls,
    bytes: () => committed.slice(),
    async getFile() {
      return new File([committed.slice()], name);
    },
    async createWritable(options = {}) {
      if (hooks.onCreateWritable) hooks.onCreateWritable();
      const keepExisting = options.keepExistingData !== false;
      let scratch = keepExisting ? committed.slice() : new Uint8Array(0);
      let writes = 0;
      return {
        async write(op) {
          writes += 1;
          calls.push("write");
          if (hooks.failOnWrite && writes === hooks.failOnWrite) {
            throw new Error("injected write failure");
          }
          const data = op.data instanceof Uint8Array ? op.data : new Uint8Array(op.data);
          const position = op.position ?? scratch.length;
          const end = position + data.length;
          if (scratch.length < end) {
            const next = new Uint8Array(end);
            next.set(scratch);
            scratch = next;
          }
          scratch.set(data, position);
        },
        async truncate(size) {
          calls.push("truncate");
          if (hooks.failOnTruncate) throw new Error("injected truncate failure");
          if (size > scratch.length) {
            const next = new Uint8Array(size);
            next.set(scratch);
            scratch = next;
          } else {
            scratch = scratch.slice(0, size);
          }
        },
        async close() {
          calls.push("close");
          committed = scratch.slice();
        },
        async abort() {
          calls.push("abort");
        },
      };
    },
  };
}
