/**
 * File Ingestion API — Phase 2
 *
 * Accepts file uploads via two modes:
 *   1. Tauri IPC path mode: JSON body { filePath, solutionId, format? }
 *   2. External server mode: multipart/form-data (file + solutionId)
 *
 * Auto-detects file format and routes to the appropriate parser pipeline:
 *   .pdf → PDFSpatialParser → S2Chunker → Embedder → ChunkIngestor → SimpleMem
 *   .docx → DOCXSpatialParser → S2Chunker → Embedder → ChunkIngestor → SimpleMem
 *   .md/.txt → MarkdownSpatialParser → S2Chunker → Embedder → ChunkIngestor → SimpleMem
 */

import { Hono } from "hono";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { tmpdir } from "os";
import { resolve, basename, normalize } from "path";
import { unlink } from "fs/promises";
import type { GlobalConfig } from "../../core/types.js";

const IngestPathSchema = z.object({
  filePath: z.string().min(1),
  solutionId: z.string().min(1),
  format: z.enum(["pdf", "docx", "md", "txt"]).optional(),
});

const SUPPORTED_EXTENSIONS = new Set(["pdf", "docx", "md", "txt", "markdown"]);

/**
 * Detect file format from extension
 */
function detectFormat(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (ext === "markdown") return "md";
  return SUPPORTED_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * Select parser module based on format
 */
function getParserModule(format: string): string {
  switch (format) {
    case "pdf": return "PDFSpatialParser";
    case "docx": return "DOCXSpatialParser";
    case "md":
    case "txt":
    default: return "MarkdownSpatialParser";
  }
}

export function createIngestionRouter(globalConfig: GlobalConfig): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // POST /ingest — File ingestion (path mode or multipart)
  // -------------------------------------------------------------------------
  app.post("/", async (c) => {
    let filePath = "";
    let isTempFile = false;
    try {
      const contentType = c.req.header("content-type") ?? "";

      let solutionId: string;
      let format: string;
      let filename: string;
      let skipMemory = false;

      if (contentType.includes("multipart/form-data")) {
        // ---- Multipart upload mode (external server) ----
        const formData = await c.req.formData();
        const file = formData.get("file");
        solutionId = formData.get("solutionId")?.toString() ?? "";
        skipMemory = formData.get("skipMemory")?.toString() === "true";

        if (!file || !(file instanceof File)) {
          return c.json({ success: false, error: "No file provided" }, 400);
        }
        if (!solutionId) {
          return c.json({ success: false, error: "solutionId is required" }, 400);
        }

        filename = file.name;
        const detectedFormat = detectFormat(filename);
        if (!detectedFormat) {
          return c.json({
            success: false,
            error: `Unsupported file type: ${filename}. Supported: .pdf, .docx, .md, .txt`,
          }, 400);
        }
        format = detectedFormat;

        // Write to a temp path for processing
        const tmpPath = resolve(tmpdir(), `ingestion_${uuidv4()}_${basename(filename)}`);
        filePath = tmpPath;
        isTempFile = true;
        const bytes = await file.arrayBuffer();
        await Bun.write(filePath, new Uint8Array(bytes));

      } else {
        // ---- Path mode (Tauri IPC / desktop) ----
        const raw = await c.req.json().catch(() => ({}));
        const parsed = IngestPathSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json({ success: false, error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
        }
        filePath = parsed.data.filePath;
        solutionId = parsed.data.solutionId;

        // Path traversal guard
        const normalizedPath = normalize(resolve(filePath));
        if (filePath.includes("..") || normalizedPath !== resolve(filePath)) {
          return c.json({ success: false, error: "Invalid file path: directory traversal not allowed" }, 400);
        }

        filename = basename(filePath);

        // Use explicit format or detect from extension
        format = parsed.data.format ?? detectFormat(filename) ?? "md";

        // Verify file exists
        const fileRef = Bun.file(filePath);
        const exists = await fileRef.exists();
        if (!exists) {
          return c.json({ success: false, error: `File not found: ${filePath}` }, 404);
        }
      }

      const ingestionId = uuidv4();
      const parserModule = getParserModule(format);

      // Build the ingestion workflow config
      // Pipeline: parse → chunk → embed → index → [store?]
      // SimpleMem (store) includes its own sub-workflow with FactExtractor,
      // DensityGate, SemanticSynthesis — no need for standalone extraction.
      const stages: Array<Record<string, unknown>> = [
        {
          id: "parse",
          module: parserModule,
          config: { filePath },
          next: "chunk",
        },
        {
          id: "chunk",
          module: "S2Chunker",
          config: { maxChunkSize: 1200, minChunkSize: 100 },
          next: "embed",
        },
        {
          id: "embed",
          module: "Embedder",
          config: {},
          next: "index",
        },
        {
          id: "index",
          module: "ChunkIngestor",
          config: {},
          next: skipMemory ? null : "store",
        },
      ];

      // Only include SimpleMem when full memory extraction is requested
      if (!skipMemory) {
        stages.push({
          id: "store",
          module: "SimpleMem",
          config: { category: "document", importance: 0.7 },
          next: null,
          workflowRef: "src/workflows/sub/simplemem-pipeline.json",
        });
      }

      const workflowConfig = {
        name: `ingest-${ingestionId}`,
        version: "1.0",
        entry: "parse",
        stages,
      };

      // Return the workflow config and ingestion ID
      // The client should use POST /workflow/run/stream with this config
      // to get SSE progress events
      return c.json({
        success: true,
        ingestionId,
        filename,
        format,
        parserModule,
        solutionId,
        workflow: workflowConfig,
        streamUrl: `/workflow/run/stream`,
        // Temp file path for cleanup after workflow execution
        tempFilePath: isTempFile ? filePath : undefined,
        note: "Use the returned workflow config with POST /workflow/run/stream to execute the ingestion pipeline with SSE progress tracking.",
      }, 201);
    } catch (err) {
      // Only clean up temp file on error (workflow never runs)
      if (isTempFile && filePath) {
        unlink(filePath).catch(() => { /* best-effort cleanup */ });
      }
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  return app;
}
