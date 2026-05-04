/**
 * useWorkflowStream — SSE hook for streaming workflow execution with persist-first semantics
 */
import { useState, useCallback, useRef } from "react";
import { api } from "../lib/api";
import { useChatStore, type StageStatus } from "../stores/chatStore";

interface RunOptions {
  workflow: Record<string, unknown>;
  input: Record<string, unknown>;
  solutionId: string;
  conversationId: string;
}

export function useWorkflowStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [stages, setStages] = useState<StageStatus[]>([]);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { addMessage, updateMessage, appendToken, resetTokens, setStreaming } = useChatStore();

  const run = useCallback(async (options: RunOptions) => {
    const { workflow, input, conversationId } = options;

    setIsStreaming(true);
    setStreaming(true);
    setStages([]);
    setCurrentStage(null);
    setError(null);
    resetTokens();

    // 1. Persist user message
    const userMsg = await api.addMessage(conversationId, {
      role: "user", content: input.query as string,
    });
    const userMsgId = (userMsg.message as { id: string }).id;
    addMessage({
      id: userMsgId, role: "user", content: input.query as string,
      createdAt: new Date().toISOString(),
    });

    // 2. Persist placeholder assistant message
    const assistantMsg = await api.addMessage(conversationId, {
      role: "assistant", content: "", workflowName: (workflow as { name?: string }).name,
    });
    const assistantMsgId = (assistantMsg.message as { id: string }).id;
    addMessage({
      id: assistantMsgId, role: "assistant", content: "", isStreaming: true,
      workflowName: (workflow as { name?: string }).name,
      stages: [], createdAt: new Date().toISOString(),
    });

    // 3. Stream workflow execution via fetch + ReadableStream
    const abortController = new AbortController();
    abortRef.current = abortController;
    let finalContent = "";
    const stageTrace: { stageId: string; module: string; durationMs: number; status: string }[] = [];

    try {
      const res = await fetch(api.getStreamUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, input }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            switch (event.type) {
              case "workflow:start":
                setStages(event.stages.map((s: string) => ({ id: s, module: s, status: "pending" as const })));
                updateMessage(assistantMsgId, {
                  stages: event.stages.map((s: string) => ({ id: s, module: s, status: "pending" as const })),
                });
                break;
              case "stage:start":
                setCurrentStage(event.stageId);
                setStages((prev) => prev.map((s) =>
                  s.id === event.stageId ? { ...s, status: "running", module: event.module } : s));
                updateMessage(assistantMsgId, { currentStageId: event.stageId });
                break;
              case "stage:progress":
                appendToken(event.token);
                finalContent += event.token;
                updateMessage(assistantMsgId, { content: finalContent });
                break;
              case "stage:complete":
                setStages((prev) => prev.map((s) =>
                  s.id === event.stageId ? { ...s, status: "complete", durationMs: event.durationMs } : s));
                stageTrace.push({ stageId: event.stageId, module: event.module, durationMs: event.durationMs, status: "complete" });
                break;
              case "stage:error":
                setStages((prev) => prev.map((s) =>
                  s.id === event.stageId ? { ...s, status: "error", error: event.error } : s));
                stageTrace.push({ stageId: event.stageId, module: event.module, durationMs: 0, status: "error" });
                break;
              case "workflow:complete":
                if (event.finalAnswer) finalContent = event.finalAnswer;
                updateMessage(assistantMsgId, {
                  content: finalContent, isStreaming: false, collapsed: true,
                  stageTrace, sources: event.sources, durationMs: event.totalDurationMs,
                });
                break;
              case "workflow:error":
                setError(event.error);
                updateMessage(assistantMsgId, { content: `Error: ${event.error}`, isStreaming: false });
                break;
            }
          } catch { /* skip unparseable events */ }
        }
      }

      // 5. Persist final audit trail
      await api.updateMessage(conversationId, assistantMsgId, {
        content: finalContent, stageTrace, durationMs: stageTrace.reduce((sum, s) => sum + s.durationMs, 0),
      }).catch(() => {});
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
        updateMessage(assistantMsgId, { content: `Error: ${(err as Error).message}`, isStreaming: false });
      }
    } finally {
      setIsStreaming(false);
      setStreaming(false);
      abortRef.current = null;
    }
  }, [addMessage, updateMessage, appendToken, resetTokens, setStreaming]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { run, cancel, isStreaming, stages, currentStage, error };
}
