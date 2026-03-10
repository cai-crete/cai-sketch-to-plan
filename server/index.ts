import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '20mb' }));

const serverKey = process.env.GEMINI_API_KEY;

// POST /api/generate — Gemini API proxy
app.post('/api/generate', async (req, res) => {
  if (!serverKey) {
    return res.status(503).json({ error: 'No GEMINI_API_KEY configured on server' });
  }
  const { model, contents } = req.body;
  if (!model || !contents) {
    return res.status(400).json({ error: 'Missing required fields: model, contents' });
  }
  const ai = new GoogleGenAI({ apiKey: serverKey });
  try {
    const result = await ai.models.generateContent({ model, contents });
    res.json(result);
  } catch (err: any) {
    console.error('[Proxy Error]', err?.message);
    res.status(500).json({ error: err?.message || 'Proxy request failed' });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: !!serverKey });
});

// Production: serve Vite build
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) =>
    res.sendFile(path.join(distPath, 'index.html'))
  );
}

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => console.log(`[Server] Running on http://localhost:${PORT}`));
