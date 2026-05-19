import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import benchmarkRouter from './routes.js';
import { markOrphansAsAborted } from './storage.js';

const app = express();
const port = Number(process.env.BENCHMARK_PORT ?? 3001);

app.use(express.json({ limit: '16mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'benchmark-arena' });
});

app.use('/v1/benchmark', benchmarkRouter);

// Servir frontend buildado (web/dist) na raiz, se existir
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDist = path.resolve(__dirname, '..', 'web', 'dist');
app.use(express.static(webDist));

app.get(/^\/(?!v1|health).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(port, () => {
  console.log(`Benchmark Arena listening on http://localhost:${port}`);
  void markOrphansAsAborted().catch((err) => {
    console.warn('[bench] markOrphansAsAborted failed:', err);
  });
});
