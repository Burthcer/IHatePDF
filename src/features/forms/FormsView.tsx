import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { ListChecks } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type {
  GetFormFieldsPayload,
  GetFormFieldsResult,
  FillFormPayload,
  FormFieldInfo,
  ProcessedPdfResult,
} from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'forms',
  title: 'PDF Forms',
  description: 'Fill in a PDF form’s fields and export a completed copy.',
  icon: 'ListChecks',
  color: '#6366F1',
  category: 'edit',
  acceptedFiles: 'single',
};

interface FormsViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const FormsView: React.FC<FormsViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(true);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const { runTask, isProcessing, progress, stage, error, resetState } = useWorkerBridge<
    GetFormFieldsResult | ProcessedPdfResult
  >(() => new Worker(new URL('./forms.worker.ts', import.meta.url), { type: 'module' }));

  const handleFilesAccepted = async (accepted: PDFFile[]) => {
    const file = accepted.slice(0, 1)[0];
    setFiles([file]);
    setResult(null);
    setFields(null);
    resetState();

    setInspecting(true);
    try {
      const payload: GetFormFieldsPayload = { fileBuffer: file.rawBuffer.slice(0) };
      const res = (await runTask<GetFormFieldsPayload>('GET_FORM_FIELDS', payload)) as GetFormFieldsResult;
      setFields(res.fields);
      const initial: Record<string, string | boolean> = {};
      res.fields.forEach((f) => {
        if (f.value !== undefined) initial[f.name] = f.value;
      });
      setValues(initial);
    } catch (err) {
      console.error('Form inspection error:', err);
    } finally {
      setInspecting(false);
    }
  };

  const handleClearFiles = () => {
    setFiles([]);
    setFields(null);
    setValues({});
    setResult(null);
    resetState();
  };

  const executeFill = async () => {
    if (files.length === 0) return;
    const file = files[0];
    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: FillFormPayload = { fileBuffer: bufferCopy, fileName: file.name, values, flatten };
      const res = (await runTask<FillFormPayload>('FILL_FORM', payload, [bufferCopy])) as ProcessedPdfResult;
      setResult(res);
    } catch (err) {
      console.error('Form fill error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#6366F1"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing || inspecting}
      progress={progress}
      stage={inspecting ? 'Detecting form fields...' : stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'filled_form.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Save Filled PDF"
      onExecuteAction={executeFill}
      canExecute={files.length > 0 && !!fields}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF form" subtitle="Its fillable fields will be detected automatically" />
      ) : fields && fields.length === 0 ? (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-6 text-sm text-amber-800 dark:text-amber-300">
          No fillable form fields were detected in this PDF.
        </div>
      ) : fields ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-[#6366F1]" />
            <span>{fields.length} Field{fields.length === 1 ? '' : 's'} Detected</span>
          </h3>

          <div className="space-y-3">
            {fields.map((field) => (
              <div key={field.name}>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">{field.name}</label>
                {field.type === 'text' && (
                  <input
                    type="text"
                    value={(values[field.name] as string) || ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                )}
                {field.type === 'checkbox' && (
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={!!values[field.name]}
                      onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.checked }))}
                      className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>Checked</span>
                  </label>
                )}
                {(field.type === 'radio' || field.type === 'dropdown') && (
                  <select
                    value={(values[field.name] as string) || ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">—</option>
                    {(field.options || []).map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                )}
                {field.type === 'unsupported' && (
                  <p className="text-xs text-slate-400">Unsupported field type — left unchanged.</p>
                )}
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 pt-2 border-t border-slate-100 dark:border-slate-800">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>Flatten form (make fields permanent, non-editable)</span>
          </label>
        </div>
      ) : null}
    </ToolLayout>
  );
};
