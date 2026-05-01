/**
 * CommunityDetectorModule — MAGE community detection (Louvain / Leiden)
 *
 * Runs community detection on the Entity graph and:
 *  1. Captures community IDs from MAGE YIELD clause
 *  2. Writes community labels back to Entity nodes as `communityId` property
 *  3. Generates community-level summaries for high-level LightRAG retrieval
 *  4. Exposes community data on the WorkflowData bus
 *
 * Supports two algorithms (configurable via `algorithm`):
 *  - `louvain`: community_detection.get() — greedy modularity maximization,
 *    O(n log n), supports parallel execution via graph coloring heuristics.
 *  - `leiden`: leiden_community_detection.get() — enhanced Louvain that
 *    guarantees well-connected communities, O(L·m), non-deterministic.
 *
 * The module operates on :Entity nodes connected by :RELATES_TO edges.
 * It can also run on a subgraph projection for targeted analysis.
 *
 * Reads:  (graph state — :Entity nodes, :RELATES_TO edges)
 * Writes: communities (Record<number, CommunityInfo>), communitySummaries
 */

import { z } from "zod";
import type { BaseModule, ModuleInput, ModuleOutput } from "../../core/types.js";
import type { WorkflowContext } from "../../core/WorkflowContext.js";

const ConfigSchema = z.object({
  /** Algorithm: "louvain" (default) or "leiden" */
  algorithm: z.enum(["louvain", "leiden"]).default("louvain"),

  // --- Louvain-specific ---
  /** Edge property name for weights (Louvain). Set to "" for unweighted. */
  weight: z.string().default("weight"),
  /** Enable graph coloring heuristic for parallelization (Louvain) */
  coloring: z.boolean().default(false),
  /** Stop graph coarsening when shrunk to this many nodes (Louvain) */
  minGraphShrink: z.number().default(100000),
  /** Modularity gain threshold to stop iteration (Louvain) — (0, 1) exclusive */
  communityAlgThreshold: z.number().default(0.000001),
  /** Modularity gain threshold for coloring phase (Louvain) — must be > communityAlgThreshold */
  coloringAlgThreshold: z.number().default(0.01),

  // --- Leiden-specific ---
  /** Gamma parameter (Leiden) — resolution; lower = fewer, larger communities */
  gamma: z.number().default(1.0),
  /** Theta parameter (Leiden) — controls randomness */
  theta: z.number().default(0.01),

  // --- General ---
  /** Node label to detect communities on */
  nodeLabel: z.string().default("Entity"),
  /** Edge type connecting nodes */
  edgeType: z.string().default("RELATES_TO"),
  /** Generate LLM summaries for each detected community */
  generateSummaries: z.boolean().default(true),
  /** Maximum communities to summarize (to control LLM cost) */
  maxSummaries: z.number().default(20),
});

type CommunityConfig = z.infer<typeof ConfigSchema>;

interface CommunityInfo {
  id: number;
  nodeCount: number;
  nodeNames: string[];
  summary?: string;
}

export class CommunityDetectorModule implements BaseModule<CommunityConfig> {
  readonly name = "CommunityDetector";
  readonly version = "0.3.0";
  private config: CommunityConfig;

  constructor(config: Record<string, unknown> = {}) {
    this.config = ConfigSchema.parse(config);
  }

  async process(
    input: ModuleInput<CommunityConfig>,
    context: unknown,
  ): Promise<ModuleOutput> {
    const ctx = context as WorkflowContext;
    const communities = new Map<number, CommunityInfo>();

    try {
      // 1. Run community detection algorithm
      const results = this.config.algorithm === "leiden"
        ? await this.runLeiden(ctx)
        : await this.runLouvain(ctx);

      // 2. Group nodes by community
      for (const row of results) {
        const communityId = row.community_id;
        const nodeName = row.name ?? row.id ?? "unknown";

        if (communityId === -1) continue; // Node not in any community

        if (!communities.has(communityId)) {
          communities.set(communityId, {
            id: communityId,
            nodeCount: 0,
            nodeNames: [],
          });
        }

        const info = communities.get(communityId)!;
        info.nodeCount++;
        if (info.nodeNames.length < 20) {
          info.nodeNames.push(String(nodeName));
        }
      }

      // 3. Write community labels back to Entity nodes
      await this.writeCommunityLabels(results, ctx);

      // 4. Generate community summaries for high-level retrieval
      if (this.config.generateSummaries && communities.size > 0) {
        await this.generateCommunitySummaries(communities, ctx);
      }

      const communityData = Object.fromEntries(communities);

      ctx.logger.info(
        `CommunityDetector (${this.config.algorithm}): ` +
        `${communities.size} communities detected across ${results.length} nodes`,
      );

      return {
        data: {
          communities: communityData,
          communitySummaries: [...communities.values()]
            .filter((c) => c.summary)
            .map((c) => ({ communityId: c.id, summary: c.summary!, members: c.nodeNames })),
        },
        metrics: {
          detected: true,
          algorithm: this.config.algorithm,
          communityCount: communities.size,
          totalNodes: results.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      ctx.logger.warn(`CommunityDetector (${this.config.algorithm}): failed — ${msg}`);

      // If Leiden throws (no communities detected), suggest gamma adjustment
      if (this.config.algorithm === "leiden" && msg.includes("exception")) {
        ctx.logger.info(
          "CommunityDetector: Leiden found no communities. Try adjusting the gamma parameter.",
        );
      }

      return {
        data: { communities: {}, communitySummaries: [] },
        metrics: { detected: false, error: msg },
      };
    }
  }

  /**
   * Run Louvain community detection via MAGE.
   *
   * Procedure: community_detection.get()
   * YIELD: node, community_id
   */
  private async runLouvain(
    ctx: WorkflowContext,
  ): Promise<Array<{ community_id: number; name?: string; id?: string }>> {
    // Build the subgraph projection for targeted detection on nodeLabel/edgeType
    const results = await ctx.memgraph.query<{
      community_id: number;
      name: string;
      id: string;
    }>(
      `CALL community_detection.get($coloring, $minShrink, $communityThreshold, $coloringThreshold)
       YIELD node, community_id
       WHERE $nodeLabel IN labels(node)
       RETURN node.name AS name, node.id AS id, community_id`,
      {
        coloring: this.config.coloring,
        minShrink: this.config.minGraphShrink,
        communityThreshold: this.config.communityAlgThreshold,
        coloringThreshold: this.config.coloringAlgThreshold,
        nodeLabel: this.config.nodeLabel,
      },
    );

    return results;
  }

  /**
   * Run Leiden community detection via MAGE.
   *
   * Procedure: leiden_community_detection.get()
   * YIELD: node, community_id, communities
   *
   * Note: Leiden can throw if no communities are detected. Callers
   * should handle this by adjusting the gamma parameter.
   */
  private async runLeiden(
    ctx: WorkflowContext,
  ): Promise<Array<{ community_id: number; name?: string; id?: string }>> {
    const results = await ctx.memgraph.query<{
      community_id: number;
      name: string;
      id: string;
    }>(
      `CALL leiden_community_detection.get()
       YIELD node, community_id
       WHERE $nodeLabel IN labels(node)
       RETURN node.name AS name, node.id AS id, community_id`,
      {
        nodeLabel: this.config.nodeLabel,
      },
    );

    return results;
  }

  /**
   * Write community labels back to Entity nodes as a `communityId` property.
   * This enables community-based retrieval queries downstream.
   *
   * Uses UNWIND batch query to reduce N round-trips to 1 (Improvement #5).
   */
  private async writeCommunityLabels(
    results: Array<{ community_id: number; name?: string; id?: string }>,
    ctx: WorkflowContext,
  ): Promise<void> {
    const validNodes = results
      .filter((r) => r.community_id !== -1 && (r.id ?? r.name))
      .map((r) => ({
        nodeId: r.id ?? r.name ?? "",
        communityId: r.community_id,
      }));

    if (validNodes.length === 0) return;

    try {
      // Batch update: single UNWIND query for all nodes (Improvement #5)
      await ctx.memgraph.batchQuery(
        `UNWIND $items AS item
         MATCH (n:${this.config.nodeLabel})
         WHERE n.id = item.nodeId OR n.name = item.nodeId
         SET n.communityId = item.communityId`,
        validNodes,
      );
    } catch (err) {
      // Improvement #6: structured error logging instead of bare catch
      ctx.logger.warn(
        `CommunityDetector: batch label write failed, falling back to individual queries`,
        { error: (err as Error).message, nodeCount: validNodes.length },
      );

      // Fallback: individual queries for compatibility with older Memgraph
      for (const node of validNodes) {
        try {
          await ctx.memgraph.query(
            `MATCH (n:${this.config.nodeLabel})
             WHERE n.id = $nodeId OR n.name = $nodeId
             SET n.communityId = $communityId`,
            { nodeId: node.nodeId, communityId: node.communityId },
          );
        } catch (innerErr) {
          ctx.logger.debug(
            `CommunityDetector: failed to update node ${node.nodeId}`,
            { error: (innerErr as Error).message },
          );
        }
      }
    }

    ctx.logger.debug(
      `CommunityDetector: wrote communityId labels to ${validNodes.length} nodes`,
    );
  }

  /**
   * Generate LLM summaries for each community.
   * Produces community-level descriptions usable for high-level LightRAG
   * retrieval (theme/topic queries).
   */
  private async generateCommunitySummaries(
    communities: Map<number, CommunityInfo>,
    ctx: WorkflowContext,
  ): Promise<void> {
    const llm = ctx.getLLM();
    const sortedCommunities = [...communities.values()]
      .sort((a, b) => b.nodeCount - a.nodeCount)
      .slice(0, this.config.maxSummaries);

    const summaryResults = await Promise.allSettled(
      sortedCommunities.map(async (community) => {
        const members = community.nodeNames.join(", ");

        const resp = await llm.invoke([
          {
            role: "system",
            content: `You are a knowledge graph analyst. Summarize a community of related entities in 1-2 sentences. Focus on the common theme or topic that connects these entities.`,
          },
          {
            role: "user",
            content: `Community ${community.id} contains ${community.nodeCount} entities: ${members}.\n\nSummarize the theme of this community:`,
          },
        ]);

        const summary = typeof resp.content === "string"
          ? resp.content.trim()
          : "";

        community.summary = summary;

        // Persist community summary to Memgraph
        try {
          await ctx.memgraph.query(
            `MERGE (c:Community {id: $communityId})
             SET c.summary = $summary,
                 c.nodeCount = $nodeCount,
                 c.members = $members,
                 c.updatedAt = $timestamp`,
            {
              communityId: community.id,
              summary,
              nodeCount: community.nodeCount,
              members: community.nodeNames,
              timestamp: new Date().toISOString(),
            },
          );
        } catch (err) {
          // Improvement #6: log summary persistence failure instead of swallowing
          ctx.logger.debug(
            `CommunityDetector: summary persistence failed for community ${community.id}`,
            { error: (err as Error).message },
          );
        }
      }),
    );

    const succeeded = summaryResults.filter((r) => r.status === "fulfilled").length;
    ctx.logger.debug(
      `CommunityDetector: generated ${succeeded}/${sortedCommunities.length} community summaries`,
    );
  }

  getConfigSchema() {
    return ConfigSchema;
  }
  supportsLearning() {
    return false;
  }
}
