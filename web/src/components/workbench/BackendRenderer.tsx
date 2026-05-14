import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { WorkbenchArtifact } from '../../types';
import { CopyPathButton } from './CopyPathButton';

interface Props {
  artifact: WorkbenchArtifact;
}

export function BackendRenderer({ artifact }: Props) {
  if (!artifact.url) {
    return <div className="p-4 text-sm text-gray-400">No API URL provided.</div>;
  }
  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto bg-white">
      <div className="p-4 border-b border-gray-100">
        <div className="text-[10px] uppercase text-gray-400 tracking-wide mb-1">API Endpoint</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-800 break-all">{artifact.url}</span>
          <CopyPathButton path={artifact.url} label="⧉ copy" />
        </div>
        {artifact.process && (
          <div className="text-[10px] text-gray-500 mt-2">
            Status: <span className={`font-semibold ${
              artifact.process.status === 'running' ? 'text-green-600'
                : artifact.process.status === 'crashed' ? 'text-red-600' : 'text-gray-500'
            }`}>{artifact.process.status}</span>
          </div>
        )}
      </div>
      {artifact.usage && (
        <div className="px-4 py-3 prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {artifact.usage}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
