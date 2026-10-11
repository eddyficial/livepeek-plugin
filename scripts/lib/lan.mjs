/**
 * The address a phone on the same Wi-Fi uses to reach a page this machine
 * serves, for the QR code. A dev server on localhost is only reachable from
 * the phone through this machine's LAN address, and only if the server
 * listens on more than loopback.
 */
import os from 'node:os';
import net from 'node:net';

// Virtual adapters (WSL, Hyper-V, Docker, VPNs) have addresses a phone on the
// Wi-Fi cannot reach; prefer them last, or not at all.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|^br-|^veth|^virbr|utun|tailscale|zerotier|wireguard|^wg\d|Loopback/i;

/** Rank a private IPv4 address: home routers hand out 192.168, offices 10 and 172.16-31. */
function rank(a) {
  if (a.startsWith('192.168.')) return 0;
  if (a.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
  return 3;
}

/** This machine's LAN IPv4 addresses, likeliest first. */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list || []) {
      const v4 = i.family === 'IPv4' || i.family === 4;
      if (!v4 || i.internal || i.address.startsWith('169.254.')) continue;
      found.push({ name, address: i.address });
    }
  }
  return found.sort((a, b) => rank(a.address) - rank(b.address));
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** href with a loopback host swapped for address; any other host is already reachable. */
export function phoneUrl(href, address) {
  const u = new URL(href);
  if (LOCAL.has(u.hostname)) u.hostname = address;
  return u.href;
}

/** Does host:port accept a connection? From this machine, so a firewall is not tested. */
export function reachable(host, port, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
