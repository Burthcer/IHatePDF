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
      ack: () => send('mem_ack'),
      jobs: (n: number) => send('mem_jobs', { n }),
      relieve: () => undefined,
    },
    // log (usage log): not in the Tauri build, so the page shows no usage-log controls.
    showInFolder: (file: string) => send('show_in_folder', { file }),
    output: {
      create: () => invoke('out_create'),
      write: (handle: string, chunk: Uint8Array) => invoke('out_write', chunk, { headers: { 'x-handle': handle } }),
      close: (handle: string, discard?: boolean) => invoke('out_close', { handle, discard: !!discard }),
      save: (file: string, name: string) => invoke('out_save', { file, name }),
      discard: (file: string) => invoke('out_discard', { file }),
      read: async (file: string) => new Uint8Array(await invoke('out_read', { file })),
    },
    // share / bluetooth: not in the Tauri build yet (ShareView shows a notice).
  };
  window.ihpDesktop = bridge as unknown as typeof window.ihpDesktop;
}
