/**
 * Workflow catalog API schemas.
 */
import { z } from "zod";

export const WorkflowCatalogEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  category: z.enum(["example", "sub", "service"]),
  entry: z.string(),
  stageCount: z.number(),
  stages: z.array(z.string()),
  filePath: z.string(),
});

export type WorkflowCatalogEntry = z.infer<typeof WorkflowCatalogEntrySchema>;
