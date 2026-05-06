import './Sidebar.css';
/**
 * ConversationTree — Conversation list grouped by solution
 */
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

interface Conversation {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  lastMessagePreview?: string | null;
}

export function ConversationTree() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const { currentSolutionId, currentConversationId, setCurrentConversation, serverUrl } = useAppStore();

  const loadConversations = useCallback(async () => {
    if (!currentSolutionId) { setConversations([]); return; }
    setLoading(true);
    try {
      api.setBaseUrl(serverUrl);
      const res = await api.listConversations(currentSolutionId);
      setConversations(res.conversations as unknown as Conversation[]);
    } catch { /* server may not be ready */ }
    finally { setLoading(false); }
  }, [currentSolutionId, serverUrl]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const createConversation = async () => {
    if (!currentSolutionId) return;
    try {
      const res = await api.createConversation({ solutionId: currentSolutionId });
      const conv = res.conversation as unknown as Conversation;
      setConversations([conv, ...conversations]);
      setCurrentConversation(conv.id);
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Conversations don't have a delete endpoint yet — just remove from local state
    setConversations(conversations.filter(c => c.id !== id));
    if (currentConversationId === id) {
      setCurrentConversation(null);
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="conversation-tree">
      <div className="section-header">
        <h3>Conversations</h3>
        <button className="btn-icon" onClick={createConversation} title="New Conversation"
          disabled={!currentSolutionId}>+</button>
      </div>

      <div className="conversation-items">
        {loading && (
          <div className="loading-items">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        )}
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item ${conv.id === currentConversationId ? "active" : ""}`}
            onClick={() => setCurrentConversation(conv.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCurrentConversation(conv.id); }}
          >
            <span className="conv-title">{conv.title}</span>
            <span className="conv-meta">
              {conv.messageCount} msgs · {formatTime(conv.updatedAt)}
            </span>
            {conv.lastMessagePreview && (
              <span className="conv-preview">{conv.lastMessagePreview}</span>
            )}
            <button className="conv-delete" onClick={(e) => deleteConversation(conv.id, e)} title="Remove">×</button>
          </div>
        ))}
        {!currentSolutionId && (
          <p className="empty-state">Select a solution to see conversations.</p>
        )}
        {currentSolutionId && conversations.length === 0 && !loading && (
          <p className="empty-state">No conversations yet.</p>
        )}
      </div>
    </div>
  );
}
