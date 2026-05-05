/**
 * CommunityPanel — Collapsible community listing sidebar
 *
 * Shows community summaries with member counts and top entities.
 * Click a community to load its subgraph into the canvas.
 */
import { useCallback } from "react";
import { useGraphStore } from "../../stores/graphStore";
import { api } from "../../lib/api";

export function CommunityPanel() {
  const { communities, communityPanelOpen, toggleCommunityPanel, mergeSubgraph, setSelectedNode } =
    useGraphStore();

  const handleCommunityClick = useCallback(
    async (communityId: string) => {
      try {
        const res = await api.graphSubgraph([communityId], 2);
        mergeSubgraph(res.nodes, res.edges);
        setSelectedNode(communityId);
      } catch (err) {
        console.error("Failed to load community subgraph:", err);
      }
    },
    [mergeSubgraph, setSelectedNode],
  );

  if (!communityPanelOpen) return null;

  return (
    <div className="graph-community-panel">
      <div className="graph-community-header">
        <h4>🏘️ Communities</h4>
        <button className="inspector-close" onClick={toggleCommunityPanel}>
          ×
        </button>
      </div>

      <div className="graph-community-list">
        {communities.length === 0 && (
          <p className="empty-state">No communities detected yet.</p>
        )}

        {communities.map((comm) => {
          const sizeClass =
            comm.memberCount >= 50
              ? "large"
              : comm.memberCount >= 10
                ? "medium"
                : "small";

          return (
            <button
              key={comm.id}
              className="graph-community-card"
              onClick={() => handleCommunityClick(comm.id)}
            >
              <div className="graph-comm-header">
                <span className="graph-comm-name">
                  {(comm.name as string) || (comm.summary as string)?.slice(0, 40) || `Community ${comm.id}`}
                </span>
                <span className={`graph-comm-count ${sizeClass}`}>
                  {comm.memberCount} members
                </span>
              </div>

              {(comm.summary as string) && (
                <p className="graph-comm-summary">{(comm.summary as string).slice(0, 120)}</p>
              )}

              {comm.topEntities && comm.topEntities.length > 0 && (
                <div className="graph-comm-entities">
                  {comm.topEntities.map((entity, i) => (
                    <span key={i} className="graph-entity-tag">
                      {entity}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
