// transfer.js — AirGrab transfer protocol + transports.
//
// One message protocol, two transports behind the same shape:
//   { open(side,{onMessage}), send(msg), close() }
//
//   broadcast -> BroadcastChannel (offline, same-browser tabs)     [step 3]
//   relay     -> WebSocket auto-room (same WiFi, phone <-> laptop) [step 5]
//
// Message protocol (JSON envelope; chunk data is an ArrayBuffer):
//   {t:'hello', side, id, camera}    side: 'sender'|'receiver'
//   {t:'armed', ready, id, camera}   receiver confirms it can take a drop
//   {t:'holding', id, name, mime, size, preview, previewMime}
//        sender announces a grab is in flight (+ thumbnail so the laptop can
//        float the real photo ghost before the bytes arrive). id must match the
//        later transfer id (the sender stamps it on payload._id).
//   {t:'drop', forId}                receiver: "open fist sensed here -> send it"
//   {t:'nothing-held', forId}        sender: "no grab in flight, drop ignored"
//   {t:'transfer-start', id, name, mime, size, parts}
//   {t:'transfer-chunk', id, i, data}
//   {t:'transfer-end', id}
//   {t:'ack', id}                    sender waits for this before 'delivered'
//   {t:'error', message}

export const MAX_CHUNK = 16384;          // 16KB — comfortably under RTC data-channel limits

// —— pure chunk helpers (node-testable) ----------------------------------

export function splitToChunks(data, chunkBytes = MAX_CHUNK) {
  const parts = [];
  if (!data) return parts;
  const view = new Uint8Array(data);
  for (let i = 0; i < view.length; i += chunkBytes) {
    const slice = view.subarray(i, Math.min(i + chunkBytes, view.length));
    const copy = new Uint8Array(slice.length);
    copy.set(slice);
    parts.push(copy.buffer);
  }
  return parts;
}

export function joinChunks(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}

export function newTransferId() {
  return 'xfer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// —— transport messengers -------------------------------------------------

export function startMsg(id, { name, mime, size }, parts) {
  return { t: 'transfer-start', id, name, mime, size, parts };
}
export function chunkMsgs(id, data) {
  return splitToChunks(data).map((chunk, i) => ({ t: 'transfer-chunk', id, i, data: chunk }));
}

export function holdingMsg(payload, preview, previewMime = 'image/jpeg') {
  return { t: 'holding', id: payload._id, name: payload.name, mime: payload.mime, size: payload.size, preview, previewMime };
}
export function dropMsg(forId) {
  return { t: 'drop', forId };
}
export function nothingHeldMsg(forId) {
  return { t: 'nothing-held', forId };
}
export function ackMsg(id) {
  return { t: 'ack', id };
}

// —— BroadcastChannel transport (offline, same-origin tabs) --------------

export function createBroadcastTransport(name = 'airgrab-demo') {
  let ch = null;
  return {
    kind: 'broadcast',
    name,
    open(side, { onMessage } = {}) {
      ch = new BroadcastChannel(name);
      ch.onmessage = (e) => onMessage?.(e.data);
      return Promise.resolve({ ok: true });
    },
    send(msg) {
      if (!ch) throw new Error('transport not open');
      ch.postMessage(msg);
      return Promise.resolve();
    },
    close() {
      ch?.close();
      ch = null;
    },
  };
}

// —— Relay transport (phone <-> laptop over the auto-room WebSocket) ---
//
// Same {open(side), send(msg), close()} shape as the broadcast transport, so
// one app drives both. Chunk data rides as base64 inside JSON frames — ordered
// + reliable over TCP (exactly why this never flaked like WebRTC/NAT), decoded
// back to ArrayBuffer before the state machines ever see it.

export function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}

export function b64ToBytes(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function encodeForWire(msg) {
  if (msg && msg.data instanceof ArrayBuffer) {
    const { data, ...rest } = msg;
    return { ...rest, dataB64: bytesToB64(data) };
  }
  return msg;
}

export function decodeFromWire(msg) {
  if (msg && typeof msg.dataB64 === 'string') {
    const { dataB64, ...rest } = msg;
    return { ...rest, data: b64ToBytes(dataB64) };
  }
  return msg;
}

export function createRelayTransport({ url, room }) {
  let ws = null;
  let onMessage = null;
  const queue = [];
  const id = 'c-' + Math.random().toString(36).slice(2, 10);

  return {
    kind: 'relay',
    open(side, { onMessage: cb } = {}) {
      onMessage = cb || null;
      return new Promise((resolve, reject) => {
        try {
          ws = new WebSocket(url);
        } catch (e) {
          reject(e);
          return;
        }
        ws.onopen = () => {
          ws.send(JSON.stringify({ t: 'join', room, id, role: side }));
          while (queue.length) ws.send(JSON.stringify(queue.shift()));
          resolve({ ok: true });
        };
        ws.onerror = () => reject(new Error('relay: cannot reach ' + url));
        ws.onmessage = (ev) => {
          if (!onMessage) return;
          let frame;
          try { frame = JSON.parse(ev.data); } catch { return; }
          if (frame.t === 'msg') onMessage(decodeFromWire(frame.data));
          else if (frame.t === 'roster' || frame.t === 'peer' || frame.t === 'peer-left') {
            onMessage({ t: 'relay-roster', peers: frame.peers || [] });
          }
        };
        ws.onclose = () => onMessage?.({ t: 'relay-closed' });
      });
    },
    send(msg) {
      const frame = { t: 'msg', data: encodeForWire(msg) };
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      else queue.push(frame);
    },
    close() {
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
}