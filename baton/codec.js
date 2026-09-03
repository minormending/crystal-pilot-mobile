// Getting bytes through a channel that only carries text.
//
// kidsync's room holds one JSON string, and its rules cap it at 32,768
// characters. A Game Boy battery save is 32,768 *bytes*, so the arithmetic is
// the whole reason this file exists:
//
//     raw as base64        43,692 chars   over the cap, always
//     raw as a JSON array  67,088 chars   far worse
//     gzip then base64      1,200 chars   measured, on a real early save
//
// Compression is therefore not an optimisation here, it is the only way the
// payload fits at all -- and it is not guaranteed to fit, which is why `fits`
// exists and why every caller has to handle a no. A save is mostly fixed-layout
// records with long runs of zeroes, so in practice it shrinks by a factor of
// ten or more; an incompressible payload of the same size cannot go through,
// and saying so plainly beats a write that is silently dropped.

/** Chunked, because String.fromCharCode(...bytes) with a big array overflows
 *  the call stack -- an argument list is not a place to put a megabyte. */
function toBinaryString(bytes) {
  const CHUNK = 0x2000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function through(stream, bytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const done = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(done);
}

/** Bytes in, one line of text out. */
export async function pack(bytes) {
  const gz = await through(new CompressionStream('gzip'), bytes);
  return btoa(toBinaryString(gz));
}

/** And back. Throws on anything that is not what pack produced. */
export async function unpack(text) {
  const binary = atob(text);
  const gz = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) gz[i] = binary.charCodeAt(i);
  return through(new DecompressionStream('gzip'), gz);
}

/**
 * Would this packed payload fit, leaving room for everything else?
 *
 * `spare` is the rest of the room's state -- the options, the description, who
 * is holding it. The cap is on the whole JSON string, not on the payload, so a
 * payload that exactly fills it is a payload that cannot be published.
 */
export function fits(packed, maxBytes, spare = 2048) {
  return packed.length + spare <= maxBytes;
}
