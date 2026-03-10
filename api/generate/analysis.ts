import { GoogleGenAI } from '@google/genai';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'Server API key not configured' });
    }

    const { model: modelName, contents } = req.body;

    try {
        const genAI = new GoogleGenAI({ apiKey });
        const model = (genAI as any).getGenerativeModel({ model: modelName });
        const result = await model.generateContent(contents);
        const response = await result.response;

        // We return the full response object to match the SDK expectation in useApiKey.ts
        return res.status(200).json({ response });
    } catch (error: any) {
        console.error('Analysis Proxy Error:', error);
        return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
}
