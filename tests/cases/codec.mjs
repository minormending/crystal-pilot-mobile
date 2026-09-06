// Getting a save through a channel that only carries text -- and what happens
// when what comes back is not what went out.
//
// This is the one place in the app where bytes arrive from *another machine*
// and are unpacked before anything can check them. The room's rules validate
// that the payload is a string under 32,768 characters; nothing can validate
// what is inside it. So the contract that matters here is a narrow one: unpack
// either returns the bytes or throws, and does nothing else.
import { test } from '../harness.mjs';
import { fits, pack, unpack } from '../../baton/codec.js';

/** Run `fn`, and report any unhandled rejection it leaves behind. */
async function watchingForStrays(fn) {
  const strays = [];
  const catcher = (e) => strays.push(e);
  process.on('unhandledRejection', catcher);
  try {
    await fn();
    // Unhandled rejections are reported a turn after they are abandoned, so a
    // synchronous check here would always find none.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', catcher);
  }
  return strays;
}

test('a save survives the round trip through text', async (t) => {
  const bytes = new Uint8Array(32768);
  // Not all zeroes: a battery is fixed-layout records, and a payload that
  // compresses perfectly would not tell us the bytes came back in order.
  for (let i = 0; i < bytes.length; i += 7) bytes[i] = (i * 31) & 0xff;
  const text = await pack(bytes);
  const back = await unpack(text);
  t.eq(back.length, bytes.length, 'the same number of bytes');
  t.true(bytes.every((b, i) => back[i] === b), 'and every one of them unchanged');
  t.true(/^[A-Za-z0-9+/=]+$/.test(text), 'as something a JSON string can hold');
});

test('a corrupt payload throws, and throws only once', async (t) => {
  // Five ways the text can be wrong, three of which used to raise a SECOND
  // failure the caller could not catch: `writer.write()` and `writer.close()`
  // return promises, and on a stream that errors those reject too. They were
  // dropped, so a corrupt save produced the caught error and an unhandled
  // rejection arriving a turn later with no stack pointing at this file.
  const real = await pack(new Uint8Array(32768));
  const bad = {
    'not base64 at all': '###',
    'base64 of something else': btoa('this is not gzip'),
    'nothing at all': '',
    'a truncated payload': real.slice(0, Math.floor(real.length / 2)),
    'a payload with junk after it': real + btoa('junk'),
  };

  const strays = await watchingForStrays(async () => {
    for (const [what, text] of Object.entries(bad)) {
      await t.rejects(async () => unpack(text), `${what} is refused`);
    }
  });
  t.eq(strays.length, 0,
       `no unhandled rejection escapes (got ${strays.length})`);
});

test('a payload that cannot fit is refused before it is written', async (t) => {
  // The cap is the room's, and it is on the whole JSON string rather than on
  // the payload -- so a payload that exactly fills it is one that cannot be
  // published beside the description and the holder.
  t.true(fits('x'.repeat(100), 32768, 2048), 'a small payload fits');
  t.false(fits('x'.repeat(31000), 32768, 2048), 'one that leaves no room does not');
  t.true(fits('x'.repeat(30720), 32768, 2048), 'and the largest that does, does');
  // The reserve is the whole mechanism: the same payload passes or fails on
  // what is being kept beside it, which is why `spare` is a parameter and not
  // a constant folded into the cap.
  t.true(fits('x'.repeat(32768), 32768, 0), 'with nothing reserved, an exact fill is allowed');
});
