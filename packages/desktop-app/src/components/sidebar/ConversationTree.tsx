/**
 * ConversationTree — Conversation list grouped by solution
 */
import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

interface Conversation {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  lastMessagePreview?: string;
}

export function ConversationTree() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { currentSolutionId, currentConversationId, setCurrentConversation, serverUrl } = useAppStore();

  const loadConversations = async () => {
    if (!currentSolutionId) { setConversations([]); return; }
    try {
      api.setBaseUrl(serverUrl);
      const res = await api.listConversations(currentSolutionId);
      setConversations(res.conversations as unknown as Conversation[]);
    } catch { /* server may not be ready */ }
  };

  useEffect(() => { loadConversations(); }, [currentSolutionId, serverUrl]);

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

  return (
    <div className="conversation-tree">
      <div className="section-header">
        <h3>Conversations</h3>
        <button className="btn-icon" onClick={createConversation} title="New Conversation"
          disabled={!currentSolutionId}>+</button>
      </div>

      <div className="conversation-items">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            className={`conversation-item ${conv.id === currentConversationId ? "active" : ""}`}
            onClick={() => setCurrentConversation(conv.id)}
          >
            <span className="conv-title">{conv.title}</span>
            <span className="conv-meta">
              {conv.messageCount} msgs · {new Date(conv.updatedAt).toLocaleDateString()}
            </span>
            {conv.lastMessagePreview && (
              <span className="conv-preview">{conv.lastMessagePreview}</span>
            )}
          </button>
        ))}
        {!currentSolutionId && (
          <p className="empty-state">Select a solution to see conversations.</p>
        )}
        {currentSolutionId && conversations.length === 0 && (
          <p className="empty-state">No conversations yet.</p>
        )}
      </div>
    </div>
  );
}
