/**
 * MessageBubble — Rich message rendering with inline DAG
 */
import type { ChatMessage } from "../../stores/chatStore";
import { MessageDAGMini } from "./MessageDAGMini";

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

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
      </div>

      {/* Inline DAG mini-view for assistant messages */}
      {!isUser && message.stages && message.stages.length > 0 && (
        <MessageDAGMini
          stages={message.stages}
          currentStageId={message.currentStageId}
          stageTrace={message.stageTrace}
          collapsed={message.collapsed}
        />
      )}

      <div className="bubble-content">
        {message.isStreaming && !message.content ? (
          <span className="streaming-indicator">Thinking...</span>
        ) : (
          <p>{message.content}</p>
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
    </div>
  );
}
