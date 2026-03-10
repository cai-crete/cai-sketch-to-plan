import { useState, useCallback, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';

const LS_KEY = 'gemini_api_key';

export type AuthMode = 'byok' | 'proxy';

export function useApiKey() {
  const [personalKey, setPersonalKey] = useState<string>(
    () => localStorage.getItem(LS_KEY) || ''
  );

  // Mode decision: Personal key or Build-time key -> BYOK, otherwise -> proxy
  // Note: process.env.GEMINI_API_KEY might be provided by Vite define
  const buildTimeKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || (window as any).process?.env?.GEMINI_API_KEY || '';
  const resolvedKey = personalKey || buildTimeKey;
  const authMode: AuthMode = resolvedKey ? 'byok' : 'proxy';

  const saveKey = useCallback((key: string) => {
    if (key) {
      localStorage.setItem(LS_KEY, key);
    } else {
      localStorage.removeItem(LS_KEY);
    }
    setPersonalKey(key);
  }, []);

  // Shared generation logic
  const generateContent = useCallback(
    async (params: { model: string; contents: any }) => {
      if (authMode === 'byok' && resolvedKey) {
        // Direct Client Mode
        const genAI = new GoogleGenAI(resolvedKey);
        const model = genAI.getGenerativeModel({ model: params.model });
        return await model.generateContent(params.contents);
      } else {
        // Server Proxy Mode (Vercel Serverless Functions)
        const endpoint = params.model.includes('image') ? 'image' : 'analysis';
        const res = await fetch(`/api/generate/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || 'Proxy request failed');
        }
        
        const data = await res.json();
        // The response format from the serverless function should match the SDK's response structure
        return data.response; 
      }
    },
    [authMode, resolvedKey]
  );

  return { 
    authMode, 
    personalKey, 
    resolvedKey, 
    saveKey, 
    generateContent 
  };
}
