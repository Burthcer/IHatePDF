/**
 * "Share to phone" over Bluetooth: finds nearby phones and sends a file with
 * OBEX Object Push, the protocol Android uses for "receive via Bluetooth".
 *
 * Calls Windows' own Bluetooth (bthprops) and Winsock (ws2_32) directly through
 * koffi, inside the app: no PowerShell, no compiled helpers, no network (Windows
 * Firewall doesn't filter Bluetooth). Blocking calls run on koffi's worker
 * threads via `.async`.
 */

const fs = require('fs');
const koffi = require('koffi');

const bthprops = koffi.load('bthprops.cpl');
const ws2 = koffi.load('ws2_32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RadioParams = koffi.struct('IHP_BT_RADIO_PARAMS', { dwSize: 'uint32' });
const SearchParams = koffi.struct('IHP_BT_SEARCH_PARAMS', {
  dwSize: 'uint32',
  fReturnAuthenticated: 'int32',
  fReturnRemembered: 'int32',
  fReturnUnknown: 'int32',
  fReturnConnected: 'int32',
  fIssueInquiry: 'int32',
  cTimeoutMultiplier: 'uint8',
  hRadio: 'void *',
});
const SystemTime = koffi.struct('IHP_SYSTEMTIME', { y: 'uint16', mo: 'uint16', dow: 'uint16', d: 'uint16', h: 'uint16', mi: 'uint16', s: 'uint16', ms: 'uint16' });
const DeviceInfo = koffi.struct('IHP_BT_DEVICE_INFO', {
  dwSize: 'uint32',
  address: 'uint64',
  classOfDevice: 'uint32',
  fConnected: 'int32',
  fRemembered: 'int32',
  fAuthenticated: 'int32',
  lastSeen: SystemTime,
  lastUsed: SystemTime,
  name: koffi.array('char16_t', 248, 'String'),
});

const BluetoothFindFirstRadio = bthprops.func('void *__stdcall BluetoothFindFirstRadio(IHP_BT_RADIO_PARAMS *p, _Out_ void **radio)');
const BluetoothFindRadioClose = bthprops.func('int32 __stdcall BluetoothFindRadioClose(void *find)');
const BluetoothFindFirstDevice = bthprops.func('void *__stdcall BluetoothFindFirstDevice(IHP_BT_SEARCH_PARAMS *p, _Inout_ IHP_BT_DEVICE_INFO *info)');
const BluetoothFindNextDevice = bthprops.func('int32 __stdcall BluetoothFindNextDevice(void *find, _Inout_ IHP_BT_DEVICE_INFO *info)');
const BluetoothFindDeviceClose = bthprops.func('int32 __stdcall BluetoothFindDeviceClose(void *find)');
const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(void *h)');

const WSAStartup = ws2.func('int32 __stdcall WSAStartup(uint16 version, _Out_ uint8 *data)');
const socket = ws2.func('uintptr_t __stdcall socket(int32 af, int32 type, int32 protocol)');
const connect = ws2.func('int32 __stdcall connect(uintptr_t s, const uint8 *addr, int32 len)');
const send = ws2.func('int32 __stdcall send(uintptr_t s, const uint8 *buf, int32 len, int32 flags)');
const recv = ws2.func('int32 __stdcall recv(uintptr_t s, _Out_ uint8 *buf, int32 len, int32 flags)');
const closesocket = ws2.func('int32 __stdcall closesocket(uintptr_t s)');
const WSAGetLastError = ws2.func('int32 __stdcall WSAGetLastError()');

const AF_BTH = 32;
const BTHPROTO_RFCOMM = 3;
const INVALID_SOCKET = 2n ** 64n - 1n;
const OBJECT_PUSH = '00001105-0000-1000-8000-00805f9b34fb';

let wsaReady = false;
let current = null; // { sock, cancelled }
let scanning = null; // an inquiry in progress blocks connections, so sending waits for it

const promisify = (fn) => (...args) => new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))));
const findFirstDeviceAsync = promisify(BluetoothFindFirstDevice);
const connectAsync = promisify(connect);
const sendAsync = promisify(send);
const recvAsync = promisify(recv);

/** "On", or "Off" when Windows reports no working Bluetooth radio (switched off or missing). */
function radioState() {
  const radio = [null];
  const find = BluetoothFindFirstRadio({ dwSize: koffi.sizeof(RadioParams) }, radio);
  if (!find) return 'Off';
  CloseHandle(radio[0]);
  BluetoothFindRadioClose(find);
  return 'On';
}

const isPhone = (d) => ((d.classOfDevice >> 8) & 0x1f) === 2; // major device class 2 = phone

/**
 * Looks for phones in range (~8 s Bluetooth inquiry). Android phones answer only
 * while their Bluetooth settings screen is open. Nothing is listed until found.
 */
async function scan() {
  if (process.platform !== 'win32') return { radio: 'Off', devices: [] };
  const radio = radioState();
  if (radio !== 'On') return { radio, devices: [] };
  const started = Date.now();
  const params = { dwSize: koffi.sizeof(SearchParams), fReturnAuthenticated: 1, fReturnRemembered: 0, fReturnUnknown: 1, fReturnConnected: 0, fIssueInquiry: 1, cTimeoutMultiplier: 6, hRadio: null };
  const info = { dwSize: koffi.sizeof(DeviceInfo) };
  const devices = [];
  scanning = findFirstDeviceAsync(params, info);
  const find = await scanning.finally(() => (scanning = null));
  if (find) {
    do {
      // Paired phones are always listed by Windows; keep them only if this scan actually saw them.
      const seen = info.lastSeen.y ? Date.UTC(info.lastSeen.y, info.lastSeen.mo - 1, info.lastSeen.d, info.lastSeen.h, info.lastSeen.mi, info.lastSeen.s) : 0;
      const fresh = !info.fAuthenticated || Math.abs(seen - started) < 120_000 || Math.abs(seen + new Date().getTimezoneOffset() * 60_000 - started) < 120_000;
      if (isPhone(info) && fresh && !devices.some((d) => d.id === String(info.address))) {
        devices.push({ id: String(info.address), name: info.name || BigInt(info.address).toString(16).toUpperCase().padStart(12, '0'), paired: !!info.fAuthenticated });
      }
      info.dwSize = koffi.sizeof(DeviceInfo);
    } while (BluetoothFindNextDevice(find, info));
    BluetoothFindDeviceClose(find);
  }
  return { radio, devices };
}

// ---- OBEX Object Push over an RFCOMM socket ----

function sockaddr(address) {
  const b = Buffer.alloc(30);
  b.writeUInt16LE(AF_BTH, 0);
  b.writeBigUInt64LE(BigInt(address), 2);
  const h = OBJECT_PUSH.replace(/-/g, '');
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 10);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 14);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 16);
  Buffer.from(h.slice(16), 'hex').copy(b, 18);
  return b; // port 0: Windows looks up the phone's Object Push channel
}

class Link {
  constructor(sock) {
    this.sock = sock;
  }
  async write(buf) {
    for (let off = 0; off < buf.length; ) {
      const n = await sendAsync(this.sock, buf.subarray(off), buf.length - off, 0);
      if (n <= 0) throw new Error('The connection to the phone was lost.');
      off += n;
    }
  }
  async read(n) {
    const out = Buffer.alloc(n);
    for (let got = 0; got < n; ) {
      const chunk = Buffer.alloc(n - got);
      const r = await recvAsync(this.sock, chunk, chunk.length, 0);
      if (r <= 0) throw new Error('The phone closed the connection.');
      chunk.copy(out, got, 0, r);
      got += r;
    }
    return out;
  }
  /** Sends one OBEX packet; returns { code, data }. */
  async packet(opcode, body) {
    const head = Buffer.alloc(3);
    head[0] = opcode;
    head.writeUInt16BE(3 + body.length, 1);
    await this.write(Buffer.concat([head, body]));
    const h = await this.read(3);
    const len = h.readUInt16BE(1);
    return { code: h[0], data: len > 3 ? await this.read(len - 3) : Buffer.alloc(0) };
  }
}

// Text/byte-sequence header: id, 2-byte length, value.
function header(id, value) {
  const h = Buffer.alloc(3);
  h[0] = id;
  h.writeUInt16BE(3 + value.length, 1);
  return Buffer.concat([h, value]);
}

function expect({ code }, wanted) {
  if (code === wanted) return;
  if (code === 0xc1 || code === 0xc3) throw new Error('The phone declined the file.');
  if (code === 0xcf) throw new Error('The phone doesn’t accept this type of file over Bluetooth.');
  if (code === 0xcd || code === 0xd3) throw new Error('The phone doesn’t have room for this file.');
  throw new Error(`The phone stopped the transfer (code 0x${code.toString(16)}).`);
}

function utf16be(s) {
  const b = Buffer.from(`${s}\0`, 'utf16le');
  b.swap16();
  return b;
}

const MIME = { '.zip': 'application/zip', '.pdf': 'application/pdf', '.txt': 'text/plain', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

/**
 * Sends one file (`filePath`, shown on the phone as `name`) to the phone at `address`.
 * onEvent gets { type: 'connecting' | 'waiting' | 'progress', sent, size }.
 */
async function sendFile(address, filePath, name, onEvent) {
  if (radioState() !== 'On') throw new Error('Bluetooth is off on this PC. Turn it on and try again.');
  const size = fs.statSync(filePath).size;
  if (size >= 2 ** 32) throw new Error('Bluetooth can’t send more than 4 GB at once. Use Same Wi-Fi or PC hotspot instead.');
  if (!wsaReady) {
    WSAStartup(0x0202, Buffer.alloc(512));
    wsaReady = true;
  }
  cancel();
  onEvent({ type: 'connecting' });
  if (scanning) await scanning.catch(() => undefined);

  let link = null;
  const job = { sock: null, cancelled: false };
  current = job;
  try {
    // A sleeping phone often misses the first page; try a few times.
    for (let attempt = 1; ; attempt++) {
      const sock = socket(AF_BTH, 1, BTHPROTO_RFCOMM);
      if (BigInt(sock) === INVALID_SOCKET) throw new Error('Windows couldn’t open a Bluetooth connection.');
      job.sock = sock;
      const addr = sockaddr(address);
      if ((await connectAsync(sock, addr, addr.length)) === 0) break;
      const err = WSAGetLastError();
      closesocket(sock);
      job.sock = null;
      if (job.cancelled) throw new Error('Sending was cancelled.');
      if (attempt === 3) throw new Error(`Couldn’t reach the phone. Make sure its Bluetooth is on and it’s nearby (error ${err}).`);
    }
    link = new Link(job.sock);

    // CONNECT: OBEX 1.0, no flags, max packet 0xFFFE.
    const hello = await link.packet(0x80, Buffer.from([0x10, 0x00, 0xff, 0xfe]));
    expect(hello, 0xa0);
    const max = Math.min(0xfffe, hello.data.length >= 4 ? hello.data.readUInt16BE(2) : 0xff);
    const chunkSize = max - 6;

    // Name, Length (4-byte header, no length prefix) and type.
    const length = Buffer.alloc(5);
    length[0] = 0xc3;
    length.writeUInt32BE(size, 1);
    const parts = [header(0x01, utf16be(name)), length];
    const mime = MIME[require('path').extname(name).toLowerCase()];
    if (mime) parts.push(header(0x42, Buffer.from(`${mime}\0`, 'ascii')));
    onEvent({ type: 'waiting', sent: 0, size });
    expect(await link.packet(0x02, Buffer.concat(parts)), 0x90);

    let sent = 0;
    let last = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(chunkSize);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, chunkSize, sent);
        const body = Buffer.from(buf.subarray(0, n));
        if (sent + n >= size) {
          expect(await link.packet(0x82, header(0x49, body)), 0xa0);
          break;
        }
        expect(await link.packet(0x02, header(0x48, body)), 0x90);
        sent += n;
        if (Date.now() - last > 250) {
          onEvent({ type: 'progress', sent, size });
          last = Date.now();
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    onEvent({ type: 'progress', sent: size, size });
    await link.packet(0x81, Buffer.alloc(0)).catch(() => undefined);
  } catch (e) {
    if (job.cancelled) throw new Error('Sending was cancelled.');
    throw e;
  } finally {
    if (job.sock !== null) closesocket(job.sock);
    job.sock = null;
    if (current === job) current = null;
  }
}

/** Stops a transfer in progress (closing the socket ends any blocked call). */
function cancel() {
  if (!current) return;
  current.cancelled = true;
  if (current.sock !== null) closesocket(current.sock);
  current.sock = null;
}

module.exports = { scan, sendFile, cancel, radioState };
