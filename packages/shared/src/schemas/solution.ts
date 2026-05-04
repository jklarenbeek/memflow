/**
 * Solution API schemas — shared between server and desktop app.
 */
import { z } from "zod";

export const CreateSolutionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  domain: z.string().max(100).optional(),
  llmProvider: z.enum(["ollama", "openrouter", "openai"]).optional(),
  llmModel: z.string().max(200).optional(),
});

export const UpdateSolutionSchema = CreateSolutionSchema.partial();

export const SolutionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  domain: z.string(),
  llmProvider: z.string().nullable(),
  llmModel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
  stats: z.object({
    entityCount: z.number(),
    memoryCount: z.number(),
    conversationCount: z.number().optional(),
  }).optional(),
});

export type CreateSolution = z.infer<typeof CreateSolutionSchema>;
export type UpdateSolution = z.infer<typeof UpdateSolutionSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
