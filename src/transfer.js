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
//
// On connection loss the transport reconnects automatically with capped
// exponential backoff (1 s → 10 s). On reconnect it re-joins the same room,
// drops the stale outbound queue, and emits a {t:'relay-reopen'} so pages
// can re-announce their presence + re-send holding. A {t:'relay-closed'} is
// emitted on first close, before the reconnect attempt starts.

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
  if (!msg || typeof msg !== 'object') return msg;
  const out = { ...msg };
  if (out.data instanceof ArrayBuffer) { out.dataB64 = bytesToB64(out.data); delete out.data; }
  if (out.preview instanceof ArrayBuffer) { out.previewB64 = bytesToB64(out.preview); delete out.preview; }
  return out;
}

export function decodeFromWire(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const out = { ...msg };
  if (typeof out.dataB64 === 'string') { out.data = b64ToBytes(out.dataB64); delete out.dataB64; }
  if (typeof out.previewB64 === 'string') { out.preview = b64ToBytes(out.previewB64); delete out.previewB64; }
  return out;
}

export function createRelayTransport({ url, room, reconnect = true }) {
  let ws = null;
  let onMessage = null;
  let closed = false;
  let side = 'sender';
  let attempt = 0;
  let hadOpen = false;
  let retryTimer = null;
  const queue = [];
  const id = 'c-' + Math.random().toString(36).slice(2, 10);

  const flush = () => { while (queue.length && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(queue.shift())); };
  const scheduleReconnect = () => {
    if (retryTimer || closed || !reconnect) return;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };

  function connect() {
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      attempt = 0;
      hadOpen = true;
      ws.send(JSON.stringify({ t: 'join', room, id, role: side }));
      flush();
      if (hadOpen) onMessage?.({ t: 'relay-reopen' });   // first open resolved via Promise; reopens go here
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (!onMessage) return;
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.t === 'msg') onMessage(decodeFromWire(frame.data));
      else if (frame.t === 'roster' || frame.t === 'peer' || frame.t === 'peer-left') {
        onMessage({ t: 'relay-roster', peers: frame.peers || [] });
      }
    };
    ws.onclose = () => {
      ws = null;
      queue.length = 0;                              // stale frames are dead — no silent queue
      if (!closed && hadOpen) onMessage?.({ t: 'relay-closed' });
      scheduleReconnect();
    };
  }

  return {
    kind: 'relay',
    id,
    get _ws() { return ws; },
    open(s, { onMessage: cb } = {}) {
      side = s;
      onMessage = cb || null;
      closed = false;
      return new Promise((resolve, reject) => {
        connect();
        let iv;
        const fail = setTimeout(() => { clearInterval(iv); reject(new Error('relay: open timeout')); }, 8000);
        iv = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(iv); clearTimeout(fail); resolve({ ok: true }); }
        }, 30);
      });
    },
    send(msg) {
      if (closed) return;
      const frame = { t: 'msg', data: encodeForWire(msg) };
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      else queue.push(frame);
    },
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
      queue.length = 0;
    },
  };
}