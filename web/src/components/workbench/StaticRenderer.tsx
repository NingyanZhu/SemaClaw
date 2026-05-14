import { useEffect, useState } from 'react';
import type { WorkbenchArtifact, WorkbenchFile } from '../../types';
import { HtmlIframe } from './HtmlIframe';
import { MarkdownView } from './MarkdownView';
import { CopyPathButton } from './CopyPathButton';

interface Props {
  artifact: WorkbenchArtifact;
  /** 读文件代理（通过 WS 拉后端文件内容） */
  readFile: (path: string) => Promise<{ content?: string; error?: string }>;
}

export function StaticRenderer({ artifact, readFile }: Props) {
  const files = artifact.files ?? [];
  const [activeIdx, setActiveIdx] = useState(0);

  // artifact 切换时重置 tab
  useEffect(() => {
    setActiveIdx(0);
  }, [artifact.id]);

  if (files.length === 0) {
    return <div className="p-4 text-sm text-gray-400">No files in this artifact.</div>;
  }

  const activeFile = files[Math.min(activeIdx, files.length - 1)];

  return (
    <div className="flex flex-col h-full min-h-0">
      {files.length > 1 && (
        <div className="flex items-center gap-1 px-2 pt-2 border-b border-gray-100 flex-shrink-0 overflow-x-auto">
          {files.map((f, i) => (
            <button
              key={f.path}
              onClick={() => setActiveIdx(i)}
              className={`text-xs px-2.5 py-1 rounded-t border-t border-x transition-colors flex-shrink-0 ${
                i === activeIdx
                  ? 'bg-white border-gray-200 text-gray-700 font-medium'
                  : 'bg-gray-50 border-transparent text-gray-400 hover:text-gray-600'
              }`}
              title={f.path}
            >
              {filename(f.path)}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-[10px] text-gray-500 flex-shrink-0">
        <span className="font-mono truncate" title={activeFile.path}>{activeFile.path}</span>
        <CopyPathButton path={activeFile.path} />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden bg-white">
        <FileBody file={activeFile} readFile={readFile} />
      </div>
    </div>
  );
}

function FileBody({ file, readFile }: { file: WorkbenchFile; readFile: Props['readFile'] }) {
  const [content, setContent] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    readFile(file.path).then(res => {
      if (cancelled) return;
      if (res.error) setError(res.error);
      else setContent(res.content);
    });
    return () => { cancelled = true; };
  }, [file.path, file.hash, readFile]);

  if (file.extension === 'html') {
    return <HtmlIframe srcdoc={content} sourcePath={file.path} error={error} />;
  }
  return <MarkdownView content={content} sourcePath={file.path} error={error} />;
}

function filename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
