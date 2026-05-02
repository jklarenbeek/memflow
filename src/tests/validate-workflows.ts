import { WorkflowEngine } from "../core/WorkflowEngine.js";
import fs from "node:fs/promises";
import path from "node:path";

const subDir = path.resolve("src/workflows/sub");
const exDir = path.resolve("src/workflows/examples");

for (const dir of [subDir, exDir]) {
  const files = await fs.readdir(dir);
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"));
      new WorkflowEngine(json); // Validates config + DAG
      console.log(`✅ ${f}`);
    } catch (err) {
      console.error(`❌ ${f}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
