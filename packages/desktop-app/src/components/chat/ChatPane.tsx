/**
 * ChatPane — Main chat view with message list and input area
 */
import { useState, useRef, useEffect } from "react";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkflowStream } from "../../hooks/useWorkflowStream";
import { api } from "../../lib/api";
import { MessageBubble } from "./MessageBubble";

export function ChatPane() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { messages, isStreaming, setMessages, clearMessages } = useChatStore();
  const { currentSolutionId, currentConversationId, serverUrl } = useAppStore();
  const { run, cancel } = useWorkflowStream();

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load conversation history when conversation changes
  useEffect(() => {
    if (!currentConversationId) {
      clearMessages();
      return;
    }

    const loadHistory = async () => {
      setLoading(true);
      try {
        api.setBaseUrl(serverUrl);
        const res = await api.getConversation(currentConversationId);
        const msgs: ChatMessage[] = (res.messages as Array<Record<string, unknown>>).map((m) => ({
          id: m.id as string,
          role: m.role as "user" | "assistant" | "system",
          content: m.content as string,
          workflowId: m.workflowId as string | undefined,
          workflowName: m.workflowName as string | undefined,
          stageTrace: m.stageTrace ? JSON.parse(m.stageTrace as string) : undefined,
          stageCount: m.stageCount as number | undefined,
          durationMs: m.durationMs as number | undefined,
          sources: m.sources ? JSON.parse(m.sources as string) : undefined,
          tokenUsage: m.tokenUsage as number | undefined,
          createdAt: m.createdAt as string,
        }));
        setMessages(msgs);
      } catch (err) {
        console.error("Failed to load conversation history:", err);
        clearMessages();
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
  }, [currentConversationId, serverUrl]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !currentSolutionId || !currentConversationId) return;
    const query = input.trim();
    setInput("");

    try {
      // Load chat workflow
      api.setBaseUrl(serverUrl);
      let workflow: Record<string, unknown>;
      try {
        const wfRes = await api.getWorkflow("chat");
        workflow = wfRes.workflow;
      } catch {
        // Fallback: use first available workflow from catalog
        const catalog = await api.listWorkflows();
        const workflows = catalog.workflows as Array<Record<string, unknown>>;
        if (workflows.length === 0) throw new Error("No workflows available");
        workflow = workflows[0];
      }

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
        {loading && (
          <div className="loading-messages">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
          </div>
        )}
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
