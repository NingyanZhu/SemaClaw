import type { WorkbenchArtifact } from '../../types';

interface Props {
  items: WorkbenchArtifact[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function HistoryList({ items, currentId, onSelect, onClose }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col border-t border-gray-100 max-h-[160px]">
      <div className="px-3 py-1.5 flex-shrink-0 border-b border-gray-100">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">History · {items.length}</span>
      </div>
      <div className="overflow-y-auto flex-1 min-h-0">
        {items.map(item => {
          const isCurrent = item.id === currentId;
          const status = item.process?.status;
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${isCurrent ? 'bg-[#EBF5FB]' : ''}`}
              onClick={() => onSelect(item.id)}
              title={item.title}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                status === 'running' ? 'bg-green-500 animate-pulse'
                  : status === 'crashed' ? 'bg-red-500'
                  : status === 'stopped' ? 'bg-gray-400'
                  : 'bg-[#5BBFE8]'
              }`} />
              <span className={`flex-1 truncate ${isCurrent ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>
                {item.title}
              </span>
              <span className="text-[9px] text-gray-300 flex-shrink-0">{modeLabel(item.mode)}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(item.id); }}
                className="text-gray-300 hover:text-red-500 text-xs flex-shrink-0"
                title="Close"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function modeLabel(m: WorkbenchArtifact['mode']): string {
  return m === 'static' ? 'file' : m === 'web' ? 'web' : 'api';
}
