/**
 * Conversation + Message API schemas.
 */
import { z } from "zod";

export const CreateConversationSchema = z.object({
  solutionId: z.string().uuid(),
  title: z.string().max(500).optional(),
  workflowName: z.string().max(200).optional(),
});

export const CreateMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  workflowId: z.string().optional(),
  workflowName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const StageTraceEntrySchema = z.object({
  stageId: z.string(),
  module: z.string(),
  durationMs: z.number(),
  status: z.string(),
});

export const UpdateMessageSchema = z.object({
  content: z.string().optional(),
  stageTrace: z.array(StageTraceEntrySchema).optional(),
  stageCount: z.number().optional(),
  durationMs: z.number().optional(),
  sources: z.array(z.string()).optional(),
  tokenUsage: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  workflowId: z.string().nullable().optional(),
  workflowName: z.string().nullable().optional(),
  stageTrace: z.string().nullable().optional(), // JSON stringified
  stageCount: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  sources: z.string().nullable().optional(), // JSON stringified
  tokenUsage: z.number().nullable().optional(),
  metadata: z.string().nullable().optional(), // JSON stringified
  createdAt: z.string(),
});

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  solutionId: z.string().uuid(),
  title: z.string(),
  workflowName: z.string().nullable().optional(),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});

export type CreateConversation = z.infer<typeof CreateConversationSchema>;
export type CreateMessage = z.infer<typeof CreateMessageSchema>;
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type StageTraceEntry = z.infer<typeof StageTraceEntrySchema>;
