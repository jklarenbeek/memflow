/**
 * ChatPane — Main chat view with message list and input area
 */
import { useState, useRef, useEffect } from "react";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkflowStream } from "../../hooks/useWorkflowStream";
import { api } from "../../lib/api";
import { MessageBubble } from "./MessageBubble";

export function ChatPane() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { messages, isStreaming } = useChatStore();
  const { currentSolutionId, currentConversationId, serverUrl } = useAppStore();
  const { run, cancel } = useWorkflowStream();

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !currentSolutionId || !currentConversationId) return;
    const query = input.trim();
    setInput("");

    try {
      // Load chat workflow
      api.setBaseUrl(serverUrl);
      const wfRes = await api.getWorkflow("chat");
      const workflow = wfRes.workflow;

      await run({
        workflow,
        input: { query },
        solutionId: currentSolutionId,
        conversationId: currentConversationId,
      });
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!currentSolutionId || !currentConversationId) {
    return (
      <div className="chat-empty">
        <div className="empty-hero">
          <h2>Welcome to MemFlow</h2>
          <p>Select or create a solution and conversation to start chatting.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-pane">
      <div className="message-list">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          placeholder="Ask MemFlow anything... (Ctrl+Enter to send)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          rows={3}
        />
        <div className="chat-input-actions">
          {isStreaming ? (
            <button className="btn-cancel" onClick={cancel}>Stop</button>
          ) : (
            <button className="btn-send" onClick={handleSend}
              disabled={!input.trim() || !currentSolutionId || !currentConversationId}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
