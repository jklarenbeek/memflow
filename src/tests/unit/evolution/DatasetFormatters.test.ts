/**
 * DatasetFormatters — unit tests
 */

import { describe, it, expect } from "bun:test";
import {
  formatSamples,
  toJSONL,
  generateManifest,
  type RawSample,
} from "../../../utils/datasetFormatters.js";

describe("DatasetFormatters", () => {
  const mockSamples: RawSample[] = [
    {
      type: "positive",
      instruction: "Analyze this",
      input: "Test input",
      output: "Good output",
      source: "test",
      confidence: 0.9,
    },
    {
      type: "negative",
      instruction: "Analyze this",
      input: "Test input",
      output: "Bad output",
      source: "test",
      confidence: 0.3,
    },
  ];

  it("should format SFT samples (only positive)", () => {
    const { sftSamples, dpoSamples } = formatSamples(mockSamples, "sft");
    expect(sftSamples.length).toBe(1);
    expect(sftSamples[0].instruction).toBe("Analyze this");
    expect(sftSamples[0].output).toBe("Good output");
    expect(dpoSamples.length).toBe(0);
  });

  it("should format DPO samples (paired positive/negative)", () => {
    const { sftSamples, dpoSamples } = formatSamples(mockSamples, "dpo");
    expect(sftSamples.length).toBe(0);
    expect(dpoSamples.length).toBe(1);
    expect(dpoSamples[0].chosen).toBe("Good output");
    expect(dpoSamples[0].rejected).toBe("Bad output");
  });

  it("should format both SFT and DPO in combined mode", () => {
    const { sftSamples, dpoSamples } = formatSamples(mockSamples, "both");
    expect(sftSamples.length).toBe(1);
    expect(dpoSamples.length).toBe(1);
  });

  it("should produce valid JSONL output", () => {
    const records = [{ a: 1 }, { b: 2 }];
    const jsonl = toJSONL(records);
    const lines = jsonl.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ b: 2 });
  });

  it("should generate a valid manifest", () => {
    const manifest = generateManifest(
      [{ instruction: "a", input: "b", output: "c" }],
      [],
      "/tmp/test",
    );
    expect(manifest.sftCount).toBe(1);
    expect(manifest.dpoCount).toBe(0);
    expect(manifest.outputDir).toBe("/tmp/test");
    expect(manifest.files).toContain("sft.jsonl");
    expect(manifest.files).toContain("manifest.json");
  });
});
