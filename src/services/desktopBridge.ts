/**
 * Desktop bridge for the Tauri shell: exposes `window.ihpDesktop` (the same API the
 * Electron preload used) on top of Tauri commands and events. Does nothing in a browser.
 */

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => Promise<any> };
  event: { listen: (name: string, cb: (e: { payload: any }) => void) => Promise<() => void> };
}

const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

if (tauri && !window.ihpDesktop) {
  const { invoke } = tauri.core;
  const listen = (name: string) => (cb: (v: any) => void) => {
    const un = tauri.event.listen(name, (e) => cb(e.payload));
    return () => void un.then((f) => f());
  };
  const send = (cmd: string, args?: unknown) => void invoke(cmd, args).catch(() => undefined);

  const bridge = {
    onSaved: listen('ihp:saved'),
    memory: {
      info: () => invoke('mem_info'),
      onChange: listen('ihp:mem'),
      ack: () => send('noop'),
      jobs: (n: number) => send('noop'),
      relieve: () => undefined,
    },
    log: {
      tool: (tool: string) => send('noop'),
      jobStart: (id: string, info: unknown) => send('noop'),
      jobEnd: (id: string, result: unknown) => send('noop'),
      info: () => invoke('log_info'),
      setEnabled: (on: boolean) => invoke('log_set', { on }),
    },
    showInFolder: (file: string) => send('show_in_folder', { file }),
    output: {
      create: () => invoke('out_create'),
      write: (handle: string, chunk: Uint8Array) => invoke('out_write', chunk, { headers: { 'x-handle': handle } }),
      close: (handle: string, discard?: boolean) => invoke('out_close', { handle, discard: !!discard }),
      save: (file: string, name: string) => invoke('out_save', { file, name }),
      discard: (file: string) => invoke('out_discard', { file }),
      read: async (file: string) => new Uint8Array(await invoke('out_read', { file })),
    },
    share: {
      pick: (kind: string) => invoke('share_pick', { kind }),
      pathsOf: (files: File[]) => files.map((f) => (f as File & { path?: string }).path).filter(Boolean) as string[],
      describe: (paths: string[]) => invoke('share_describe', { paths }),
      start: (paths: string[], minutes: number, mode: string) => invoke('share_start', { paths, minutes, mode }),
      setMinutes: (minutes: number) => invoke('share_minutes', { minutes }),
      stop: () => invoke('share_stop'),
      onEnded: listen('ihp:share-ended'),
    },
    bluetooth: {
      scan: () => invoke('bt_scan'),
      send: (deviceId: string, paths: string[]) => invoke('bt_send', { deviceId, paths }),
      cancel: () => invoke('bt_cancel'),
      onEvent: listen('ihp:bt-event'),
      openSettings: () => send('bt_settings'),
    },
  };
  window.ihpDesktop = bridge as unknown as typeof window.ihpDesktop;
}
