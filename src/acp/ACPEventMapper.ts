/**
 * ACP Event Mapper — translates WorkflowEventEmitter events into ACP session/update notifications
 */

import type { StreamEvent } from "../core/types.js";
import type { SessionUpdate } from "./ACPTypes.js";

export function mapEventToUpdate(event: StreamEvent): Omit<SessionUpdate["params"], "sessionId"> | null {
  switch (event.type) {
    case "workflow:start": {
      return {
        update: {
          sessionUpdate: "plan",
          entries: event.stages.map((s, i) => ({
            content: s,
            priority: "medium",
            status: i === 0 ? "in_progress" : "pending",
          })),
        },
      };
    }

    case "stage:start": {
      return {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.stageId,
          status: "in_progress",
        },
      };
    }

    case "stage:progress": {
      return {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.token },
        },
      };
    }

    case "stage:complete": {
      return {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.stageId,
          status: "completed",
          content: event.preview ? { type: "text", text: event.preview } : undefined,
        },
      };
    }

    case "stage:error": {
      return {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.stageId,
          status: "failed",
          content: { type: "text", text: event.error },
        },
      };
    }

    default:
      return null;
  }
}
