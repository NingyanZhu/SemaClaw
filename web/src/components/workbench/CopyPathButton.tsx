import { useState } from 'react';

interface Props {
  path: string;
  label?: string;
}

export function CopyPathButton({ path, label }: Props) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 退化：选中文本
      const ta = document.createElement('textarea');
      ta.value = path;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy: ${path}`}
      className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
        copied ? 'bg-green-50 border-green-200 text-green-600' : 'bg-gray-50 border-gray-200 text-gray-500 hover:text-[#5BBFE8] hover:border-[#5BBFE8]'
      }`}
    >
      {copied ? '✓ copied' : (label ?? '⧉ copy path')}
    </button>
  );
}
