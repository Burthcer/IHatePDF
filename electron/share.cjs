/**
 * QR sharing for "Share to phone": a small download server on this PC.
 *
 * The QR code points the phone at http://<this PC>:<port>/<token>/, a page
 * listing what's shared. Files stream straight from disk and folders stream as
 * .zip, so there's no size limit. It works over any local link: the same
 * Wi-Fi/LAN, or this PC's own hotspot (hotspot.cjs) with no router or internet.
 * The share ends when time runs out, on stop(), or when the app quits.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createZip, collect } = require('./zip.cjs');

// Adapters a phone is unlikely to reach: listed last, still selectable.
const VIRTUAL = /vethernet|virtual|vmware|vbox|wsl|hyper-v|docker|loopback|bluetooth|npcap/i;
// Home/office Wi-Fi and Ethernet use these ranges; VPNs like Tailscale (100.x) don't.
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

let current = null; // { server, token, items, expiresAt, timer, onEnd }

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address, rank: VIRTUAL.test(name) ? 2 : PRIVATE.test(a.address) ? 0 : 1 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** What the user picked, as shown in the app and on the phone. */
function describe(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // gone since it was picked
    }
    if (st.isDirectory()) {
      const skipped = [];
      const files = collect([p], skipped).filter((e) => !e.dir);
      out.push({ path: p, name: path.basename(p), isDir: true, size: files.reduce((n, f) => n + f.size, 0), count: files.length, skipped });
    } else {
      out.push({ path: p, name: path.basename(p), isDir: false, size: st.size, count: 1, skipped: [] });
    }
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function size(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  for (; n >= 1024 && i < u.length - 1; i++) n /= 1024;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:16px system-ui,sans-serif;margin:0;padding:24px 16px;background:#f6f5f1;color:#1c1b19}
main{max-width:520px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:#6b6962;margin:0 0 20px;font-size:14px}
a.f{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 16px;margin-bottom:10px;background:#fff;
border:1px solid #dddbd3;border-radius:8px;color:inherit;text-decoration:none}
a.f span{flex:1;min-width:0;overflow-wrap:anywhere}a.f small{color:#6b6962}a.f b{color:#c2410c;white-space:nowrap}
a.all{background:#c2410c;border-color:#c2410c;color:#fff}a.all b,a.all small{color:#fff}
</style></head><body><main>${body}</main></body></html>`;
}

const zipName = (item) => (item.isDir ? `${item.name}.zip` : item.name);

function listing(share) {
  const mins = Math.max(1, Math.ceil((share.expiresAt - Date.now()) / 60000));
  const total = share.items.reduce((n, i) => n + i.size, 0);
  const all =
    share.items.length > 1
      ? `<a class="f all" href="all.zip" download="IHatePDF files.zip"><span>Everything, as one .zip<br><small>${size(total)}</small></span><b>Download</b></a>`
      : '';
  const rows = share.items
    .map((it, i) => {
      const detail = it.isDir ? `Folder · ${it.count} file${it.count === 1 ? '' : 's'} · ${size(it.size)} · downloads as .zip` : size(it.size);
      return `<a class="f" href="f/${i}" download="${esc(zipName(it))}"><span>${esc(it.name)}<br><small>${detail}</small></span><b>Download</b></a>`;
    })
    .join('');
  const what = share.items.length === 1 ? (share.items[0].isDir ? 'this folder' : 'this file') : `these ${share.items.length} items`;
  return page('IHatePDF · Download', `<h1>Download ${what}</h1>
<p>Shared from IHatePDF on a nearby computer. This link stops working in about ${mins} minute${mins === 1 ? '' : 's'}.</p>${all}${rows}`);
}

function send(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendZip(req, res, paths, name) {
  let zip;
  try {
    zip = createZip(paths);
  } catch {
    return send(res, 404, page('Not found', '<h1>This folder is no longer on the computer</h1>'));
  }
  res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.size, 'content-disposition': attachment(name), 'cache-control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  zip.pipe(res).then(
    () => res.end(),
    () => res.destroy()
  );
}

function handle(share, req, res) {
  const parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, page('Not allowed', '<h1>Not allowed</h1>'));
  if (parts[0] !== share.token) return send(res, 404, page('Not found', '<h1>Link not found</h1><p>Scan the QR code on the computer again.</p>'));
  if (Date.now() >= share.expiresAt) return send(res, 410, page('Expired', '<h1>This share has expired</h1><p>Ask for a new QR code.</p>'));
  if (parts.length === 1) {
    // Relative links need the trailing slash.
    if (!req.url.split('?')[0].endsWith('/')) {
      res.writeHead(302, { location: `/${share.token}/` });
      return res.end();
    }
    return send(res, 200, listing(share));
  }
  if (parts[1] === 'all.zip' && parts.length === 2) return sendZip(req, res, share.items.map((i) => i.path), 'IHatePDF files.zip');
  const item = parts[1] === 'f' && parts.length === 3 ? share.items[Number(parts[2])] : null;
  if (!item) return send(res, 404, page('Not found', '<h1>File not found</h1>'));
  if (item.isDir) return sendZip(req, res, [item.path], zipName(item));
  fs.stat(item.path, (err, st) => {
    if (err) return send(res, 404, page('Not found', '<h1>This file is no longer on the computer</h1>'));
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': attachment(item.name), 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(item.path).on('error', () => res.destroy()).pipe(res);
  });
}

function schedule(share, minutes) {
  clearTimeout(share.timer);
  share.expiresAt = Date.now() + minutes * 60000;
  share.timer = setTimeout(() => stop('expired'), minutes * 60000);
}

/**
 * Starts sharing `paths` (files and folders) for `minutes`, replacing any current
 * share. `preferred` is an address to list first (the hotspot's).
 */
async function start(paths, minutes, onEnd, preferred) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Choose something to share first.');
  if (!(minutes > 0 && minutes <= 60)) throw new Error('Choose a time between 1 and 60 minutes.');
  const items = describe(paths);
  const addresses = lanAddresses();
  if (!addresses.length) throw new Error('This PC isn’t connected to any network. Use PC hotspot or Bluetooth instead.');
  stop('replaced');
  const share = { token: crypto.randomBytes(16).toString('hex'), items, onEnd };
  share.server = http.createServer((req, res) => {
    try {
      handle(share, req, res);
    } catch {
      send(res, 400, page('Bad request', '<h1>Bad request</h1>'));
    }
  });
  await new Promise((resolve, reject) => {
    share.server.once('error', reject);
    // Tests set IHP_SHARE_HOST=127.0.0.1 so they never trigger a Windows Firewall prompt.
    share.server.listen(0, process.env.IHP_SHARE_HOST || '0.0.0.0', resolve);
  });
  current = share;
  schedule(share, minutes);
  const { port } = share.server.address();
  const ordered = preferred ? [...addresses.filter((a) => a.address === preferred), ...addresses.filter((a) => a.address !== preferred)] : addresses;
  return {
    expiresAt: share.expiresAt,
    urls: ordered.map((a) => ({ name: a.address === preferred ? 'PC hotspot' : a.name, url: `http://${a.address}:${port}/${share.token}/` })),
  };
}

/** Restarts the countdown with a new length; returns the new expiry. */
function setMinutes(minutes) {
  if (!current || !(minutes > 0 && minutes <= 60)) return null;
  schedule(current, minutes);
  return current.expiresAt;
}

function stop(reason = 'stopped') {
  const share = current;
  if (!share) return;
  current = null;
  clearTimeout(share.timer);
  // Downloads already in progress finish; nothing new is accepted.
  share.server.close();
  share.server.closeIdleConnections?.();
  share.onEnd?.(reason);
}

module.exports = { start, setMinutes, stop, describe, lanAddresses };
