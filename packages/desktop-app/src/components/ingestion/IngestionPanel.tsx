import './Ingestion.css';
/**
 * IngestionPanel — Layout wrapper for the Ingestion tab
 *
 * Composes DropZone, FileQueue, and IngestionResults
 * into the full File Ingestion view.
 */
import { DropZone } from "./DropZone";
import { FileQueue } from "./FileQueue";
import { IngestionResults } from "./IngestionResults";

export function IngestionPanel() {
  return (
    <div className="ingestion-panel">
      <DropZone />
      <FileQueue />
      <IngestionResults />
    </div>
  );
}
