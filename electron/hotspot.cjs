/**
 * Windows Mobile Hotspot for "Share to phone": turns this PC's Wi-Fi card into
 * a private access point so a phone can connect with no router and no internet.
 *
 * Talks to the WinRT tethering API directly through koffi (a C FFI), inside the
 * app: no PowerShell and no helper programs. Method slots and interface IDs
 * come from Windows' own metadata (C:\Windows\System32\WinMetadata).
 */

const koffi = require('koffi');
const os = require('os');

koffi.struct('IHP_GUID', { a: 'uint32', b: 'uint16', c: 'uint16', d: koffi.array('uint8', 8) });
const combase = koffi.load('combase.dll');
const RoInitialize = combase.func('int32 __stdcall RoInitialize(int32 type)');
const WindowsCreateString = combase.func('int32 __stdcall WindowsCreateString(const char16_t *s, uint32 len, _Out_ void **out)');
const WindowsGetStringRawBuffer = combase.func('const char16_t *__stdcall WindowsGetStringRawBuffer(void *h, _Out_ uint32 *len)');
const WindowsDeleteString = combase.func('int32 __stdcall WindowsDeleteString(void *h)');
const RoGetActivationFactory = combase.func('int32 __stdcall RoGetActivationFactory(void *cls, IHP_GUID *iid, _Out_ void **out)');

const P = {
  release: koffi.proto('uint32 __stdcall IhpRelease(void *self)'),
  qi: koffi.proto('int32 __stdcall IhpQI(void *self, IHP_GUID *iid, _Out_ void **out)'),
  ptr: koffi.proto('int32 __stdcall IhpGetPtr(void *self, _Out_ void **out)'),
  u32: koffi.proto('int32 __stdcall IhpGetU32(void *self, _Out_ uint32 *out)'),
  ptrArgPtr: koffi.proto('int32 __stdcall IhpPtrArgPtr(void *self, void *arg, _Out_ void **out)'),
  ptrArgU32: koffi.proto('int32 __stdcall IhpPtrArgU32(void *self, void *arg, _Out_ uint32 *out)'),
  getAt: koffi.proto('int32 __stdcall IhpGetAt(void *self, uint32 index, _Out_ void **out)'),
};

function guid(s) {
  const h = s.replace(/-/g, '');
  const d = [];
  for (let i = 16; i < 32; i += 2) d.push(parseInt(h.slice(i, i + 2), 16));
  return { a: parseInt(h.slice(0, 8), 16), b: parseInt(h.slice(8, 12), 16), c: parseInt(h.slice(12, 16), 16), d };
}

const IID = {
  networkInformationStatics: guid('5074f851-950d-4165-9c15-365619481eea'),
  tetheringStatics2: guid('5b235412-35f0-49e7-9b08-16d278fbaa42'),
  asyncInfo: guid('00000036-0000-0000-c000-000000000046'),
};

function check(hr, what) {
  if (hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`);
}

// Calls COM method `slot` of `obj` (0-2 IUnknown, 3-5 IInspectable, 6+ the interface's own).
function call(obj, slot, proto, ...args) {
  const vtbl = koffi.decode(obj, 'void *');
  return koffi.call(koffi.decode(vtbl, slot * 8, 'void *'), proto, obj, ...args);
}
function get(obj, slot, proto, what, ...args) {
  const out = [null];
  check(call(obj, slot, proto, ...args, out), what);
  return out[0];
}
const release = (obj) => obj && call(obj, 2, P.release);

function hstring(s) {
  const out = [null];
  check(WindowsCreateString(s, s.length, out), 'WindowsCreateString');
  return out[0];
}
function readHstring(h) {
  if (!h) return '';
  const len = [0];
  const s = WindowsGetStringRawBuffer(h, len);
  WindowsDeleteString(h);
  return s ?? '';
}

let ready = false;
function factory(cls, iid) {
  if (!ready) {
    RoInitialize(1); // MTA; harmless if this thread already has an apartment
    ready = true;
  }
  const name = hstring(cls);
  try {
    const out = [null];
    check(RoGetActivationFactory(name, iid, out), `Opening ${cls}`);
    return out[0];
  } finally {
    WindowsDeleteString(name);
  }
}

// Waits for an IAsyncOperation<T> and returns its result (slot 8 = GetResults).
async function awaitOperation(op, what) {
  const info = get(op, 0, P.qi, what, IID.asyncInfo);
  try {
    for (;;) {
      const status = get(info, 7, P.u32, what); // Started 0, Completed 1, Canceled 2, Error 3
      if (status === 1) break;
      if (status !== 0) throw new Error(`${what} didn’t finish`);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    release(info);
  }
  return get(op, 8, P.ptr, what);
}

const CAPABILITY = ['Enabled', 'turned off by your organization', 'not supported by this PC’s Wi-Fi card', 'turned off by the network operator', 'not available in this edition of Windows', 'missing a required app', 'unavailable', 'not supported by this PC'];
const START_ERRORS = {
  2: 'Mobile broadband is off.',
  3: 'Wi-Fi is off on this PC. Turn Wi-Fi on (it doesn’t need to be connected to anything) and try again.',
  6: 'Windows is already changing the hotspot. Try again in a moment.',
  7: 'Bluetooth is off.',
  8: 'Windows won’t start a hotspot while this PC’s network has limited connectivity. Plug in a network cable or connect to any network, even one without internet, and try again.',
};

let manager = null;
let startedByUs = false;

/** Creates the tethering manager for the best connection this PC has (internet or not). */
function openManager() {
  if (manager) return manager;
  const netInfo = factory('Windows.Networking.Connectivity.NetworkInformation', IID.networkInformationStatics);
  const statics = factory('Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager', IID.tetheringStatics2);
  try {
    const candidates = [];
    const internet = get(netInfo, 7, P.ptr, 'Reading network connections');
    if (internet) candidates.push(internet);
    const list = get(netInfo, 6, P.ptr, 'Reading network connections');
    const count = get(list, 7, P.u32, 'Reading network connections');
    for (let i = 0; i < count; i++) candidates.push(get(list, 6, P.getAt, 'Reading network connections', i));
    release(list);
    let lastReason = 'This PC has no network connection Windows can share a hotspot from.';
    for (const profile of candidates) {
      if (!manager) {
        const capability = get(statics, 6, P.ptrArgU32, 'Checking hotspot support', profile);
        if (capability === 0) {
          try {
            manager = get(statics, 7, P.ptrArgPtr, 'Opening the hotspot', profile);
          } catch (e) {
            lastReason = e.message;
          }
        } else lastReason = `Mobile hotspot is ${CAPABILITY[capability] ?? 'unavailable'}.`;
      }
      release(profile);
    }
    if (!manager) throw new Error(lastReason);
    return manager;
  } finally {
    release(statics);
    release(netInfo);
  }
}

/** Hotspot name and password (Windows' own settings), and whether it's on. */
function status() {
  const m = openManager();
  const config = get(m, 9, P.ptr, 'Reading hotspot settings');
  try {
    return {
      ssid: readHstring(get(config, 6, P.ptr, 'Reading hotspot name')),
      password: readHstring(get(config, 8, P.ptr, 'Reading hotspot password')),
      on: get(m, 8, P.u32, 'Reading hotspot state') === 1,
    };
  } finally {
    release(config);
  }
}

async function runOperation(slot, what) {
  const m = openManager();
  const op = get(m, slot, P.ptr, what);
  try {
    const result = await awaitOperation(op, what);
    try {
      const code = get(result, 6, P.u32, what);
      if (code !== 0) throw new Error(START_ERRORS[code] ?? `${what} failed (status ${code}).`);
    } finally {
      release(result);
    }
  } finally {
    release(op);
  }
}

/** Turns the hotspot on (if it isn't) and resolves once this PC has its hotspot address. */
async function start() {
  const s = status();
  if (!s.on) {
    await runOperation(11, 'Starting the hotspot');
    startedByUs = true;
  }
  // Windows gives the hotspot adapter 192.168.137.1 (Internet Connection Sharing).
  for (let i = 0; i < 50; i++) {
    const address = hotspotAddress();
    if (address) return { ...status(), address };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The hotspot started but Windows didn’t give it an address. Try again.');
}

function hotspotAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && a.address.startsWith('192.168.137.')) return a.address;
  }
  return null;
}

/** Turns the hotspot off again, but only if this app turned it on. */
async function stop() {
  if (!startedByUs) return;
  startedByUs = false;
  try {
    await runOperation(12, 'Stopping the hotspot');
  } catch {
    // best effort
  }
}

module.exports = { status, start, stop };
