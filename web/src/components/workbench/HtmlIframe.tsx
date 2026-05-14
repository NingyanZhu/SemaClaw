import { useEffect, useState } from 'react';

interface Props {
  /** HTML 文件内容（已通过 WS 后端代读拿到） */
  srcdoc?: string;
  /** 渲染来源路径，仅用于错误展示 */
  sourcePath?: string;
  /** 加载错误信息 */
  error?: string;
}

export function HtmlIframe({ srcdoc, sourcePath, error }: Props) {
  const [delayed, setDelayed] = useState<string | undefined>(srcdoc);
  // 切换 artifact 时短暂卸载 iframe，避免 srcdoc 残留
  useEffect(() => {
    setDelayed(undefined);
    const t = setTimeout(() => setDelayed(srcdoc), 0);
    return () => clearTimeout(t);
  }, [srcdoc]);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-500">
        <div className="font-semibold mb-1">无法加载 HTML</div>
        <div className="text-xs text-gray-500">{sourcePath}</div>
        <div className="text-xs mt-1">{error}</div>
      </div>
    );
  }

  if (delayed == null) {
    return <div className="p-4 text-xs text-gray-400">Loading…</div>;
  }

  return (
    <iframe
      title={sourcePath ?? 'workbench-html'}
      srcDoc={delayed}
      sandbox="allow-scripts"
      className="w-full h-full border-0 bg-white"
    />
  );
}
