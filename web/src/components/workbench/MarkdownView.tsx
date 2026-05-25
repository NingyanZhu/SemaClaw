import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props {
  content?: string;
  error?: string;
  sourcePath?: string;
}

export function MarkdownView({ content, error, sourcePath }: Props) {
  if (error) {
    const closed   = error === 'artifact_not_found';   // registry 里真的没这条 → 卡片可移除
    const dormant  = error === 'core_not_found';       // agent 未启动 → 发消息后即可打开
    const isInfo   = closed || dormant;
    const title = closed   ? '该工作台已关闭'
                : dormant  ? 'Agent 未运行'
                :            '无法加载 Markdown';
    const hint  = closed   ? '在其他页面被关闭或服务已重启；点击右上角 × 移除此条目。'
                : dormant  ? '向当前 agent 发送任意消息以启动它，然后再次打开此工作台。'
                :            error;
    return (
      <div className={`p-4 text-sm ${isInfo ? 'text-gray-500' : 'text-red-500'}`}>
        <div className="font-semibold mb-1">{title}</div>
        <div className="text-xs text-gray-500">{sourcePath}</div>
        <div className="text-xs mt-1">{hint}</div>
      </div>
    );
  }
  if (content == null) {
    return <div className="p-4 text-xs text-gray-400">Loading…</div>;
  }
  return (
    <div className="h-full overflow-auto p-4 prose prose-sm max-w-none prose-headings:font-semibold prose-pre:bg-gray-900 prose-pre:text-gray-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
