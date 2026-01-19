'use client';

import { useState, useEffect, useRef } from 'react';
import { generatePDF, downloadPDF, generateDOCX, downloadDOCX, type ReportData, type ModelResponse } from './components/PDFReport';

const AVAILABLE_MODELS = [
  // Flagship tier
  { id: 'openai/gpt-5.2-pro', name: 'GPT-5.2 Pro', color: '#10b981', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf'] },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', color: '#f59e0b', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf'] },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', color: '#4285f4', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf', 'video', 'audio'] },
  // Fast tier
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', color: '#059669', tier: 'fast', supportsFiles: true, fileTypes: ['image', 'pdf'] },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', color: '#34a853', tier: 'fast', supportsFiles: true, fileTypes: ['image', 'pdf', 'video', 'audio'] },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', color: '#d97706', tier: 'fast', supportsFiles: true, fileTypes: ['image', 'pdf'] },
];

const PRESETS = {
  expert: {
    name: 'Expert Panel',
    description: 'Top SOTA models for serious tasks',
    icon: '🎓',
    models: ['openai/gpt-5.2-pro', 'anthropic/claude-opus-4.5', 'google/gemini-3-pro-preview'],
  },
  speed: {
    name: 'Speed Round',
    description: 'Fast models for brainstorming',
    icon: '⚡',
    models: ['openai/gpt-5.2', 'google/gemini-3-flash-preview', 'anthropic/claude-sonnet-4.5'],
  },
};

type Theme = 'light' | 'sepia' | 'dark';

interface ModelState {
  thinking: boolean;
  currentResponse: string;
  streaming: boolean;
  history: string[];
  completed: boolean;
  retrying?: boolean;
  retryAttempt?: number;
}

interface VoteState {
  status: 'pending' | 'voting' | 'retrying' | 'voted' | 'failed';
  vote?: 'yes' | 'no';
  score?: number;
  reasoning?: string;
  retryAttempt?: number;
}

interface IndividualVote {
  model: string;
  vote: 'yes' | 'no';
  score: number;
  reasoning: string;
}

interface ModelSynthesis {
  modelName: string;
  synthesis: string;
}

interface GroupedAgreement {
  point: string;
  count: number;
  models: string[];
}

interface DisagreementSide {
  position: string;
  models: string[];
}

interface GroupedDisagreement {
  point: string;
  sides: DisagreementSide[];
}

interface ConsensusResult {
  consensus_reached: boolean;
  consensus_type: 'full' | 'partial' | 'none';
  similarity_score: number;
  votes?: {
    yes: number;
    total: number;
    ratio: number;
  };
  individual_votes?: IndividualVote[];
  syntheses?: ModelSynthesis[];
  synthesis?: string;
  camps?: { position: string; participants: string[] }[];
  key_agreements: GroupedAgreement[];
  key_disagreements: GroupedDisagreement[];
  closest_to_truth?: string;
  closest_to_truth_reason?: string;
  // Final round information
  is_final_round?: boolean;
  models_agreed?: string[];
  models_disagreed?: string[];
}

interface DiscussionEntry {
  question: string;
  consensusResult: ConsensusResult | null;
  finalResponses: Record<string, string>;
}

interface FileAttachment {
  type: 'image' | 'pdf';
  data: string;
  mimeType: string;
  name: string;
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  );
}

function SepiaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" opacity="0.5"/><circle cx="12" cy="12" r="4"/>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

export default function Home() {
  const [theme, setTheme] = useState<Theme>('light');
  const [question, setQuestion] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>(PRESETS.expert.models);
  const [activePreset, setActivePreset] = useState<string>('expert');
  const [thread, setThread] = useState<DiscussionEntry[]>([]);
  const [file, setFile] = useState<FileAttachment | null>(null);
  const [exporting, setExporting] = useState(false);
  const [nsfwMode, setNsfwMode] = useState(false);
  const [discussion, setDiscussion] = useState({
    status: 'idle' as 'idle' | 'running' | 'complete' | 'error',
    phase: 'idle' as string,
    iteration: 0,
    modelStates: {} as Record<string, ModelState>,
    votingStates: {} as Record<string, VoteState>,
    consensusResult: null as ConsensusResult | null,
    excludedModels: [] as { id: string; name: string; reason: string }[],
    completedCount: 0,
    totalCount: 0,
    currentQuestion: '',
    // Stuck detection
    lastActivityTime: Date.now(),
    isStuck: false,
    // Voting history for export
    allVotingResults: {} as Record<number, {
      votes: Array<{
        modelName: string;
        consensusReached: boolean;
        similarityScore: number;
        reasoning: string;
      }>;
      consensusType: string;
      yesCount: number;
      totalCount: number;
    }>,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const consensusRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('roundtable-theme') as Theme;
    if (saved && ['light', 'sepia', 'dark'].includes(saved)) {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
    }
    // Load NSFW mode from localStorage
    const savedNsfw = localStorage.getItem('roundtable-nsfw-mode');
    if (savedNsfw === 'true') {
      setNsfwMode(true);
    }
  }, []);

  const toggleNsfwMode = () => {
    setNsfwMode(prev => {
      const newValue = !prev;
      localStorage.setItem('roundtable-nsfw-mode', String(newValue));
      return newValue;
    });
  };

  useEffect(() => {
    if (discussion.status === 'running') {
      Object.entries(discussion.modelStates).forEach(([modelId, state]) => {
        if (state.streaming && columnRefs.current[modelId]) {
          const el = columnRefs.current[modelId];
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [discussion.modelStates, discussion.status]);

  useEffect(() => {
    if (discussion.status === 'complete' && consensusRef.current) {
      setTimeout(() => consensusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }, [discussion.status]);

  // Stuck detection - check if no activity for 2 minutes
  useEffect(() => {
    if (discussion.status !== 'running') return;

    const STUCK_THRESHOLD_MS = 120000; // 2 minutes
    const checkInterval = setInterval(() => {
      const timeSinceActivity = Date.now() - discussion.lastActivityTime;
      if (timeSinceActivity > STUCK_THRESHOLD_MS && !discussion.isStuck) {
        console.warn('Discussion appears stuck - no activity for 2 minutes');
        setDiscussion(p => ({ ...p, isStuck: true }));
      }
    }, 10000); // Check every 10 seconds

    return () => clearInterval(checkInterval);
  }, [discussion.status, discussion.lastActivityTime, discussion.isStuck]);

  const changeTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('roundtable-theme', newTheme);
  };

  const selectPreset = (key: string) => {
    const preset = PRESETS[key as keyof typeof PRESETS];
    if (preset) {
      setActivePreset(key);
      setSelectedModels(preset.models);
    }
  };

  const toggleModel = (modelId: string) => {
    setSelectedModels(prev => {
      const newSelection = prev.includes(modelId) 
        ? prev.filter(m => m !== modelId) 
        : [...prev, modelId];
      
      const match = Object.entries(PRESETS).find(([, p]) => 
        p.models.length === newSelection.length && 
        p.models.every(m => newSelection.includes(m))
      );
      setActivePreset(match ? match[0] : 'custom');
      return newSelection;
    });
  };

  const getModel = (id: string) => AVAILABLE_MODELS.find(m => m.id === id);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setFile({
        type: f.type.startsWith('image/') ? 'image' : 'pdf',
        data: base64,
        mimeType: f.type,
        name: f.name,
      });
    };
    reader.readAsDataURL(f);
  };

  const removeFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startNewThread = () => {
    // Abort any running discussion
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setThread([]);
    setFile(null);
    setDiscussion({
      status: 'idle',
      phase: 'idle',
      iteration: 0,
      modelStates: {},
      votingStates: {},
      consensusResult: null,
      excludedModels: [],
      completedCount: 0,
      totalCount: 0,
      currentQuestion: '',
      lastActivityTime: Date.now(),
      isStuck: false,
      allVotingResults: {},
    });
    setQuestion('');
  };

  const stopDiscussion = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setDiscussion(p => ({
      ...p,
      status: 'complete',
      phase: 'stopped',
    }));
  };

  const handleExportPDF = async () => {
    console.log('Export PDF clicked');
    console.log('consensusResult:', discussion.consensusResult);
    if (!discussion.consensusResult) {
      console.log('No consensus result, returning');
      return;
    }
    setExporting(true);
    try {
      const models: ModelResponse[] = Object.keys(discussion.modelStates).map(modelId => {
        const model = getModel(modelId);
        const state = discussion.modelStates[modelId];
        const responses: { round: number; text: string; isInitial: boolean }[] = [];
        
        // Add all history entries
        state.history.forEach((text, idx) => {
          responses.push({ round: idx + 1, text, isInitial: idx === 0 });
        });
        
        // Add currentResponse only if it's different from the last history entry
        if (state.currentResponse) {
          const lastHistoryEntry = state.history[state.history.length - 1];
          if (state.currentResponse !== lastHistoryEntry) {
            responses.push({
              round: state.history.length + 1,
              text: state.currentResponse,
              isInitial: state.history.length === 0,
            });
          }
        }
        
        return {
          modelId,
          modelName: model?.name || modelId,
          color: model?.color || '#888',
          responses,
        };
      });

      const reportData: ReportData = {
        question: discussion.currentQuestion,
        date: new Date().toLocaleDateString('ru-RU', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        iterations: discussion.iteration,
        models,
        consensusResult: discussion.consensusResult,
        votingHistory: discussion.allVotingResults,
      };

      console.log('Generating PDF with data:', reportData);
      const blob = await generatePDF(reportData);
      console.log('PDF blob generated:', blob);
      downloadPDF(blob, `AI_Roundtable_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (e) {
      console.error(e);
    }
    setExporting(false);
  };

  const handleExportDOCX = async () => {
    console.log('Export DOCX clicked');
    if (!discussion.consensusResult) {
      console.log('No consensus result, returning');
      return;
    }
    setExporting(true);
    try {
      const models: ModelResponse[] = Object.keys(discussion.modelStates).map(modelId => {
        const model = getModel(modelId);
        const state = discussion.modelStates[modelId];
        const responses: { round: number; text: string; isInitial: boolean }[] = [];

        state.history.forEach((text, idx) => {
          responses.push({ round: idx + 1, text, isInitial: idx === 0 });
        });

        if (state.currentResponse) {
          const lastHistoryEntry = state.history[state.history.length - 1];
          if (state.currentResponse !== lastHistoryEntry) {
            responses.push({
              round: state.history.length + 1,
              text: state.currentResponse,
              isInitial: state.history.length === 0,
            });
          }
        }

        return {
          modelId,
          modelName: model?.name || modelId,
          color: model?.color || '#888',
          responses,
        };
      });

      const reportData: ReportData = {
        question: discussion.currentQuestion,
        date: new Date().toLocaleDateString('ru-RU', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        iterations: discussion.iteration,
        models,
        consensusResult: discussion.consensusResult,
        votingHistory: discussion.allVotingResults,
      };

      console.log('Generating DOCX with data:', reportData);
      const blob = await generateDOCX(reportData);
      console.log('DOCX blob generated:', blob);
      downloadDOCX(blob, `AI_Roundtable_${new Date().toISOString().split('T')[0]}.docx`);
    } catch (e) {
      console.error(e);
    }
    setExporting(false);
  };

  const handleSSE = (event: string, data: Record<string, unknown>) => {
    switch (event) {
      case 'iteration_start':
        setDiscussion(p => ({
          ...p,
          iteration: data.iteration as number,
          phase: 'thinking',
          totalCount: (data.totalModels as number) || p.totalCount,
          completedCount: 0,
        }));
        break;

      case 'models_thinking':
        setDiscussion(p => {
          const ns = { ...p.modelStates };
          (data.models as { id: string }[]).forEach(m => {
            if (ns[m.id]) {
              if (ns[m.id].currentResponse) {
                ns[m.id].history = [...ns[m.id].history, ns[m.id].currentResponse];
              }
              ns[m.id] = {
                ...ns[m.id],
                thinking: true,
                currentResponse: '',
                streaming: true,
                completed: false,
                retrying: false,
              };
            }
          });
          return { ...p, modelStates: ns, phase: 'thinking', completedCount: 0 };
        });
        break;

      case 'model_retry':
        setDiscussion(p => {
          const id = data.model as string;
          if (!p.modelStates[id]) return p;
          const ns = { ...p.modelStates };
          ns[id] = { ...ns[id], retrying: true, retryAttempt: data.attempt as number };
          return { ...p, modelStates: ns };
        });
        break;

      case 'model_token':
        setDiscussion(p => {
          const id = data.model as string;
          if (!p.modelStates[id]) return p;
          const ns = { ...p.modelStates };
          ns[id] = {
            ...ns[id],
            currentResponse: ns[id].currentResponse + (data.token as string),
            retrying: false,
          };
          return { ...p, modelStates: ns, lastActivityTime: Date.now(), isStuck: false };
        });
        break;

      case 'model_complete':
        setDiscussion(p => {
          const id = data.model as string;
          if (!p.modelStates[id]) return p;
          const ns = { ...p.modelStates };
          ns[id] = {
            ...ns[id],
            thinking: false,
            streaming: false,
            currentResponse: data.response as string,
            completed: true,
            retrying: false,
          };
          return {
            ...p,
            modelStates: ns,
            completedCount: (data.completedCount as number) || p.completedCount + 1,
          };
        });
        break;

      case 'model_error':
        // Auto-stop on model error
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setDiscussion(p => {
          const id = data.model as string;
          if (!p.modelStates[id]) return p;
          const ns = { ...p.modelStates };
          ns[id] = {
            ...ns[id],
            thinking: false,
            streaming: false,
            completed: true,
            retrying: false,
            currentResponse: `⚠️ Error: ${data.error}`,
          };
          return {
            ...p,
            status: 'error',
            phase: 'error',
            modelStates: ns,
          };
        });
        break;

      case 'all_models_complete':
        setDiscussion(p => ({ ...p, phase: 'all_complete', completedCount: p.totalCount }));
        break;

      case 'voting_start':
        setDiscussion(p => {
          // Initialize voting states for all models
          const vs: Record<string, VoteState> = {};
          Object.keys(p.modelStates).forEach(id => {
            vs[id] = { status: 'pending' };
          });
          return { ...p, phase: 'voting', votingStates: vs };
        });
        break;

      case 'model_voting':
        setDiscussion(p => {
          const id = data.model as string;
          const vs = { ...p.votingStates };
          vs[id] = { status: 'voting' };
          return { ...p, votingStates: vs };
        });
        break;

      case 'model_vote_retrying':
        setDiscussion(p => {
          const id = data.model as string;
          const vs = { ...p.votingStates };
          vs[id] = { status: 'retrying', retryAttempt: data.attempt as number };
          return { ...p, votingStates: vs };
        });
        break;

      case 'model_voted':
        setDiscussion(p => {
          const id = data.model as string;
          const vote = data.vote as { consensusReached: boolean; similarityScore: number; reasoning: string };
          const vs = { ...p.votingStates };
          vs[id] = {
            status: 'voted',
            vote: vote.consensusReached ? 'yes' : 'no',
            score: vote.similarityScore,
            reasoning: vote.reasoning,
          };
          return { ...p, votingStates: vs, lastActivityTime: Date.now(), isStuck: false };
        });
        break;

      case 'model_vote_failed':
        setDiscussion(p => {
          const id = data.model as string;
          const vs = { ...p.votingStates };
          vs[id] = { status: 'failed' };
          return { ...p, votingStates: vs };
        });
        break;

      case 'analyzing_points':
        setDiscussion(p => ({ ...p, phase: 'analyzing' }));
        break;

      case 'consensus_result':
        setDiscussion(p => ({ ...p, consensusResult: data.result as ConsensusResult }));
        break;

      case 'preparing_next_round':
        setDiscussion(p => ({ ...p, phase: 'next_round' }));
        break;

      case 'discussion_complete':
        setDiscussion(p => ({
          ...p,
          status: 'complete',
          phase: 'idle',
          consensusResult: data.result as ConsensusResult,
          allVotingResults: (data.allVotingResults || {}) as typeof p.allVotingResults,
        }));
        break;

      case 'error':
        setDiscussion(p => ({ ...p, status: 'error' }));
        break;

      case 'heartbeat':
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'timeout':
        setDiscussion(p => ({
          ...p,
          status: 'error',
          phase: 'timeout',
        }));
        break;

      case 'voting_partial_failure':
        // Just a warning, don't change status
        console.warn('Voting partial failure:', data);
        break;
    }
  };

  const startDiscussion = async (isFollowUp = false) => {
    if (!question.trim() || selectedModels.length < 2) return;

    // Create new AbortController for this discussion
    abortControllerRef.current = new AbortController();

    const currentQuestion = question;
    const initialStates: Record<string, ModelState> = {};
    selectedModels.forEach(id => {
      initialStates[id] = {
        thinking: false,
        currentResponse: '',
        streaming: false,
        history: [],
        completed: false,
      };
    });

    setDiscussion({
      status: 'running',
      phase: 'thinking',
      iteration: 1,
      modelStates: initialStates,
      votingStates: {},
      consensusResult: null,
      excludedModels: [],
      completedCount: 0,
      totalCount: selectedModels.length,
      currentQuestion,
      lastActivityTime: Date.now(),
      isStuck: false,
      allVotingResults: {},
    });

    const prev = thread.length > 0 ? thread[thread.length - 1] : null;
    const previousDiscussion = isFollowUp && prev
      ? {
          question: prev.question,
          consensus: prev.consensusResult?.synthesis,
          responses: prev.finalResponses,
        }
      : undefined;

    try {
      const res = await fetch('/api/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: currentQuestion,
          models: selectedModels,
          previousDiscussion,
          file: file || undefined,
          nsfwMode,
        }),
        signal: abortControllerRef.current?.signal,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No reader');

      let buffer = '';
      let finalResponses: Record<string, string> = {};

      while (true) {
        // Check if aborted
        if (abortControllerRef.current?.signal.aborted) break;
        
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let evt = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            evt = line.slice(7);
          } else if (line.startsWith('data: ') && evt) {
            try {
              const data = JSON.parse(line.slice(6));
              if (evt === 'discussion_complete' && data.finalResponses) {
                finalResponses = data.finalResponses;
              }
              if (evt === 'models_filtered' && data.excludedModels) {
                setDiscussion(p => ({ ...p, excludedModels: data.excludedModels }));
              }
              handleSSE(evt, data);
            } catch {}
            evt = '';
          }
        }
      }

      setDiscussion(p => {
        if (p.status === 'complete') {
          setThread(t => [...t, {
            question: currentQuestion,
            consensusResult: p.consensusResult,
            finalResponses,
          }]);
        }
        return p;
      });

      setQuestion('');
      setFile(null);
    } catch (e) {
      // Don't set error status if it was aborted by user
      if (e instanceof Error && e.name === 'AbortError') {
        console.log('Discussion stopped by user');
        return;
      }
      console.error(e);
      setDiscussion(p => ({ ...p, status: 'error' }));
    } finally {
      abortControllerRef.current = null;
    }
  };

  const getPhaseText = () => {
    const { phase, iteration, completedCount, totalCount } = discussion;
    const isFinalRound = iteration === 5;
    const roundLabel = isFinalRound ? `Round ${iteration} (FINAL)` : `Round ${iteration}`;

    if (phase === 'thinking') return `${roundLabel}: Models thinking... (${completedCount}/${totalCount})`;
    if (phase === 'all_complete') return `${roundLabel}: All done ✓`;
    if (phase === 'voting') return isFinalRound ? `Final voting on consensus...` : `Models voting on consensus...`;
    if (phase === 'analyzing') return `Analyzing key points with Sonnet...`;
    if (phase === 'next_round') return `Preparing round ${iteration + 1}...`;
    return '';
  };

  const compatibleCount = file
    ? selectedModels.filter(id => {
        const m = getModel(id);
        return m?.supportsFiles && m.fileTypes.includes(file.type);
      }).length
    : selectedModels.length;

  const modelsByTier = {
    flagship: AVAILABLE_MODELS.filter(m => m.tier === 'flagship'),
    fast: AVAILABLE_MODELS.filter(m => m.tier === 'fast'),
  };

  const hasActiveThread = thread.length > 0 || discussion.status !== 'idle';

  return (
    <main className="min-h-screen transition-colors" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Header */}
      <header
        className="border-b sticky top-0 z-10"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
      >
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-text)' }}
            >
              <span className="text-sm font-bold">ai</span>
            </div>
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Roundtable</span>
            <span className="text-xs ml-1" style={{ color: 'var(--text-tertiary)' }}>v1.0.5</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center rounded-full p-1 gap-1" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              <button
                onClick={() => changeTheme('light')}
                className={`p-2 rounded-full ${theme === 'light' ? 'shadow-sm' : 'opacity-50'}`}
                style={{ backgroundColor: theme === 'light' ? 'var(--bg-secondary)' : 'transparent', color: 'var(--text-primary)' }}
              >
                <SunIcon />
              </button>
              <button
                onClick={() => changeTheme('sepia')}
                className={`p-2 rounded-full ${theme === 'sepia' ? 'shadow-sm' : 'opacity-50'}`}
                style={{ backgroundColor: theme === 'sepia' ? 'var(--bg-secondary)' : 'transparent', color: 'var(--text-primary)' }}
              >
                <SepiaIcon />
              </button>
              <button
                onClick={() => changeTheme('dark')}
                className={`p-2 rounded-full ${theme === 'dark' ? 'shadow-sm' : 'opacity-50'}`}
                style={{ backgroundColor: theme === 'dark' ? 'var(--bg-secondary)' : 'transparent', color: 'var(--text-primary)' }}
              >
                <MoonIcon />
              </button>
            </div>
            {/* NSFW Toggle */}
            <button
              onClick={toggleNsfwMode}
              disabled={discussion.status === 'running'}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                discussion.status === 'running' ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
              }`}
              style={{
                backgroundColor: nsfwMode ? '#ef4444' : 'var(--bg-tertiary)',
                color: nsfwMode ? '#fff' : 'var(--text-secondary)',
                borderColor: nsfwMode ? '#ef4444' : 'var(--border-primary)',
              }}
              title={nsfwMode ? 'NSFW Mode: Models will roast each other' : 'Safe Mode: Normal discussion'}
            >
              {nsfwMode ? '🔥 NSFW' : '🔒 Safe'}
            </button>
            {hasActiveThread && (
              <button onClick={startNewThread} className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                + New thread
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Thread history */}
        {thread.length > 0 && (
          <div className="mb-8 space-y-4">
            <div className="text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>
              Previous in thread
            </div>
            {thread.map((entry, idx) => (
              <div
                key={idx}
                className="rounded-xl border p-4"
                style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
                    style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  >
                    {idx + 1}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{entry.question}</div>
                    {entry.consensusResult?.synthesis && (
                      <div className="text-sm rounded-lg p-3" style={{ backgroundColor: 'var(--success-bg)' }}>
                        <span className="font-medium" style={{ color: 'var(--success-text)' }}>✓ Consensus:</span>{' '}
                        <span style={{ color: 'var(--text-secondary)' }}>{entry.consensusResult.synthesis.slice(0, 200)}...</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div
          className="rounded-2xl border p-6 mb-8 shadow-sm"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: nsfwMode ? '#fecaca' : 'var(--border-primary)' }}
        >
          {nsfwMode && (
            <div
              className="mb-3 px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1"
              style={{ backgroundColor: '#fef2f2', color: '#dc2626' }}
            >
              🔥 NSFW Mode: Модели будут троллить друг друга с матом и юмором
            </div>
          )}
          <textarea
            value={question}
            onChange={e => {
              setQuestion(e.target.value);
              // Auto-resize textarea
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 300)}px`;
            }}
            placeholder={thread.length > 0 ? 'Ask a follow-up...' : 'What would you like to discuss?'}
            className="w-full bg-transparent text-lg focus:outline-none resize-none overflow-hidden"
            style={{ color: 'var(--text-primary)', minHeight: '56px', maxHeight: '300px' }}
            rows={1}
            disabled={discussion.status === 'running'}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && question.trim() && selectedModels.length >= 2) {
                e.preventDefault();
                startDiscussion(thread.length > 0);
              }
            }}
          />

          {file && (
            <div className="mt-3 flex items-center gap-2 p-2 rounded-lg" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              <FileIcon />
              <span className="text-sm flex-1" style={{ color: 'var(--text-secondary)' }}>{file.name}</span>
              {compatibleCount < selectedModels.length && (
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}
                >
                  {compatibleCount}/{selectedModels.length} support
                </span>
              )}
              <button onClick={removeFile} className="p-1" style={{ color: 'var(--text-tertiary)' }}>
                <CloseIcon />
              </button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-secondary)' }}>
            {/* PRESETS */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>Quick select:</span>
              {Object.entries(PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  onClick={() => selectPreset(key)}
                  disabled={discussion.status === 'running'}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all"
                  style={{
                    backgroundColor: activePreset === key ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: activePreset === key ? 'var(--accent-text)' : 'var(--text-secondary)',
                    borderColor: activePreset === key ? 'var(--accent)' : 'var(--border-primary)',
                    boxShadow: activePreset === key ? '0 0 0 2px var(--accent)' : 'none',
                  }}
                >
                  {preset.icon} {preset.name}
                </button>
              ))}
              {activePreset === 'custom' && (
                <span
                  className="px-2 py-1 rounded text-xs"
                  style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
                >
                  Custom
                </span>
              )}
            </div>

            {/* Models */}
            <div className="flex flex-wrap items-start gap-4">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                accept="image/*,.pdf"
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={discussion.status === 'running'}
                className="p-2 rounded-lg border"
                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
              >
                <FileIcon />
              </button>

              <div className="flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium w-20" style={{ color: 'var(--text-tertiary)' }}>Flagship</span>
                  {modelsByTier.flagship.map(model => {
                    const disabled = file && (!model.supportsFiles || !model.fileTypes.includes(file.type));
                    return (
                      <button
                        key={model.id}
                        onClick={() => toggleModel(model.id)}
                        disabled={discussion.status === 'running'}
                        className={`px-3 py-1.5 rounded-full text-sm font-medium border ${disabled ? 'opacity-40' : ''}`}
                        style={{
                          backgroundColor: selectedModels.includes(model.id) ? model.color : 'var(--bg-secondary)',
                          color: selectedModels.includes(model.id) ? '#fff' : 'var(--text-secondary)',
                          borderColor: selectedModels.includes(model.id) ? model.color : 'var(--border-primary)',
                        }}
                      >
                        {model.name}
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium w-20" style={{ color: 'var(--text-tertiary)' }}>Fast</span>
                  {modelsByTier.fast.map(model => {
                    const disabled = file && (!model.supportsFiles || !model.fileTypes.includes(file.type));
                    return (
                      <button
                        key={model.id}
                        onClick={() => toggleModel(model.id)}
                        disabled={discussion.status === 'running'}
                        className={`px-3 py-1.5 rounded-full text-sm font-medium border ${disabled ? 'opacity-40' : ''}`}
                        style={{
                          backgroundColor: selectedModels.includes(model.id) ? model.color : 'var(--bg-secondary)',
                          color: selectedModels.includes(model.id) ? '#fff' : 'var(--text-secondary)',
                          borderColor: selectedModels.includes(model.id) ? model.color : 'var(--border-primary)',
                        }}
                      >
                        {model.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {discussion.status === 'running' ? (
                <button
                  onClick={stopDiscussion}
                  className="font-medium py-2 px-6 rounded-lg"
                  style={{ backgroundColor: '#ef4444', color: '#fff' }}
                >
                  ⏹ Stop
                </button>
              ) : (
                <button
                  onClick={() => startDiscussion(thread.length > 0)}
                  disabled={!question.trim() || selectedModels.length < 2}
                  className="font-medium py-2 px-6 rounded-lg disabled:opacity-40"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-text)' }}
                >
                  {thread.length > 0 ? 'Continue →' : 'Start'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Excluded models warning */}
        {discussion.excludedModels.length > 0 && (
          <div
            className="mb-4 p-3 rounded-lg text-sm"
            style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}
          >
            ⚠️ Excluded: {discussion.excludedModels.map(m => m.name).join(', ')}
          </div>
        )}

        {/* Progress */}
        {discussion.status === 'running' && (
          <div
            className="mb-6 p-4 rounded-xl border"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
          >
            <div className="flex items-center gap-3 mb-3">
              <div
                className={`w-3 h-3 rounded-full animate-pulse ${discussion.phase === 'voting' ? 'bg-purple-500' : 'bg-blue-500'}`}
              />
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{getPhaseText()}</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: discussion.phase === 'voting' || discussion.phase === 'all_complete'
                    ? '100%'
                    : `${(discussion.completedCount / discussion.totalCount) * 100}%`,
                  backgroundColor: discussion.phase === 'voting' ? '#8b5cf6' : 'var(--accent)',
                }}
              />
            </div>

            {/* Stuck detection warning */}
            {discussion.isStuck && (
              <div
                className="mt-3 p-3 rounded-lg border flex items-center justify-between"
                style={{ backgroundColor: '#fef3c7', borderColor: '#f59e0b' }}
              >
                <span className="text-sm" style={{ color: '#92400e' }}>
                  ⚠️ Discussion appears stuck — no activity for 2 minutes
                </span>
                <button
                  onClick={stopDiscussion}
                  className="ml-3 px-3 py-1 rounded text-sm font-medium"
                  style={{ backgroundColor: '#f59e0b', color: '#fff' }}
                >
                  Stop and show results
                </button>
              </div>
            )}

            {/* Voting Status Panel - show during voting and analyzing phases */}
            {(discussion.phase === 'voting' || discussion.phase === 'analyzing') && Object.keys(discussion.votingStates).length > 0 && (
              <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-secondary)' }}>
                <div className="text-xs font-medium mb-3" style={{ color: 'var(--text-tertiary)' }}>🗳️ Voting Progress</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(Object.keys(discussion.votingStates).length, 3)}, 1fr)` }}>
                  {Object.entries(discussion.votingStates).map(([modelId, voteState]) => {
                    const model = getModel(modelId);
                    if (!model) return null;

                    return (
                      <div
                        key={modelId}
                        className="rounded-lg p-3 border transition-all"
                        style={{
                          backgroundColor: voteState.status === 'voted'
                            ? voteState.vote === 'yes' ? 'var(--success-bg)' : 'var(--bg-tertiary)'
                            : voteState.status === 'failed' ? '#fef2f2'
                            : 'var(--bg-tertiary)',
                          borderColor: voteState.status === 'voted'
                            ? voteState.vote === 'yes' ? 'var(--success-text)' : 'var(--border-primary)'
                            : voteState.status === 'failed' ? '#ef4444'
                            : voteState.status === 'retrying' ? '#f59e0b'
                            : 'var(--border-secondary)',
                        }}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: model.color }} />
                          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {model.name}
                          </span>
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {voteState.status === 'pending' && (
                            <span className="text-gray-400">⏳ Waiting...</span>
                          )}
                          {voteState.status === 'voting' && (
                            <span className="text-purple-500 animate-pulse">🗳️ Voting...</span>
                          )}
                          {voteState.status === 'retrying' && (
                            <span className="text-amber-500">🔄 Retry {voteState.retryAttempt}/5</span>
                          )}
                          {voteState.status === 'voted' && voteState.vote === 'yes' && (
                            <span className="text-green-600">✅ Consensus: Yes ({Math.round((voteState.score || 0) * 100)}%)</span>
                          )}
                          {voteState.status === 'voted' && voteState.vote === 'no' && (
                            <span className="text-gray-600">❌ Consensus: No ({Math.round((voteState.score || 0) * 100)}%)</span>
                          )}
                          {voteState.status === 'failed' && (
                            <span className="text-red-500">⚠️ Failed</span>
                          )}
                        </div>
                        {/* Show reasoning when voted */}
                        {voteState.status === 'voted' && voteState.reasoning && (
                          <div
                            className="mt-2 pt-2 border-t text-xs leading-relaxed max-h-32 overflow-y-auto"
                            style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-tertiary)' }}
                          >
                            {voteState.reasoning}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Model columns */}
        {discussion.status !== 'idle' && (
          <div
            className="grid gap-4 mb-8"
            style={{ gridTemplateColumns: `repeat(${Object.keys(discussion.modelStates).length}, minmax(280px, 1fr))` }}
          >
            {Object.keys(discussion.modelStates).map(modelId => {
              const model = getModel(modelId);
              const state = discussion.modelStates[modelId];
              if (!model || !state) return null;

              const isWinner = discussion.consensusResult?.closest_to_truth === model.name;

              return (
                <div
                  key={modelId}
                  className="rounded-2xl border-2 overflow-hidden flex flex-col"
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    borderColor: model.color,
                    boxShadow: isWinner ? `0 0 0 3px ${model.color}33` : 'none',
                  }}
                >
                  <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-secondary)' }}>
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: model.color }} />
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{model.name}</span>
                    </div>
                    {state.retrying && <span className="text-xs" style={{ color: 'var(--warning-text)' }}>🔄 Retry {state.retryAttempt}/3</span>}
                    {state.streaming && !state.retrying && <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>thinking...</span>}
                    {state.completed && !state.streaming && <span className="text-xs" style={{ color: 'var(--success-text)' }}><CheckIcon /></span>}
                    {isWinner && <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>🏆</span>}
                  </div>

                  <div
                    ref={el => { columnRefs.current[modelId] = el; }}
                    className="flex-1 p-5 max-h-[500px] overflow-y-auto"
                  >
                    {state.history.map((resp, idx) => {
                      const roundNum = idx + 1;
                      const isFinal = roundNum === 5;
                      return (
                        <div key={idx} className="mb-4 pb-4 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
                          <div className="text-xs mb-2 font-medium flex items-center gap-2" style={{ color: idx === 0 ? '#3b82f6' : '#7c3aed' }}>
                            {idx === 0 ? 'Round 1 — Initial' : `Round ${roundNum} — Response`}
                            {isFinal && <span className="px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-700">FINAL</span>}
                          </div>
                          <div className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{resp}</div>
                        </div>
                      );
                    })}

                    {state.currentResponse && (
                      <>
                        <div className="text-xs mb-2 font-medium flex items-center gap-2" style={{ color: state.history.length === 0 ? '#3b82f6' : '#7c3aed' }}>
                          {state.history.length === 0 ? 'Round 1 — Initial' : `Round ${state.history.length + 1} — Response`}
                          {state.history.length + 1 === 5 && <span className="px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-700">FINAL</span>}
                        </div>
                        <div
                          className={`text-sm whitespace-pre-wrap ${state.streaming ? 'animate-pulse' : ''}`}
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {state.currentResponse}
                          {state.streaming && (
                            <span
                              className="inline-block w-0.5 h-4 ml-0.5 animate-pulse"
                              style={{ backgroundColor: 'var(--accent)' }}
                            />
                          )}
                        </div>
                      </>
                    )}

                    {!state.currentResponse && !state.history.length && (
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {state.retrying ? 'Retrying...' : 'Thinking...'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Consensus result */}
        {discussion.status === 'complete' && discussion.consensusResult && (
          <div
            ref={consensusRef}
            className="rounded-2xl border p-8 shadow-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-xl"
                  style={{ 
                    backgroundColor: discussion.consensusResult.consensus_type === 'full' 
                      ? 'var(--success-bg)' 
                      : discussion.consensusResult.consensus_type === 'partial'
                        ? '#dbeafe'
                        : 'var(--warning-bg)' 
                  }}
                >
                  {discussion.consensusResult.consensus_type === 'full' ? '✓' : discussion.consensusResult.consensus_type === 'partial' ? '≈' : '⚡'}
                </div>
                <div>
                  <h3 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {discussion.consensusResult.consensus_type === 'full'
                      ? '✅ Full Consensus'
                      : discussion.consensusResult.consensus_type === 'partial'
                        ? '⚡ Partial Consensus'
                        : '❌ No Consensus'}
                    {discussion.consensusResult.is_final_round && (
                      <span className="ml-2 text-sm font-medium px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                        FINAL
                      </span>
                    )}
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {discussion.consensusResult.votes
                      ? `${discussion.consensusResult.votes.yes}/${discussion.consensusResult.votes.total} models voted YES`
                      : 'No vote data'
                    } • Avg confidence: {Math.round(discussion.consensusResult.similarity_score * 100)}% • {discussion.iteration} round{discussion.iteration > 1 ? 's' : ''}
                  </p>
                  {/* Show which models agreed/disagreed */}
                  {discussion.consensusResult.consensus_type !== 'full' && discussion.consensusResult.models_agreed && discussion.consensusResult.models_agreed.length > 0 && (
                    <div className="mt-2 text-sm">
                      <span style={{ color: 'var(--success-text)' }}>Agreed: {discussion.consensusResult.models_agreed.join(', ')}</span>
                      {discussion.consensusResult.models_disagreed && discussion.consensusResult.models_disagreed.length > 0 && (
                        <span style={{ color: 'var(--error-text)' }}> • Disagreed: {discussion.consensusResult.models_disagreed.join(', ')}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportPDF}
                  disabled={exporting}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium disabled:opacity-50"
                  style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                >
                  <DownloadIcon /> {exporting ? '...' : 'MD'}
                </button>
                <button
                  onClick={handleExportDOCX}
                  disabled={exporting}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium disabled:opacity-50"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-text)' }}
                >
                  <DownloadIcon /> {exporting ? '...' : 'Word'}
                </button>
              </div>
            </div>

            <div className="h-1.5 rounded-full overflow-hidden mb-8" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${discussion.consensusResult.similarity_score * 100}%`,
                  backgroundColor: discussion.consensusResult.similarity_score > 0.8 ? 'var(--success-text)' : 'var(--warning-text)',
                }}
              />
            </div>

            {/* Individual Votes */}
            {discussion.consensusResult.individual_votes && discussion.consensusResult.individual_votes.length > 0 && (
              <div className="mb-8">
                <h4 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                  🗳️ Model Votes
                </h4>
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(discussion.consensusResult.individual_votes.length, 4)}, 1fr)` }}>
                  {discussion.consensusResult.individual_votes.map((vote, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl p-4 border"
                      style={{
                        backgroundColor: vote.vote === 'yes' ? 'var(--success-bg)' : 'var(--bg-tertiary)',
                        borderColor: vote.vote === 'yes' ? 'var(--success-text)' : 'var(--border-primary)',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">{vote.vote === 'yes' ? '✅' : '❌'}</span>
                        <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{vote.model}</span>
                      </div>
                      <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                        Confidence: {Math.round(vote.score * 100)}%
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {vote.reasoning}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Syntheses from each model */}
            {discussion.consensusResult.syntheses && discussion.consensusResult.syntheses.length > 0 && (
              <div className="mb-8">
                <h4 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                  📝 Conclusions by Each Model
                </h4>
                <div className="space-y-4">
                  {discussion.consensusResult.syntheses.map((s, idx) => (
                    <div key={idx} className="rounded-xl p-5 border" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}>
                      <div className="flex items-center gap-2 mb-3">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: getModel(Object.keys(discussion.modelStates).find(id => getModel(id)?.name === s.modelName) || '')?.color || '#888' }}
                        />
                        <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{s.modelName}</span>
                      </div>
                      <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                        {s.synthesis}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Legacy synthesis display */}
            {discussion.consensusResult.synthesis && !discussion.consensusResult.syntheses?.length && (
              <div className="rounded-xl p-6 mb-8" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                <h4 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Conclusion</h4>
                <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                  {discussion.consensusResult.synthesis}
                </div>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-6">
                {discussion.consensusResult.closest_to_truth && (
                  <div
                    className="rounded-xl p-5 border"
                    style={{ backgroundColor: 'var(--warning-bg)', borderColor: 'var(--warning-text)' }}
                  >
                    <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--warning-text)' }}>🏆 Best Initial Answer</h4>
                    <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {discussion.consensusResult.closest_to_truth}
                    </p>
                    {discussion.consensusResult.closest_to_truth_reason && (
                      <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {discussion.consensusResult.closest_to_truth_reason}
                      </p>
                    )}
                  </div>
                )}

                {discussion.consensusResult.key_agreements?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--success-text)' }}>✓ All Agree</h4>
                    <ul className="space-y-3">
                      {discussion.consensusResult.key_agreements.map((agreement, i) => (
                        <li key={i} className="rounded-lg p-3 border" style={{ backgroundColor: 'var(--success-bg)', borderColor: 'var(--success-text)' }}>
                          <div className="flex items-start gap-2">
                            <span className="text-sm font-medium" style={{ color: 'var(--success-text)' }}>
                              {agreement.count}/{discussion.consensusResult?.votes?.total || Object.keys(discussion.modelStates).length}
                            </span>
                            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{agreement.point}</span>
                          </div>
                          {agreement.models && agreement.models.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {agreement.models.map((model, j) => (
                                <span 
                                  key={j} 
                                  className="text-xs px-2 py-0.5 rounded-full"
                                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
                                >
                                  {model}
                                </span>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div>
                {discussion.consensusResult.key_disagreements?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--error-text)' }}>⚡ Points of Difference</h4>
                    <ul className="space-y-4">
                      {discussion.consensusResult.key_disagreements.map((disagreement, i) => (
                        <li key={i} className="rounded-lg p-3 border" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--error-text)' }}>
                          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                            {disagreement.point}
                          </div>
                          {disagreement.sides && disagreement.sides.length > 0 && (
                            <div className="space-y-2">
                              {disagreement.sides.map((side, j) => (
                                <div key={j} className="flex items-start gap-2 text-xs">
                                  <span 
                                    className="px-2 py-0.5 rounded font-medium shrink-0"
                                    style={{ 
                                      backgroundColor: j === 0 ? '#dbeafe' : '#fef3c7',
                                      color: j === 0 ? '#1d4ed8' : '#92400e'
                                    }}
                                  >
                                    {side.models.join(', ')}
                                  </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{side.position}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
