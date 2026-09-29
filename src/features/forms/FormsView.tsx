import React, { useEffect, useMemo, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { EmptyState, Field, Notice, Panel, Spinner, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import { ListChecks } from 'lucide-react';
import type { PDFFile } from '../../types/pdf';
import type { FillFormPayload, FormFieldInfo, GetFormFieldsResult, ProcessedPdfResult } from '../../types/worker';

interface FormsViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

function prettyName(name: string): string {
  const last = name.split('.').pop() ?? name;
  return last
    .replace(/\[\d+\]$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

export const FormsView: React.FC<FormsViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [hadXfa, setHadXfa] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./forms.worker.ts', import.meta.url), { type: 'module' }));
  const inspector = useToolRunner<GetFormFieldsResult & { buffer: ArrayBuffer; fileName: string }>(
    () => new Worker(new URL('./forms.worker.ts', import.meta.url), { type: 'module' })
  );
  const file = files[0];

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setFields(null);
    setInspectError(null);
    inspector
      .run('GET_FORM_FIELDS', { fileBuffer: file.data })
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setInspectError('This PDF couldn’t be read.');
          return;
        }
        setFields(res.fields);
        setHadXfa(!!res.hadXfa);
        const init: Record<string, string | boolean> = {};
        res.fields.forEach((f) => f.value !== undefined && (init[f.name] = f.value));
        setValues(init);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const byPage = useMemo(() => {
    const groups = new Map<number, FormFieldInfo[]>();
    (fields ?? []).forEach((f) => {
      const k = f.page ?? 0;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    });
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [fields]);

  const set = (name: string, v: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: v }));
    runner.reset();
  };

  const execute = () => {
    const payload: FillFormPayload = { fileBuffer: file.data, fileName: file.name, values, flatten };
    void runner.run('FILL_FORM', payload);
  };

  const editable = (fields ?? []).filter((f) => f.type !== 'unsupported');

  return (
    <ToolLayout
      tool={getTool('forms')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      resultNote={runner.result?.note}
      actionButtonLabel="Save filled PDF"
      onExecuteAction={execute}
      canExecute={editable.length > 0}
      options={
        <>
          <Toggle checked={flatten} onChange={setFlatten} label="Flatten form" hint="Bakes the answers into the page so they can’t be changed. Leave off to keep the form fillable." />
          {fields && <p className="font-mono text-2xs text-muted">{editable.length} fillable fields</p>}
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF form" subtitle="Its fields are detected automatically" />}
    >
      {inspectError && <Notice tone="error">{inspectError}</Notice>}
      {hadXfa && (
        <Notice tone="warn" title="This is an XFA (LiveCycle) form">
          Its dynamic layer is removed when saving, and the standard form fields below are filled instead — that’s what
          most PDF readers display anyway.
        </Notice>
      )}
      {!fields && !inspectError ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Looking for form fields…
        </div>
      ) : fields && editable.length === 0 ? (
        <Panel>
          <EmptyState icon={<ListChecks className="w-8 h-8" />} title="No fillable fields in this PDF">
            If it’s a scanned or “flat” form, use Edit PDF to type onto it instead.
          </EmptyState>
        </Panel>
      ) : (
        byPage.map(([page, list]) => (
          <Panel key={page} className="p-5">
            <h3 className="label-mono mb-4">{page ? `Page ${page}` : 'Fields'}</h3>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
              {list.map((f) => {
                const label = prettyName(f.name) || f.name;
                const v = values[f.name];
                if (f.type === 'checkbox') {
                  return (
                    <div key={f.name} className="sm:col-span-2">
                      <Toggle checked={!!v} disabled={f.readOnly} onChange={(c) => set(f.name, c)} label={label} />
                    </div>
                  );
                }
                if (f.type === 'radio') {
                  return (
                    <Field key={f.name} label={label}>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {f.options?.map((o) => (
                          <label key={o} className="inline-flex items-center gap-1.5 text-sm">
                            <input type="radio" name={f.name} disabled={f.readOnly} checked={v === o} onChange={() => set(f.name, o)} />
                            {o}
                          </label>
                        ))}
                      </div>
                    </Field>
                  );
                }
                if (f.type === 'dropdown') {
                  return (
                    <Field key={f.name} label={label}>
                      <select className="input" disabled={f.readOnly} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)}>
                        <option value="">—</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </Field>
                  );
                }
                if (f.type === 'text') {
                  return (
                    <Field key={f.name} label={label} aside={f.maxLength ? `max ${f.maxLength}` : undefined} className={f.multiline ? 'sm:col-span-2' : undefined}>
                      {f.multiline ? (
                        <textarea className="input min-h-[72px]" disabled={f.readOnly} maxLength={f.maxLength} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} />
                      ) : (
                        <input className="input" disabled={f.readOnly} maxLength={f.maxLength} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} />
                      )}
                    </Field>
                  );
                }
                return (
                  <Field key={f.name} label={label} hint="This field type (signature/button) can’t be filled here.">
                    <input className="input" disabled value="" />
                  </Field>
                );
              })}
            </div>
          </Panel>
        ))
      )}
    </ToolLayout>
  );
};
