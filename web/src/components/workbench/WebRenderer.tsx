import type { WorkbenchArtifact } from '../../types';
import { CopyPathButton } from './CopyPathButton';

interface Props {
  artifact: WorkbenchArtifact;
}

export function WebRenderer({ artifact }: Props) {
  if (!artifact.url) {
    return <div className="p-4 text-sm text-gray-400">No URL provided.</div>;
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-[10px] text-gray-500 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ServiceStatusDot status={artifact.process?.status} />
          <span className="font-mono truncate" title={artifact.url}>{artifact.url}</span>
        </div>
        <CopyPathButton path={artifact.url} label="⧉ copy url" />
      </div>
      <div className="flex-1 min-h-0 bg-white">
        <iframe
          title={artifact.title}
          src={artifact.url}
          sandbox="allow-scripts allow-same-origin allow-forms"
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

function ServiceStatusDot({ status }: { status?: string }) {
  if (!status) return null;
  const colorMap: Record<string, string> = {
    running: 'bg-green-500 animate-pulse',
    stopped: 'bg-gray-400',
    crashed: 'bg-red-500',
  };
  return <span className={`w-1.5 h-1.5 rounded-full ${colorMap[status] ?? 'bg-gray-300'}`} title={status} />;
}
