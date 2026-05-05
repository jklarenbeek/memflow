import './Chat.css';
/**
 * MessageBubble — Rich message rendering with markdown, DAG, and timestamps
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState } from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { MessageDAGMini } from "./MessageDAGMini";

interface Props {
  message: ChatMessage;
  onStageClick?: (stage: { stageId: string; module: string; status: string; durationMs: number }) => void;
}

/** Format a timestamp as relative time ("2m ago", "1h ago", etc.) */
function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MessageBubble({ message, onStageClick }: Props) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [showCopyFeedback, setShowCopyFeedback] = useState(false);

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setShowCopyFeedback(true);
      setTimeout(() => setShowCopyFeedback(false), 1500);
    } catch { /* clipboard may not be available */ }
  };

  return (
    <div className={`message-bubble ${isUser ? "user" : "assistant"} ${isSystem ? "system" : ""}`}>
      <div className="bubble-header">
        <span className="bubble-role">{isUser ? "You" : "MemFlow"}</span>
        {message.workflowName && (
          <span className="bubble-workflow">@{message.workflowName}</span>
        )}
        {message.durationMs && (
          <span className="bubble-duration">{(message.durationMs / 1000).toFixed(1)}s</span>
        )}
        {message.createdAt && (
          <span className="bubble-time">{relativeTime(message.createdAt)}</span>
        )}
        <div className="bubble-actions">
          <button className="bubble-action-btn" onClick={copyContent} title="Copy">
            {showCopyFeedback ? "✓" : "📋"}
          </button>
        </div>
      </div>

      {/* Inline DAG mini-view for assistant messages */}
      {!isUser && message.stages && message.stages.length > 0 && (
        <MessageDAGMini
          stages={message.stages}
          currentStageId={message.currentStageId}
          stageTrace={message.stageTrace}
          collapsed={message.collapsed}
          onStageClick={onStageClick}
        />
      )}

      <div className="bubble-content">
        {message.isStreaming && !message.content ? (
          <span className="streaming-indicator">Thinking...</span>
        ) : isUser ? (
          <p>{message.content}</p>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              // Custom code block with copy button
              pre({ children, ...props }) {
                return (
                  <div className="code-block-wrapper">
                    <pre {...props}>{children}</pre>
                    <button
                      className="code-copy-btn"
                      onClick={() => {
                        const text = (children as any)?.props?.children;
                        if (typeof text === "string") navigator.clipboard.writeText(text);
                      }}
                      title="Copy code"
                    >
                      📋
                    </button>
                  </div>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        )}
      </div>

      {message.sources && message.sources.length > 0 && (
        <div className="bubble-sources">
          <span className="sources-label">Sources:</span>
          {message.sources.map((src, i) => (
            <span key={i} className="source-badge">{src}</span>
          ))}
        </div>
      )}

      {message.tokenUsage && (
        <span className="bubble-tokens">{message.tokenUsage} tokens</span>
      )}
    </div>
  );
}
