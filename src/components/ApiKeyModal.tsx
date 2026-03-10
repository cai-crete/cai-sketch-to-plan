import React, { useState } from 'react';
import { X, Eye, EyeOff, Check } from 'lucide-react';
import type { AuthMode } from '../hooks/useApiKey';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentKey: string;
  authMode: AuthMode;
  onSave: (key: string) => void;
}

export default function ApiKeyModal({
  isOpen,
  onClose,
  currentKey,
  authMode,
  onSave,
}: ApiKeyModalProps) {
  const [input, setInput] = useState(currentKey);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(input);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleRemove = () => {
    setInput('');
    onSave('');
  };

  return (
    <div className="absolute inset-0 z-[60] bg-bw-white dark:bg-bw-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0 border-b border-bw-black/10 dark:border-bw-white/10">
        <h2 className="font-display text-xl tracking-wide">API KEY</h2>
        <button onClick={onClose} className="hover:opacity-60 transition-opacity">
          <X size={24} strokeWidth={1.5} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col p-6 gap-6 max-w-lg">
        {/* Current Mode */}
        <div className="flex items-center gap-3">
          <span
            className={`w-2 h-2 rounded-full ${
              authMode === 'byok' ? 'bg-green-500' : 'bg-blue-500'
            }`}
          />
          <span className="font-mono text-sm opacity-70">
            {authMode === 'byok' ? 'BYOK — 개인 키 사용 중' : 'PROXY — 서버 프록시 사용 중'}
          </span>
        </div>

        {/* Key Input */}
        <div className="flex flex-col gap-2">
          <label className="font-display text-sm tracking-wide opacity-60">
            GEMINI API KEY
          </label>
          <div className="flex items-center border border-bw-black/20 dark:border-bw-white/20">
            <input
              type={showKey ? 'text' : 'password'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="AIza..."
              className="flex-1 px-4 py-3 font-mono text-sm bg-transparent outline-none placeholder:opacity-30"
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="px-3 opacity-40 hover:opacity-80 transition-opacity"
              tabIndex={-1}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs opacity-40 font-mono">
            키는 브라우저 localStorage에만 저장됩니다.
          </p>
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2.5 bg-bw-black dark:bg-bw-white text-bw-white dark:text-bw-black font-display text-sm tracking-wide hover:opacity-80 transition-opacity"
          >
            {saved ? <Check size={14} /> : null}
            {saved ? 'SAVED' : 'SAVE'}
          </button>
          {currentKey && (
            <button
              onClick={handleRemove}
              className="px-5 py-2.5 border border-bw-black/20 dark:border-bw-white/20 font-display text-sm tracking-wide hover:opacity-60 transition-opacity"
            >
              REMOVE KEY
            </button>
          )}
        </div>

        {/* Guide */}
        <div className="mt-auto pt-4 border-t border-bw-black/10 dark:border-bw-white/10">
          <p className="text-xs opacity-40 font-mono leading-relaxed">
            키 없이 사용 시 서버 프록시 모드로 동작합니다.
            <br />
            개인 키 발급: aistudio.google.com/apikey
          </p>
        </div>
      </div>
    </div>
  );
}
