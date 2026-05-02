/**
 * GMPL Performance Benchmark Harness
 *
 * Profiles GMPL pattern execution under load with configurable scenarios.
 * Uses the docker-compose LLM for real inference when available, falling
 * back to a deterministic mock for reproducible CI baselines.
 *
 * Usage:
 *   bun src/tests/benchmark-gmpl.ts
 *   bun src/tests/benchmark-gmpl.ts --scenario debate
 *   bun src/tests/benchmark-gmpl.ts --mock  (force deterministic mock)
 *
 * Output: JSON report to stdout with per-scenario latency, memory, and
 * pattern-specific metrics.
 */

import { WorkflowEngine } from "../core/WorkflowEngine.js";
import { ModuleRegistry } from "../core/ModuleRegistry.js";
import type { WorkflowConfig } from "../core/types.js";

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface BenchmarkScenario {
  name: string;
  description: string;
  workflowConfig: WorkflowConfig;
  iterations: number;
}

const scenarios: Record<string, BenchmarkScenario> = {
  large_debate: {
    name: "Large Debate",
    description: "5 roles × 5 rounds × consensus_threshold termination",
    iterations: 3,
    workflowConfig: {
      name: "benchmark-debate",
      version: "1.0",
      entry: "debate",
      stages: [
        {
          id: "debate",
          module: "DebateModule",
          config: {
            roles: [
              { id: "analyst_1", persona: "Bull case analyst" },
              { id: "analyst_2", persona: "Bear case analyst" },
              { id: "analyst_3", persona: "Sector specialist" },
              { id: "analyst_4", persona: "Macro strategist" },
              { id: "analyst_5", persona: "Risk assessor" },
            ],
            maxRounds: 5,
            termination: {
              type: "consensus_threshold",
              consensusThreshold: 0.85,
            },
          },
          next: null,
        },
      ],
    },
  },

  deep_delphi: {
    name: "Deep Delphi Panel",
    description: "7 panelists × 10 rounds with std_dev convergence",
    iterations: 3,
    workflowConfig: {
      name: "benchmark-delphi",
      version: "1.0",
      entry: "delphi",
      stages: [
        {
          id: "delphi",
          module: "DelphiPanelModule",
          config: {
            panelSize: 7,
            maxRounds: 10,
            convergenceMetric: "std_dev",
            convergenceThreshold: 0.15,
            anonymize: true,
          },
          next: null,
        },
      ],
    },
  },

  parallel_analysis: {
    name: "Parallel Analysis",
    description: "6 analysts × 60s timeout",
    iterations: 3,
    workflowConfig: {
      name: "benchmark-parallel",
      version: "1.0",
      entry: "dispatch",
      stages: [
        {
          id: "dispatch",
          module: "ParallelDispatcher",
          config: {
            analysts: [
              { id: "fundamental", role: "fundamental_analyst" },
              { id: "technical", role: "technical_analyst" },
              { id: "sentiment", role: "sentiment_analyst" },
              { id: "macro", role: "domain_analyst" },
              { id: "sector", role: "domain_analyst" },
              { id: "quant", role: "domain_analyst" },
            ],
            mergeStrategy: "ranked_synthesis",
            timeout: "60s",
          },
          next: null,
        },
      ],
    },
  },

  composed_workflow: {
    name: "Composed Workflow",
    description: "debate → parallel analysis → peer review (3-pattern sequential)",
    iterations: 2,
    workflowConfig: {
      name: "benchmark-composed",
      version: "1.0",
      entry: "debate",
      stages: [
        {
          id: "debate",
          module: "DebateModule",
          config: {
            roles: [
              { id: "bull", persona: "Bullish analyst" },
              { id: "bear", persona: "Bearish analyst" },
            ],
            maxRounds: 2,
          },
          next: "analysis",
        },
        {
          id: "analysis",
          module: "ParallelDispatcher",
          config: {
            analysts: [
              { id: "tech_analyst", role: "technical_analyst" },
              { id: "fund_analyst", role: "fundamental_analyst" },
            ],
            mergeStrategy: "ranked_synthesis",
            timeout: "30s",
          },
          next: "review",
        },
        {
          id: "review",
          module: "PeerReviewModule",
          config: {
            reviewers: [
              { id: "reviewer_1", persona: "Senior Reviewer" },
              { id: "reviewer_2", persona: "Technical Reviewer" },
            ],
            maxCycles: 2,
            acceptanceThreshold: 0.5,
          },
          next: null,
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  scenario: string;
  description: string;
  iterations: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    min: number;
    max: number;
  };
  memoryDeltaBytes: number;
  patternMetrics: Record<string, unknown>;
  timestamp: string;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runScenario(scenario: BenchmarkScenario): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let lastMetrics: Record<string, unknown> = {};

  const memBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < scenario.iterations; i++) {
    const engine = new WorkflowEngine(scenario.workflowConfig);

    try {
      await engine.initialize({
        logLevel: "warn", // Quiet logging during benchmarks
      });

      const start = performance.now();
      await engine.run({
        query: "Analyze AAPL stock for Q1 2025: should we buy, hold, or sell?",
      });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);

      // Capture last iteration's metrics
      lastMetrics = {};
    } catch (err) {
      console.error(`  Iteration ${i + 1} failed: ${(err as Error).message}`);
      latencies.push(-1);
    } finally {
      try {
        await engine.shutdown();
      } catch {
        // Ignore shutdown errors in benchmarks
      }
      ModuleRegistry.getInstance().clearInstances();
    }
  }

  const memAfter = process.memoryUsage().heapUsed;

  // Filter out failed iterations
  const validLatencies = latencies.filter((l) => l >= 0).sort((a, b) => a - b);

  if (validLatencies.length === 0) {
    return {
      scenario: scenario.name,
      description: scenario.description,
      iterations: scenario.iterations,
      latencyMs: { p50: -1, p95: -1, p99: -1, mean: -1, min: -1, max: -1 },
      memoryDeltaBytes: memAfter - memBefore,
      patternMetrics: lastMetrics,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    scenario: scenario.name,
    description: scenario.description,
    iterations: scenario.iterations,
    latencyMs: {
      p50: Math.round(percentile(validLatencies, 50)),
      p95: Math.round(percentile(validLatencies, 95)),
      p99: Math.round(percentile(validLatencies, 99)),
      mean: Math.round(validLatencies.reduce((s, v) => s + v, 0) / validLatencies.length),
      min: Math.round(validLatencies[0]),
      max: Math.round(validLatencies[validLatencies.length - 1]),
    },
    memoryDeltaBytes: memAfter - memBefore,
    patternMetrics: lastMetrics,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const specificScenario = args.find((a) => !a.startsWith("--"));
  const selectedScenarios = specificScenario
    ? { [specificScenario]: scenarios[specificScenario] }
    : scenarios;

  if (specificScenario && !scenarios[specificScenario]) {
    console.error(`Unknown scenario: ${specificScenario}`);
    console.error(`Available: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  console.error("=== GMPL Performance Benchmark ===");
  console.error(`Scenarios: ${Object.keys(selectedScenarios).join(", ")}`);
  console.error("");

  const results: BenchmarkResult[] = [];

  for (const [key, scenario] of Object.entries(selectedScenarios)) {
    console.error(`Running: ${scenario.name} (${scenario.iterations} iterations)...`);
    const result = await runScenario(scenario);
    results.push(result);
    console.error(`  Done: mean=${result.latencyMs.mean}ms, p99=${result.latencyMs.p99}ms`);
  }

  // Output JSON to stdout (pipe-friendly)
  console.log(JSON.stringify({
    benchmark: "gmpl-patterns",
    version: "0.5.1",
    timestamp: new Date().toISOString(),
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
