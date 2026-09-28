import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Bluetooth, FilePlus2, FileText, Folder, FolderPlus, Settings, Square, X } from 'lucide-react';
import { ToolHeader } from '../../components/layout/ToolLayout';
import { Button, Field, IconButton, Notice, Panel, ProgressLine, Segmented, Spinner, cn, formatBytes } from '../../components/ui';
import { getTool } from '../../constants/tools';

interface ShareViewProps {
  onBack: () => void;
}

type Mode = 'wifi' | 'hotspot' | 'bluetooth';

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'wifi', label: 'Same Wi-Fi' },
  { value: 'hotspot', label: 'PC hotspot (offline)' },
  { value: 'bluetooth', label: 'Bluetooth (offline)' },
];

const MODE_INFO: Record<Mode, { title: string; body: string }> = {
  wifi: {
    title: 'The phone and this PC are on the same Wi-Fi or network',
    body: 'Internet isn’t needed, just the same network. Scan the QR code with the phone’s camera and download. Works on any phone. No size limit.',
  },
  hotspot: {
    title: 'No Wi-Fi network needed: this PC makes its own',
    body: 'This PC’s Wi-Fi card becomes a private hotspot, with no router and no internet. Scan the first QR code to join it, then the second to download. Works on any phone. No size limit. Needs a PC with Wi-Fi.',
  },
  bluetooth: {
    title: 'No Wi-Fi at all: Bluetooth on both devices',
    body: 'Turn on Bluetooth on this PC and the phone, and open the phone’s Bluetooth settings screen so it can be found. Pick the phone below, then tap Accept on it. Android only; iPhones can’t receive files over Bluetooth. Slow, so large files take minutes; 4 GB at most. Several files or a folder arrive as one .zip.',
  },
};

const DURATIONS = [1, 5, 10].map((m) => ({ value: m, label: `${m} min` }));

const message = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Escapes a value for a WIFI: QR code (the format phone cameras understand).
const wifiEscape = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');

function useQr(text: string): string {
  const [qr, setQr] = useState({ text: '', data: '' });
  useEffect(() => {
    if (!text) return;
    let live = true;
    void QRCode.toDataURL(text, { margin: 2, width: 480, errorCorrectionLevel: 'M' }).then((data) => live && setQr({ text, data }));
    return () => {
      live = false;
    };
  }, [text]);
  return qr.text === text ? qr.data : '';
}

function QrCard({ step, title, text, children }: { step?: number; title: string; text: string; children?: React.ReactNode }) {
  const qr = useQr(text);
  return (
    <div className="space-y-2 min-w-0">
      <p className="text-sm font-medium">
        {step && <span className="inline-flex items-center justify-center w-5 h-5 mr-2 rounded-full bg-ink text-paper text-2xs align-[1px]">{step}</span>}
        {title}
      </p>
      <div className="bg-white rounded-md border border-line p-2 max-w-[280px]">
        {qr ? <img src={qr} alt={title} className="w-full block [image-rendering:pixelated]" /> : <div className="aspect-square" />}
      </div>
      {children}
    </div>
  );
}

export const ShareView: React.FC<ShareViewProps> = ({ onBack }) => {
  const desktop = window.ihpDesktop;
  const [items, setItems] = useState<ShareItem[]>([]);
  const [mode, setMode] = useState<Mode>('wifi');
  const [minutes, setMinutes] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  // QR sharing
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [urlIndex, setUrlIndex] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [ended, setEnded] = useState<string | null>(null);

  // Bluetooth
  const [radio, setRadio] = useState<string | null>(null);
  const [phones, setPhones] = useState<BluetoothPhone[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanRound, setScanRound] = useState(0);
  const [phoneId, setPhoneId] = useState('');
  const [btPhase, setBtPhase] = useState<'idle' | 'sending' | 'done'>('idle');
  const [btEvent, setBtEvent] = useState<(BluetoothEvent & { at: number; startedAt?: number }) | null>(null);

  const url = share?.urls[urlIndex]?.url ?? '';
  const total = items.reduce((n, i) => n + i.size, 0);

  useEffect(
    () =>
      desktop?.share.onEnded((reason) => {
        setShare(null);
        setEnded(reason === 'expired' ? 'The QR code expired.' : 'Sharing stopped.');
      }),
    [desktop]
  );

  // Leaving the tool ends a share or transfer, like closing the app does.
  useEffect(
    () => () => {
      void desktop?.share.stop();
      void desktop?.bluetooth.cancel();
    },
    [desktop]
  );

  useEffect(() => {
    if (!share) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [share]);

  useEffect(
    () =>
      desktop?.bluetooth.onEvent((ev) =>
        setBtEvent((prev) => ({ ...ev, at: Date.now(), startedAt: ev.type === 'progress' ? (prev?.startedAt ?? Date.now()) : undefined }))
      ),
    [desktop]
  );

  // Bluetooth: keep looking for phones for about a minute while this mode is open
  // (scanning slows other Bluetooth devices), then stop until "scan again".
  useEffect(() => {
    if (!desktop || mode !== 'bluetooth' || btPhase !== 'idle') return;
    let live = true;
    void (async () => {
      for (let scans = 0; live && scans < 7; ) {
        try {
          setScanning(true);
          const found = await desktop.bluetooth.scan();
          if (!live) return;
          setRadio(found.radio);
          if (found.radio !== 'On') {
            setScanning(false);
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          setPhones((prev) => [...prev.filter((p) => !found.devices.some((f) => f.id === p.id)), ...found.devices]);
          scans++;
        } catch (e) {
          if (live) setError(message(e));
          return;
        } finally {
          if (live) setScanning(false);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [desktop, mode, btPhase, scanRound]);

  const addPaths = async (paths: string[]) => {
    if (!desktop || !paths.length) return;
    try {
      const described = await desktop.share.describe(paths);
      setItems((prev) => [...prev, ...described.filter((d) => !prev.some((p) => p.path === d.path))]);
    } catch (e) {
      setError(message(e));
    }
  };

  const startQr = async () => {
    if (!desktop || mode === 'bluetooth') return;
    setBusy(true);
    setError(null);
    setEnded(null);
    try {
      const info = await desktop.share.start(
        items.map((i) => i.path),
        minutes,
        mode
      );
      setUrlIndex(0);
      setNow(Date.now());
      setShare(info);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const changeMinutes = async (m: number) => {
    setMinutes(m);
    if (!share || !desktop) return;
    const expiresAt = await desktop.share.setMinutes(m);
    if (expiresAt) {
      setNow(Date.now());
      setShare({ ...share, expiresAt });
    }
  };

  const sendBluetooth = async () => {
    if (!desktop) return;
    setBtPhase('sending');
    setError(null);
    setBtEvent(null);
    try {
      await desktop.bluetooth.send(
        phoneId,
        items.map((i) => i.path)
      );
      setBtPhase('done');
    } catch (e) {
      setBtPhase('idle');
      setError(message(e));
    }
  };

  const phone = phones.find((p) => p.id === phoneId)?.name ?? 'the phone';
  const speed = btEvent?.type === 'progress' && btEvent.startedAt && btEvent.at - btEvent.startedAt > 1000 ? btEvent.sent / ((btEvent.at - btEvent.startedAt) / 1000) : 0;

  if (!desktop) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <ToolHeader tool={getTool('share')} onBack={onBack} />
        <Notice tone="warn" title="Available in the desktop app">
          A browser tab can’t share files to a phone. Install the IHatePDF desktop app to use this.
        </Notice>
      </div>
    );
  }

  // ---- Active QR share ----
  if (share) {
    const left = share.expiresAt - now;
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8">
        <ToolHeader tool={getTool('share')} onBack={onBack} />
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,300px)] gap-8 items-start">
          <div className={cn('grid gap-6', share.wifi && 'sm:grid-cols-2')}>
            {share.wifi && (
              <QrCard step={1} title="Join this PC’s hotspot" text={`WIFI:T:WPA;S:${wifiEscape(share.wifi.ssid)};P:${wifiEscape(share.wifi.password)};;`}>
                <p className="text-2xs text-muted">
                  Or join <b className="text-ink">{share.wifi.ssid}</b> by hand, password <b className="font-mono text-ink">{share.wifi.password}</b>. The phone may say there’s no internet; stay connected.
                </p>
              </QrCard>
            )}
            <QrCard step={share.wifi ? 2 : undefined} title={share.wifi ? 'Then scan to download' : 'Scan with the phone’s camera'} text={url}>
              <p className="font-mono text-2xs text-muted break-all select-all">{url}</p>
            </QrCard>
          </div>

          <div className="space-y-6">
            <div>
              <p className="label-mono mb-1">Expires in</p>
              <p className="text-4xl font-semibold tabular-nums tracking-tight">{clock(left)}</p>
              <p className="text-sm text-muted mt-2">
                {items.length === 1 ? (items[0].isDir ? 'The folder downloads as a .zip.' : 'The file stays on this PC until the phone downloads it.') : 'Each item downloads on its own, or everything as one .zip.'}
              </p>
            </div>
            <Field label="Keep the QR code active for" hint="Changing it restarts the countdown.">
              <Segmented value={minutes} onChange={(m) => void changeMinutes(m)} options={DURATIONS} />
            </Field>
            {!share.wifi && share.urls.length > 1 && (
              <Field label="Network" hint="Pick the one the phone is on if the page doesn’t open.">
                <select className="input h-8" value={urlIndex} onChange={(e) => setUrlIndex(Number(e.target.value))}>
                  {share.urls.map((u, i) => (
                    <option key={u.url} value={i}>
                      {u.name} · {new URL(u.url).hostname}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Button variant="danger" icon={<Square className="w-3.5 h-3.5" />} onClick={() => void desktop.share.stop()}>
              Stop sharing
            </Button>
            <p className="text-2xs text-muted">Closing the app also stops sharing{share.wifi ? ' and turns the hotspot off' : ''}.</p>
          </div>
        </div>
      </div>
    );
  }

  // ---- Bluetooth transfer in progress / finished ----
  if (mode === 'bluetooth' && btPhase !== 'idle') {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <ToolHeader tool={getTool('share')} onBack={onBack} />
        {btPhase === 'sending' ? (
          <Panel className="p-5 space-y-4">
            {!btEvent || btEvent.type === 'connecting' ? (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Connecting to {phone}…
              </p>
            ) : btEvent.type === 'zipping' ? (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Putting everything into one .zip…
              </p>
            ) : btEvent.type === 'waiting' ? (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Tap Accept on {phone}…
              </p>
            ) : (
              <ProgressLine
                progress={(btEvent.sent / Math.max(1, btEvent.size)) * 100}
                stage={`${formatBytes(btEvent.sent)} of ${formatBytes(btEvent.size)}${speed ? ` · ${formatBytes(speed)}/s` : ''}`}
              />
            )}
            <p className="text-2xs text-muted">Keep the phone near this PC until it finishes.</p>
            <Button variant="danger" onClick={() => void desktop.bluetooth.cancel()}>
              Cancel
            </Button>
          </Panel>
        ) : (
          <div className="space-y-4">
            <Notice tone="ok" title={`Sent to ${phone}`}>
              On the phone, look in the Download folder (on some phones Download › Bluetooth), or tap the “file received” notification.
            </Notice>
            <Button
              onClick={() => {
                setItems([]);
                setBtPhase('idle');
              }}
            >
              Send something else
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ---- Setup ----
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <ToolHeader tool={getTool('share')} onBack={onBack} />

      {ended && <Notice tone="warn" title={ended}>Create a new QR code to share again.</Notice>}
      {error && (
        <Notice tone="error" title="Couldn’t share">
          {error}
        </Notice>
      )}

      <section className="space-y-3">
        <h3 className="label-mono">1 · What to share</h3>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addPaths(desktop.share.pathsOf(Array.from(e.dataTransfer.files)));
          }}
          className={cn('border border-dashed rounded-md p-5 flex flex-col items-center gap-3 text-center transition-colors', dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel')}
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button icon={<FilePlus2 className="w-4 h-4" />} onClick={() => void desktop.share.pick('files').then(addPaths)}>
              Add files
            </Button>
            <Button icon={<FolderPlus className="w-4 h-4" />} onClick={() => void desktop.share.pick('folder').then(addPaths)}>
              Add folder
            </Button>
          </div>
          <p className="text-xs text-muted">or drag files and folders here · any type</p>
        </div>

        {items.length > 0 && (
          <Panel className="p-4 space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="label-mono">
                {items.length} item{items.length === 1 ? '' : 's'} · {formatBytes(total)}
              </h3>
              <button onClick={() => setItems([])} className="text-2xs text-muted hover:text-danger">
                Remove all
              </button>
            </div>
            <ul className="max-h-64 overflow-y-auto overflow-x-hidden scroll-thin">
              {items.map((it) => (
                <li key={it.path} className="flex items-center gap-2 py-1">
                  {it.isDir ? <Folder className="w-4 h-4 text-faint shrink-0" /> : <FileText className="w-4 h-4 text-faint shrink-0" />}
                  <span className="text-xs font-medium truncate flex-1" title={it.path}>
                    {it.name}
                  </span>
                  <span className="font-mono text-2xs text-muted whitespace-nowrap">
                    {it.isDir ? `${it.count} files · ` : ''}
                    {formatBytes(it.size)}
                  </span>
                  <IconButton label={`Remove ${it.name}`} size="sm" onClick={() => setItems(items.filter((x) => x.path !== it.path))}>
                    <X className="w-3.5 h-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="label-mono">2 · How the phone connects</h3>
        <Segmented value={mode} onChange={setMode} options={MODES} />
        <Notice tone="info" title={MODE_INFO[mode].title}>
          {MODE_INFO[mode].body}
        </Notice>
      </section>

      {mode !== 'bluetooth' ? (
        <Panel className="p-4 space-y-4">
          <Field label="Keep the QR code active for">
            <Segmented value={minutes} onChange={setMinutes} options={DURATIONS} />
          </Field>
          <Button variant="primary" size="lg" block disabled={busy || !items.length} onClick={() => void startQr()}>
            {busy ? (mode === 'hotspot' ? 'Turning on the hotspot…' : 'Starting…') : items.length ? 'Create QR code' : 'Add something to share first'}
          </Button>
        </Panel>
      ) : (
        <Panel className="p-4 space-y-4">
          {radio === 'Off' ? (
            <Notice tone="warn" title="Bluetooth is off on this PC">
              Turn it on (or check that this PC has Bluetooth). This page notices by itself once it’s on.
              <div className="mt-2">
                <Button size="sm" icon={<Settings className="w-3.5 h-3.5" />} onClick={() => desktop.bluetooth.openSettings()}>
                  Open Bluetooth settings
                </Button>
              </div>
            </Notice>
          ) : (
            <Field
              label="Send to"
              hint={
                scanning ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="w-3 h-3" /> Looking for phones nearby…
                  </span>
                ) : (
                  <span>
                    Don’t see the phone? Open Bluetooth settings on the phone so it’s visible, then{' '}
                    <button className="underline hover:text-ink" onClick={() => setScanRound((n) => n + 1)}>
                      scan again
                    </button>
                    .
                  </span>
                )
              }
            >
              <select className="input h-9" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} disabled={!phones.length}>
                <option value="">{phones.length ? 'Choose the phone…' : 'No phone found yet'}</option>
                {phones.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button variant="primary" size="lg" block icon={<Bluetooth className="w-4 h-4" />} disabled={!items.length || !phoneId || radio === 'Off'} onClick={() => void sendBluetooth()}>
            {!items.length ? 'Add something to share first' : phoneId ? `Send to ${phone}` : 'Choose the phone first'}
          </Button>
        </Panel>
      )}
    </div>
  );
};
