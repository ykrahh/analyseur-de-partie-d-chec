import express from "express";
import cors from "cors";
import os from "node:os";
import { EnginePool } from "./engine.js";

const PORT = process.env.PORT || 8791;
// Leave exactly one core free for the OS/UI; use the rest for Stockfish workers.
// (On Apple Silicon the "efficiency" cores are slower per-worker but still add
// real throughput, so there's no good reason to cap this low — analysis is a
// foreground task the user is actively waiting on.)
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length - 1, 15));
const DEFAULT_DEPTH = 18;

console.log(`Starting engine pool: ${POOL_SIZE} Stockfish workers (of ${os.cpus().length} cores)`);
const pool = new EnginePool({ size: POOL_SIZE, threadsPerEngine: 1, hash: 64, multiPv: 2 });

const app = express();
app.use(cors()); // local-only tool, reflecting any origin (incl. chrome-extension://<id>) is fine
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, poolSize: POOL_SIZE, cpus: os.cpus().length });
});

app.post("/analyze", async (req, res) => {
  const { fen, depth } = req.body || {};
  if (!fen) return res.status(400).json({ error: "missing fen" });
  try {
    const result = await pool.analyze(fen, depth || DEFAULT_DEPTH);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/analyze-batch", async (req, res) => {
  const { fens, depth } = req.body || {};
  if (!Array.isArray(fens) || fens.length === 0) {
    return res.status(400).json({ error: "missing fens[]" });
  }
  try {
    const results = await pool.analyzeBatch(fens, depth || DEFAULT_DEPTH);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Streams one NDJSON line per position, in COMPLETION order (not input order),
// the instant that position finishes — instead of /analyze-batch, which makes
// the caller wait for every position in the request before returning any of
// them. This keeps every worker in the pool continuously fed: nothing sits
// idle waiting for the slowest position in an arbitrary batch boundary.
app.post("/analyze-stream", (req, res) => {
  const { fens, depth } = req.body || {};
  if (!Array.isArray(fens) || fens.length === 0) {
    return res.status(400).json({ error: "missing fens[]" });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  const jobs = fens.map((fen, index) =>
    pool
      .analyze(fen, depth || DEFAULT_DEPTH)
      .then((result) => res.write(JSON.stringify({ index, result }) + "\n"))
      .catch((err) => res.write(JSON.stringify({ index, error: String(err) }) + "\n"))
  );
  Promise.all(jobs).then(() => res.end());
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Chess analyzer engine server listening on http://127.0.0.1:${PORT}`);
});

function shutdown() {
  console.log("Shutting down...");
  pool.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
