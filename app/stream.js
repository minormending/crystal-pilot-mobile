// Showing this device's screen to another of your own devices.
//
// The picture goes straight between the two machines over WebRTC and never
// touches a server: what the room carries is an introduction -- an offer and an
// answer, a few kilobytes each -- and this module never touches the room. The
// caller passes those two strings back and forth, the same way baton knows
// nothing about Firebase. That split is what makes both testable without one.
//
// One host, one watcher. The joypad rides back over a data channel on the same
// connection, so a device watching can also play, which is the point: it is one
// person with two devices, not an audience.
//
// What this cannot do is stream from a page nobody is looking at. Measured on
// a hidden page: the whole page is throttled to roughly one turn a second --
// timers clamped, animation frames absent -- so a hidden host produces about
// one frame a second whatever the capture rate says. The capture itself keeps
// working; the game behind it stops. So the host says when its screen goes
// away rather than sending a still picture and letting the other end wonder.

// The one external service in this app. Two devices on the same wifi do not
// need it -- their host candidates reach each other directly -- but two on
// different networks cannot find each other without at least a STUN server to
// tell them their own public address. Anything stricter than that needs a TURN
// relay, which is a server to run, and this app does not have one: across
// networks, this may simply not connect.
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// Long enough for host and STUN candidates on any sane network, short enough
// that a blocked STUN server costs a pause rather than a hang. Whatever has
// been gathered by then is what gets sent, and on a LAN that is already enough.
const GATHER_MS = 2500;

/** Wait for ICE to finish, or for long enough that waiting is not helping. */
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const send = (channel, msg) => {
  if (channel && channel.readyState === 'open') channel.send(JSON.stringify(msg));
};

/**
 * The device with the game.
 *
 * `onInput` receives whatever the watcher's joypad sends, plus one message the
 * watcher never sends: `{t:'gone'}` when the channel closes. That is the
 * safety release -- a held direction with nobody left to release it would walk
 * into a wall forever, which is the same reason the app releases everything on
 * window blur.
 */
export function createHost({ canvas, fps = 30, onInput = () => {}, onStatus = () => {} }) {
  let pc = null, channel = null, stream = null;

  function stop() {
    if (channel) { channel.onclose = null; channel.close(); channel = null; }
    if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }

  return {
    /** Capture the screen and produce an offer for whoever asked. */
    async offer() {
      stop();
      stream = canvas.captureStream(fps);
      pc = new RTCPeerConnection({ iceServers: ICE });
      for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
      // Created by this side rather than the watcher's, so the channel exists
      // before the answer comes back and there is no window where a button
      // press has nowhere to go.
      channel = pc.createDataChannel('joypad', { ordered: true });
      channel.onmessage = (e) => {
        try { onInput(JSON.parse(e.data)); } catch (err) { /* not ours */ }
      };
      channel.onclose = () => onInput({ t: 'gone' });
      pc.onconnectionstatechange = () => onStatus(pc.connectionState);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      return JSON.stringify(pc.localDescription);
    },

    /** Take the watcher's answer. After this the picture flows. */
    async accept(answer) {
      if (!pc) return false;
      await pc.setRemoteDescription(JSON.parse(answer));
      return true;
    },

    /** Say something to the watcher -- that the screen went away, say. */
    tell(msg) { send(channel, msg); },

    stop,
    get state() { return pc ? pc.connectionState : 'idle'; },
    /** For asking the connection whether frames are actually moving. */
    get connection() { return pc; },
  };
}

/**
 * The device without one.
 *
 * `onTell` receives the host's own messages; `onTrack` receives the picture,
 * once, as a MediaStream to hand to a <video>.
 */
export function createWatcher({ onTrack = () => {}, onTell = () => {}, onStatus = () => {} }) {
  let pc = null, channel = null;

  function stop() {
    if (channel) { channel.close(); channel = null; }
    if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  }

  return {
    /** Answer the host's offer. The picture starts arriving after this. */
    async answer(offer) {
      stop();
      pc = new RTCPeerConnection({ iceServers: ICE });
      pc.ontrack = (e) => onTrack(e.streams[0]);
      pc.ondatachannel = (e) => {
        channel = e.channel;
        channel.onmessage = (m) => {
          try { onTell(JSON.parse(m.data)); } catch (err) { /* not ours */ }
        };
      };
      pc.onconnectionstatechange = () => onStatus(pc.connectionState);
      await pc.setRemoteDescription(JSON.parse(offer));
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      return JSON.stringify(pc.localDescription);
    },

    /** A button, on its way to the machine that has the game. */
    press(msg) { send(channel, msg); },

    stop,
    get state() { return pc ? pc.connectionState : 'idle'; },
    get connection() { return pc; },
  };
}
