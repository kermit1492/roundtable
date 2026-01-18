// lib/openrouter.ts

import OpenAI from 'openai';

export interface ModelConfig {
  id: string;
  name: string;
  color: string;
  tier: string;
  supportsFiles: boolean;
  supportedFileTypes: string[];
  reasoning?: boolean;
  baseModel?: string;
  reasoningEnabled?: boolean;
}

// SOTA Models - January 2026
export const AVAILABLE_MODELS: ModelConfig[] = [
  // Flagship tier
  { 
    id: 'openai/gpt-5.2-pro', 
    name: 'GPT-5.2 Pro', 
    color: '#10b981',
    tier: 'flagship',
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf'],
  },
  { 
    id: 'anthropic/claude-opus-4.5', 
    name: 'Claude Opus 4.5', 
    color: '#f59e0b',
    tier: 'flagship',
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf'],
  },
  { 
    id: 'google/gemini-3-pro-preview', 
    name: 'Gemini 3 Pro', 
    color: '#4285f4',
    tier: 'flagship',
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf', 'video', 'audio'],
  },

  
  // Reasoning tier (Deep Think / Thinking models)
  { 
    id: 'google/gemini-3-pro-preview:thinking', 
    name: 'Gemini 3 Pro Thinking', 
    color: '#34a853',
    tier: 'reasoning',
    reasoning: true,
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf', 'video', 'audio'],
    baseModel: 'google/gemini-3-pro-preview',
    reasoningEnabled: true,
  },
  { 
    id: 'deepseek/deepseek-r1', 
    name: 'DeepSeek R1', 
    color: '#8b5cf6',
    tier: 'reasoning',
    reasoning: true,
    supportsFiles: false,
    supportedFileTypes: [],
  },
  { 
    id: 'deepseek/deepseek-v3.2', 
    name: 'DeepSeek V3.2', 
    color: '#a78bfa',
    tier: 'reasoning',
    supportsFiles: false,
    supportedFileTypes: [],
  },
  
  // Fast tier
  { 
    id: 'google/gemini-3-flash-preview', 
    name: 'Gemini 3 Flash', 
    color: '#34a853',
    tier: 'fast',
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf', 'video', 'audio'],
  },

  { 
    id: 'anthropic/claude-sonnet-4.5', 
    name: 'Claude Sonnet 4.5', 
    color: '#d97706',
    tier: 'fast',
    supportsFiles: true,
    supportedFileTypes: ['image', 'pdf'],
  },
];

export function createOpenRouterClient() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
      'X-Title': 'AI Roundtable',
    },
  });
}

export function getModelsWithFileSupport(fileType: string): string[] {
  return AVAILABLE_MODELS
    .filter(m => m.supportsFiles && m.supportedFileTypes.includes(fileType))
    .map(m => m.id);
}

export function modelSupportsFile(modelId: string, fileType: string): boolean {
  const model = AVAILABLE_MODELS.find(m => m.id === modelId);
  if (!model) return false;
  return model.supportsFiles && model.supportedFileTypes.includes(fileType);
}

export function getModelConfig(modelId: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find(m => m.id === modelId) as ModelConfig | undefined;
}

// Get the actual model ID to use for API calls
export function getActualModelId(modelId: string): string {
  const config = getModelConfig(modelId);
  return config?.baseModel || modelId;
}

// Check if model needs reasoning parameter
export function needsReasoningParam(modelId: string): boolean {
  const config = getModelConfig(modelId);
  return config?.reasoningEnabled === true;
}
