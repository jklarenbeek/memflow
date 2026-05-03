/**
 * Dataset Formatters — SFT / DPO sample conversion utilities
 *
 * Pure functions with zero module dependencies. Used by
 * SLMDatasetExporterModule to convert raw experience samples
 * into standard fine-tuning dataset formats.
 *
 * Formats:
 *  - SFT (Supervised Fine-Tuning): instruction / input / output triples
 *  - DPO (Direct Preference Optimization): prompt / chosen / rejected triples
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawSample {
  type: "positive" | "negative";
  instruction: string;
  input: string;
  output: string;
  source: string;
  confidence: number;
}

export interface SFTSample {
  instruction: string;
  input: string;
  output: string;
}

export interface DPOSample {
  prompt: string;
  chosen: string;
  rejected: string;
}

export interface DatasetManifest {
  exportedAt: string;
  sftCount: number;
  dpoCount: number;
  sources: Record<string, number>;
  qualityFilters: {
    minConfidence: number;
    deduplicationThreshold: number;
    retrospectiveValidation: boolean;
  };
  outputDir: string;
  files: string[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Convert raw samples into SFT and/or DPO format.
 *
 * - SFT: only positive samples are included (instruction-following examples)
 * - DPO: pairs positive (chosen) with negative (rejected) from the same source
 */
export function formatSamples(
  samples: RawSample[],
  format: "sft" | "dpo" | "both",
): { sftSamples: SFTSample[]; dpoSamples: DPOSample[] } {
  const sftSamples: SFTSample[] = [];
  const dpoSamples: DPOSample[] = [];

  if (format === "sft" || format === "both") {
    for (const s of samples.filter((s) => s.type === "positive")) {
      sftSamples.push({
        instruction: s.instruction,
        input: s.input,
        output: s.output,
      });
    }
  }

  if (format === "dpo" || format === "both") {
    // Pair positive and negative samples by source for contrastive pairing
    const positives = samples.filter((s) => s.type === "positive");
    const negatives = samples.filter((s) => s.type === "negative");

    for (const neg of negatives) {
      // Find a positive sample from the same source for contrastive pairing
      const pos = positives.find((p) => p.source === neg.source);
      if (pos) {
        dpoSamples.push({
          prompt: neg.instruction + "\n" + neg.input,
          chosen: pos.output,
          rejected: neg.output,
        });
      }
    }
  }

  return { sftSamples, dpoSamples };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an array of records as JSONL (one JSON object per line).
 */
export function toJSONL(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Generate a dataset manifest with statistics and quality filter metadata.
 */
export function generateManifest(
  sft: SFTSample[],
  dpo: DPOSample[],
  exportPath: string,
  qualityFilters?: {
    minConfidence: number;
    deduplicationThreshold: number;
    retrospectiveValidation: boolean;
  },
): DatasetManifest {
  // Count sources from samples (we don't have source info in formatted samples,
  // so the manifest reports aggregate counts)
  const files: string[] = [];
  if (sft.length > 0) files.push("sft.jsonl");
  if (dpo.length > 0) files.push("dpo.jsonl");
  files.push("manifest.json");

  return {
    exportedAt: new Date().toISOString(),
    sftCount: sft.length,
    dpoCount: dpo.length,
    sources: {},
    qualityFilters: qualityFilters ?? {
      minConfidence: 0.6,
      deduplicationThreshold: 0.92,
      retrospectiveValidation: true,
    },
    outputDir: exportPath,
    files,
  };
}
