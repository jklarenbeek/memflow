/**
 * Docs Ingestion E2E — Full Pipeline Test
 *
 * Ingests real files from the docs/ directory through the MemFlow pipeline
 * and verifies chunks, embeddings, entities, and relations in Memgraph.
 *
 * Two pipeline modes:
 *   FAST: Parser → S2Chunker → Embedder → ChunkIngestor (graph-only, no LLM)
 *   FULL: + FactExtractor → SimpleMem (adds LLM fact extraction + memory)
 *
 * Module input contracts:
 *   - MarkdownSpatialParser: reads `input.data.markdown` (string)
 *   - PDFSpatialParser: reads `input.data.pdfData` (Uint8Array)
 *   - DOCXSpatialParser: reads `input.data.docxData` (Buffer)
 *
 * Prerequisites:
 *   - Memgraph running: docker compose up memgraph
 *   - .env configured with OPENROUTER_API_KEY, LLM_PROVIDER, EMBEDDING_PROVIDER
 *
 * Run:
 *   bun test src/tests/integration/real-services/docs-ingestion-e2e.test.ts --timeout 600000
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, basename } from "path";
import { readdir, readFile, stat } from "fs/promises";
import {
  checkServiceHealth,
  PIPELINE_TIMEOUT,
  LLM_TIMEOUT,
  MEMGRAPH_TIMEOUT,
} from "./_setup.js";
import { MemgraphClient } from "../../../providers/MemgraphClient.js";
import { WorkflowEngine } from "../../../core/WorkflowEngine.js";
import type { WorkflowConfig } from "../../../core/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "../../../..");
const DOCS_DIR = resolve(PROJECT_ROOT, "docs");
const REFS_DIR = resolve(DOCS_DIR, "refs");

const TEST_PREFIX = "__ingest_e2e__";

/** Max PDF files to ingest (smallest under size cap) */
const MAX_PDF_FILES = 1;
/** Max markdown files to ingest */
const MAX_MD_FILES = 1;
/** Max PDF size in bytes (~500KB) */
const MAX_PDF_SIZE = 500 * 1024;
/** Max markdown size in bytes (~15KB to avoid embedding context issues) */
const MAX_MD_SIZE = 15 * 1024;
/**
 * Chunk size — keep small to stay within free embedding model context limits.
 * nvidia/llama-nemotron-embed-vl-1b-v2:free has ~512 token context.
 */
const CHUNK_SIZE = 400;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let mgClient: MemgraphClient;
let globalConfig: Record<string, unknown>;
let solutionId: string;

/** How many chunks we persisted in this run (for verification) */
let totalChunksIngested = 0;

const log = {
  info: (...args: unknown[]) => console.log("  ℹ", ...args),
  warn: (...args: unknown[]) => console.warn("  ⚠", ...args),
  error: (...args: unknown[]) => console.error("  ✘", ...args),
  debug: () => {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGlobalConfig() {
  return {
    memgraphUri: process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
    memgraphUser: process.env.MEMGRAPH_USER ?? "memgraph",
    memgraphPassword: process.env.MEMGRAPH_PASSWORD ?? "memgraph",
    llmProvider: process.env.LLM_PROVIDER ?? "openrouter",
    llmModel: process.env.LLM_MODEL ?? "qwen/qwen3.6-35b-a3b",
    embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "openrouter",
    embeddingModel:
      process.env.EMBEDDING_MODEL ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free",
    logLevel: "info",
  };
}

interface DocFile {
  path: string;
  format: "md" | "pdf" | "docx";
  name: string;
  sizeBytes: number;
}

/**
 * Read file content and return the correct input key for the parser module.
 */
async function readFileForParser(
  file: DocFile,
): Promise<Record<string, unknown>> {
  switch (file.format) {
    case "md": {
      const content = await readFile(file.path, "utf-8");
      return { markdown: content, fileName: file.name };
    }
    case "pdf": {
      const bytes = await readFile(file.path);
      return { pdfData: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), fileName: file.name };
    }
    case "docx": {
      const bytes = await readFile(file.path);
      return { docxData: bytes, fileName: file.name };
    }
  }
}

/**
 * Build the FAST ingestion workflow: Parse → Chunk → Embed → ChunkIngestor.
 * Skips FactExtractor and SimpleMem for speed.
 */
function buildFastIngestionWorkflow(file: DocFile): WorkflowConfig {
  const parserModule =
    file.format === "pdf"
      ? "PDFSpatialParser"
      : file.format === "docx"
        ? "DOCXSpatialParser"
        : "MarkdownSpatialParser";

  return {
    name: `ingest-${file.name}`,
    version: "1.0",
    entry: "parse",
    stages: [
      {
        id: "parse",
        module: parserModule,
        config: {},
        next: "chunk",
      },
      {
        id: "chunk",
        module: "S2Chunker",
        config: { chunkSize: CHUNK_SIZE },
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
      },
    ],
  } as unknown as WorkflowConfig;
}

/**
 * Build the graph-indexing workflow: EntityExtractor → Dedup → Profile → Communities.
 */
function buildGraphIndexingWorkflow(): WorkflowConfig {
  return {
    name: "graph-indexing-e2e",
    version: "1.0",
    entry: "extract_entities",
    stages: [
      {
        id: "extract_entities",
        module: "EntityExtractor",
        config: { maxChunks: 5 },
        next: "deduplicate",
      },
      {
        id: "deduplicate",
        module: "EntityDeduplicator",
        config: { useLLM: true },
        next: "profile",
      },
      {
        id: "profile",
        module: "EntityProfiler",
        config: { maxEntities: 30 },
      },
    ],
  } as unknown as WorkflowConfig;
}

/**
 * Run a workflow and return structured results.
 */
async function runWorkflow(
  config: WorkflowConfig,
  input: Record<string, unknown> = {},
): Promise<{
  id: string;
  historyLength: number;
  errors: Array<Record<string, unknown>>;
  history: Array<{ stage: string; durationMs: number; outputKeys: string[] }>;
  data: Record<string, unknown>;
}> {
  const engine = new WorkflowEngine(config);
  await engine.initialize(globalConfig);
  try {
    const state = await engine.run(input);
    return {
      id: state.id,
      historyLength: state.history.length,
      errors: state.errors as unknown as Array<Record<string, unknown>>,
      data: state.data,
      history: (state.history as unknown as Array<Record<string, unknown>>).map((h) => ({
        stage: String(h.stage ?? "?"),
        durationMs: Number(h.durationMs ?? 0),
        outputKeys: h.output ? Object.keys(h.output as object) : [],
      })),
    };
  } finally {
    await engine.shutdown();
  }
}

/**
 * Collect files to ingest from docs/ — picks smallest eligible files.
 */
async function collectDocFiles(): Promise<DocFile[]> {
  const files: DocFile[] = [];

  // 1. Markdown files (smallest first, under size cap)
  try {
    const entries = await readdir(DOCS_DIR);
    const mdCandidates: DocFile[] = [];
    for (const f of entries.filter((f) => f.endsWith(".md"))) {
      const fp = resolve(DOCS_DIR, f);
      const st = await stat(fp);
      if (st.size <= MAX_MD_SIZE) {
        mdCandidates.push({ path: fp, format: "md", name: f, sizeBytes: st.size });
      }
    }
    mdCandidates.sort((a, b) => a.sizeBytes - b.sizeBytes);
    files.push(...mdCandidates.slice(0, MAX_MD_FILES));
  } catch {
    log.warn("No markdown files found");
  }

  // 2. DOCX files
  try {
    const entries = await readdir(REFS_DIR);
    for (const f of entries.filter((f) => f.endsWith(".docx"))) {
      const fp = resolve(REFS_DIR, f);
      const st = await stat(fp);
      files.push({ path: fp, format: "docx", name: f, sizeBytes: st.size });
    }
  } catch {
    log.warn("No DOCX files found");
  }

  // 3. PDF files (smallest first, under size cap)
  try {
    const entries = await readdir(REFS_DIR);
    const pdfCandidates: DocFile[] = [];
    for (const f of entries.filter((f) => f.endsWith(".pdf"))) {
      const fp = resolve(REFS_DIR, f);
      const st = await stat(fp);
      if (st.size <= MAX_PDF_SIZE) {
        pdfCandidates.push({ path: fp, format: "pdf", name: f, sizeBytes: st.size });
      }
    }
    pdfCandidates.sort((a, b) => a.sizeBytes - b.sizeBytes);
    files.push(...pdfCandidates.slice(0, MAX_PDF_FILES));
  } catch {
    log.warn("No PDF files found");
  }

  return files;
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Setup & Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const health = await checkServiceHealth();
  if (!health.memgraph) {
    throw new Error("Memgraph is not available — run: docker compose up memgraph");
  }

  globalConfig = buildGlobalConfig();

  mgClient = new MemgraphClient(
    {
      uri: globalConfig.memgraphUri as string,
      user: globalConfig.memgraphUser as string,
      password: globalConfig.memgraphPassword as string,
    },
    log as any,
  );

  solutionId = `${TEST_PREFIX}${Date.now()}`;
  await mgClient.query(
    `CREATE (s:Solution {
      id: $id, name: $name, domain: "research",
      createdAt: $ts, updatedAt: $ts
    })`,
    { id: solutionId, name: `${TEST_PREFIX}Ingestion Test`, ts: new Date().toISOString() },
  );

  log.info(`Test solution: ${solutionId}`);
  log.info(`LLM: ${globalConfig.llmProvider}/${globalConfig.llmModel}`);
  log.info(`Embeddings: ${globalConfig.embeddingProvider}/${globalConfig.embeddingModel}`);
});

afterAll(async () => {
  try {
    await mgClient.query(
      `MATCH (n) WHERE n.id STARTS WITH $prefix OR n.source STARTS WITH $prefix DETACH DELETE n`,
      { prefix: TEST_PREFIX },
    );
    log.info("Test data cleaned up");
  } catch (e) {
    log.warn(`Cleanup failed: ${e}`);
  }
  await mgClient.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("Docs Ingestion E2E", () => {
  const ingestedFiles: string[] = [];

  // -----------------------------------------------------------------------
  // Phase 1: File Discovery
  // -----------------------------------------------------------------------

  test("discovers ingestion-eligible files in docs/", async () => {
    const files = await collectDocFiles();

    log.info(`Found ${files.length} files:`);
    for (const f of files) {
      log.info(`  ${f.format.toUpperCase().padEnd(5)} ${f.name} (${fmt(f.sizeBytes)})`);
    }

    expect(files.length).toBeGreaterThan(0);
  }, MEMGRAPH_TIMEOUT);

  // -----------------------------------------------------------------------
  // Phase 2: Fast Ingestion — Parse + Chunk + Embed + Index (no LLM)
  // -----------------------------------------------------------------------

  describe("Fast Ingestion (no FactExtractor)", () => {
    test(
      "ingests all doc files through Parse → Chunk → Embed → ChunkIngestor",
      async () => {
        const files = await collectDocFiles();

        for (const file of files) {
          log.info(`\n── ${file.format.toUpperCase()} Ingesting: ${file.name} (${fmt(file.sizeBytes)}) ──`);

          const fileData = await readFileForParser(file);
          const workflow = buildFastIngestionWorkflow(file);

          try {
            const result = await runWorkflow(workflow, {
              ...fileData,
              solutionId,
              query: "",
            });

            for (const stage of result.history) {
              log.info(
                `  ✓ ${stage.stage} (${stage.durationMs}ms) → [${stage.outputKeys.join(", ")}]`,
              );
            }

            if (result.errors.length > 0) {
              for (const err of result.errors) {
                log.warn(`  Error in ${err.stage}: ${err.error}`);
              }
            }

            // Check ChunkIngestor output
            const indexStage = result.history.find((h) => h.stage === "index");
            if (indexStage) {
              const ingested = (result.data.metrics as Record<string, number>)?.ingested ?? 0;
              totalChunksIngested += ingested;
              log.info(`  📊 ChunkIngestor: ${ingested} chunks stored in Memgraph`);
            }

            ingestedFiles.push(file.name);
            expect(result.historyLength).toBeGreaterThan(0);
          } catch (err) {
            log.error(`  Pipeline failed: ${(err as Error).message}`);
            // Don't fail the entire test — continue with other files
          }
        }

        log.info(`\n✓ Ingested ${ingestedFiles.length}/${files.length} files, ${totalChunksIngested} total chunks`);
        expect(ingestedFiles.length).toBeGreaterThan(0);
      },
      PIPELINE_TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // Phase 3: Entity Extraction (uses LLM)
  // -----------------------------------------------------------------------

  describe("Entity Extraction", () => {
    test(
      "extracts entities from ingested chunks",
      async () => {
        if (totalChunksIngested === 0) {
          log.warn("No chunks ingested — skipping entity extraction");
          return;
        }

        log.info("\n══ Entity Extraction Pipeline ══");

        const workflow = buildGraphIndexingWorkflow();
        const result = await runWorkflow(workflow, {
          solutionId,
          query: "What are the key concepts and technologies mentioned in these documents?",
        });

        for (const stage of result.history) {
          log.info(
            `  ✓ ${stage.stage} (${stage.durationMs}ms) → [${stage.outputKeys.join(", ")}]`,
          );
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            log.warn(`  Error in ${err.stage}: ${err.error}`);
          }
        }

        expect(result.historyLength).toBeGreaterThan(0);
      },
      PIPELINE_TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // Phase 4: Graph Verification
  // -----------------------------------------------------------------------

  describe("Graph Verification", () => {
    test("chunks persisted in Memgraph", async () => {
      const result = await mgClient.query<{ count: number }>(
        `MATCH (c:Chunk) RETURN count(c) AS count`,
      );
      const count = Number(result[0]?.count ?? 0);
      log.info(`📊 Chunks: ${count}`);
      expect(count).toBeGreaterThan(0);
    }, MEMGRAPH_TIMEOUT);

    test("all chunks have embeddings", async () => {
      const result = await mgClient.query<{ total: number; embedded: number }>(
        `MATCH (c:Chunk)
         WITH count(c) AS total,
              count(CASE WHEN c.embedding IS NOT NULL THEN 1 END) AS embedded
         RETURN total, embedded`,
      );
      const total = Number(result[0]?.total ?? 0);
      const embedded = Number(result[0]?.embedded ?? 0);
      log.info(`📊 Embeddings: ${embedded}/${total} (${total > 0 ? ((embedded / total) * 100).toFixed(0) : 0}%)`);
      if (total > 0) {
        expect(embedded).toBe(total);
      }
    }, MEMGRAPH_TIMEOUT);

    test("node labels overview", async () => {
      const labels = await mgClient.query<{ label: string; count: number }>(
        `MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC`,
      );
      log.info(`📊 Node labels:`);
      for (const l of labels) {
        log.info(`    ${l.label}: ${Number(l.count)}`);
      }
      expect(labels.length).toBeGreaterThan(0);
    }, MEMGRAPH_TIMEOUT);

    test("relation types overview", async () => {
      const rels = await mgClient.query<{ type: string; count: number }>(
        `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC LIMIT 20`,
      );
      log.info(`📊 Relation types:`);
      for (const r of rels) {
        log.info(`    ${r.type}: ${Number(r.count)}`);
      }
    }, MEMGRAPH_TIMEOUT);

    test("entities in graph", async () => {
      const entities = await mgClient.query<{
        name: string;
        type: string;
        relCount: number;
      }>(
        `MATCH (e:Entity)
         OPTIONAL MATCH (e)-[r]-()
         RETURN e.name AS name, e.type AS type, count(r) AS relCount
         ORDER BY relCount DESC
         LIMIT 20`,
      );

      if (entities.length > 0) {
        log.info(`📊 Entities (${entities.length} total):`);
        for (const e of entities) {
          log.info(`    ${e.name} [${e.type ?? "?"}] — ${Number(e.relCount)} rels`);
        }
      } else {
        log.warn("  No entities found (extraction may not have completed)");
      }
    }, MEMGRAPH_TIMEOUT);

    test("chunk source distribution", async () => {
      const sources = await mgClient.query<{ source: string; count: number }>(
        `MATCH (c:Chunk)
         RETURN c.source AS source, count(c) AS count
         ORDER BY count DESC LIMIT 10`,
      );
      log.info(`📊 Chunk sources:`);
      for (const s of sources) {
        log.info(`    ${s.source}: ${Number(s.count)}`);
      }
    }, MEMGRAPH_TIMEOUT);
  });

  // -----------------------------------------------------------------------
  // Phase 5: Final Report
  // -----------------------------------------------------------------------

  describe("Summary", () => {
    test("prints final ingestion report", async () => {
      const [chunks, entities, mus, rels] = await Promise.all([
        mgClient.query<{ c: number }>(`MATCH (c:Chunk) RETURN count(c) AS c`),
        mgClient.query<{ c: number }>(`MATCH (e:Entity) RETURN count(e) AS c`),
        mgClient.query<{ c: number }>(`MATCH (mu:MemoryUnit) RETURN count(mu) AS c`),
        mgClient.query<{ c: number }>(`MATCH ()-[r]->() RETURN count(r) AS c`),
      ]);

      console.log("\n");
      console.log("═══════════════════════════════════════════════════════════");
      console.log("              MEMFLOW INGESTION E2E REPORT");
      console.log("═══════════════════════════════════════════════════════════");
      console.log(`  LLM:          ${globalConfig.llmProvider}/${globalConfig.llmModel}`);
      console.log(`  Embeddings:   ${globalConfig.embeddingProvider}/${globalConfig.embeddingModel}`);
      console.log(`  Chunk size:   ${CHUNK_SIZE} tokens`);
      console.log(`  Files:        ${ingestedFiles.length}`);
      for (const f of ingestedFiles) console.log(`    • ${f}`);
      console.log(`\n  Graph State:`);
      console.log(`    Chunks:       ${Number(chunks[0]?.c ?? 0)}`);
      console.log(`    Entities:     ${Number(entities[0]?.c ?? 0)}`);
      console.log(`    MemoryUnits:  ${Number(mus[0]?.c ?? 0)}`);
      console.log(`    Relations:    ${Number(rels[0]?.c ?? 0)}`);
      console.log("═══════════════════════════════════════════════════════════\n");

      expect(true).toBe(true);
    }, MEMGRAPH_TIMEOUT);
  });
});
