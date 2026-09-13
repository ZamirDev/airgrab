// netid.js — auto-room key for the "same network" handshake.
//
// Every device on the same WiFi shares the same public IP, so we hash that IP
// into a room name. Both sides of AirGrab derive the SAME room on load — no
// code, no QR, no typing: laptop and phone just land in the same room and the
// presence roster does the rest.
//
// Honest scope: "same network" == "same public IP". Anyone else on the WiFi
// could theoretically join the room. Fine for a demo; a QR handshake could
// tighten it later.

export async function detectNetworkRoom() {
  const hashRoom = async (seed) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('airgrab:' + seed));
    const hex = [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'ag-' + hex;
  };
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('ipify status ' + r.status);
    const ip = (await r.text()).trim();
    if (!ip) throw new Error('empty ip');
    return { room: await hashRoom(ip), label: ip, source: 'public-ip' };
  } catch {
    // offline / blocked: still provide a room (legacy BroadcastChannel keeps
    // the same-PC demo alive; a relay will simply not be reachable)
    return { room: 'ag-offline', label: 'offline (same-PC tabs)', source: 'fallback' };
  }
}

export function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host;
}