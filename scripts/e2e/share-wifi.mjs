// Installed app: Share to phone, Wi-Fi mode. Starts a share through the bridge, downloads from it like a phone would
// (from Node, on the LAN address), checks the page, a file, a folder zip and a wrong token, then stops it.
// Usage: E2E_CDP=http://127.0.0.1:9333 node scripts/e2e/share-wifi.mjs
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP(process.env.E2E_CDP ?? 'http://127.0.0.1:9333');
const p = b.contexts()[0].pages()[0];
await p.goto('http://tauri.localhost/#/share'); await p.waitForLoadState('networkidle');
const paths = ['C:/Users/Asus/Desktop/Ihatepdf local/test-fixtures/test-multi.pdf', 'C:/Users/Asus/Desktop/Ihatepdf local/test-fixtures/misc'];
const { items, info } = await p.evaluate(async (paths) => {
  const d = window.ihpDesktop.share;
  const items = await d.describe(paths);
  return { items, info: await d.start(items.map((i) => i.path), 2, 'wifi') };
}, paths);
const base = info.urls[0].url;
const html = await (await fetch(base)).text();
const f0 = await fetch(base + 'f/0'); const n0 = (await f0.arrayBuffer()).byteLength;
const f1 = await fetch(base + 'f/1'); const n1 = (await f1.arrayBuffer()).byteLength;
const bad = (await fetch(base.replace(/[0-9a-f]{32}/, 'x'))).status;
const ended = await p.evaluate(() => new Promise((res) => { window.ihpDesktop.share.onEnded(res); window.ihpDesktop.share.stop(); setTimeout(() => res('timeout'), 4000); }));
const ok = html.includes('test-multi.pdf') && n0 > 1000 && f1.headers.get('content-type') === 'application/zip' && n1 > 100 && bad === 404 && ended === 'stopped';
console.log(ok ? 'PASS' : 'FAIL', JSON.stringify({ items: items.map((i) => [i.name, i.isDir, i.size, i.count]), url: base, pdfBytes: n0, zipBytes: n1, wrongTokenStatus: bad, ended }));
await b.close(); process.exit(ok ? 0 : 1);
