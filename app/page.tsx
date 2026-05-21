'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { generatePDF, downloadPDF, generateDOCX, downloadDOCX, generateSynthesisDOCX, generateSynthesisLaTeX, type ReportData, type ModelResponse, type SynthesisReportData } from './components/PDFReport';
import StarMapBackground, { type StarMapMode } from './components/StarMapBackground';

const AVAILABLE_MODELS = [
  { id: 'openai/gpt-5.5-pro', name: 'GPT-5.5 Pro', color: '#10b981', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf'] },
  { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', color: '#f59e0b', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf'] },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', color: '#4d8eff', tier: 'flagship', supportsFiles: true, fileTypes: ['image', 'pdf', 'video', 'audio'] },
];

const PRESETS = {
  expert: {
    name: 'Expert Panel',
    description: 'Top SOTA models for serious tasks',
    icon: '🎓',
    models: ['openai/gpt-5.5-pro', 'anthropic/claude-opus-4.7', 'google/gemini-3.5-flash'],
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

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l7-7 7 7" />
      <path d="M12 5v14" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
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

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
    >
      <polyline points="6 9 12 15 18 9"/>
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

// Synthesis Mode Components
function SynthesisProgress({ phase, winnerModel }: { phase: string; winnerModel: string }) {
  const phases = [
    { id: 'analysis', label: 'Analysis', icon: '1' },
    { id: 'drafting', label: 'All Draft', icon: '2' },
    { id: 'reviewing', label: 'Cross-Review', icon: '3' },
    { id: 'voting', label: 'Voting', icon: '4' },
    { id: 'finalizing', label: 'Finalize', icon: '5' },
    { id: 'complete', label: 'Done', icon: '✓' },
  ];

  const getPhaseIndex = () => {
    if (phase === 'synthesis_analysis' || phase === 'analysis') return 0;
    if (phase === 'synthesis_drafting' || phase === 'drafting' || phase === 'draft_complete') return 1;
    if (phase === 'synthesis_reviewing' || phase === 'reviewing') return 2;
    if (phase === 'synthesis_voting' || phase === 'voting') return 3;
    if (phase === 'synthesis_finalizing' || phase === 'finalizing') return 4;
    if (phase === 'complete') return 5;
    return -1;
  };

  const currentIndex = getPhaseIndex();

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Synthesis Progress
        </div>
        {winnerModel && (
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            🏆 Winner: {winnerModel}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {phases.map((p, idx) => (
          <div key={p.id} className="flex items-center">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
                idx < currentIndex ? 'bg-green-500 text-white' :
                idx === currentIndex ? 'bg-blue-500 text-white animate-pulse' :
                ''
              }`}
              style={idx > currentIndex ? { backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' } : {}}
            >
              {idx < currentIndex ? '✓' : p.icon}
            </div>
            <span
              className="ml-1 text-xs hidden md:inline"
              style={{ color: idx <= currentIndex ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
            >
              {p.label}
            </span>
            {idx < phases.length - 1 && (
              <div
                className="w-4 h-0.5 mx-1"
                style={{ backgroundColor: idx < currentIndex ? '#22c55e' : 'var(--border-primary)' }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Render text with LaTeX math formulas using KaTeX
function renderWithLatex(text: string): string {
  // Replace display math \[...\] and $$...$$
  let html = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    try { return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }); }
    catch { return math; }
  });
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
    try { return katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }); }
    catch { return math; }
  });
  // Replace inline math \(...\) and $...$
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
    try { return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }); }
    catch { return math; }
  });
  html = html.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    try { return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }); }
    catch { return math; }
  });
  // Convert markdown bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function LatexText({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const html = useMemo(() => renderWithLatex(text), [text]);
  return <span className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

function LatexBlock({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const html = useMemo(() => {
    const rendered = renderWithLatex(text);
    // Convert remaining newlines to <br> (but not inside KaTeX output which uses its own layout)
    return rendered.replace(/\n/g, '<br/>');
  }, [text]);
  return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

function SynthesisReport({
  result,
  differences,
  draft,
  question,
  selectedModels,
  exporting,
  onExport,
  exportingLaTeX,
  onExportLaTeX
}: {
  result: {
    executiveSummary: string;
    keyFindings: { title: string; content: string; confidence: number; contributors: string[] }[];
    methodology: { leadModel: string; reviewers: string[] };
    overallConfidence: number;
    votingResults?: { winner: string; votes: Record<string, number>; totalVotes: number };
  } | null;
  differences: { topic: string; positions: { model: string; position: string; color: string }[] }[];
  draft: string;
  question: string;
  selectedModels: string[];
  exporting: boolean;
  onExport: () => void;
  exportingLaTeX: boolean;
  onExportLaTeX: () => void;
}) {
  const [latexMode, setLatexMode] = useState(false);

  if (!result && !draft) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 mt-6">
      {/* Main Content */}
      <div
        className="rounded-2xl border p-6"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            📝 Unified Synthesis
            {result?.votingResults && (
              <span className="ml-2 text-sm font-normal px-2 py-0.5 rounded-full" style={{ backgroundColor: '#dbeafe', color: '#1d4ed8' }}>
                🏆 Winner: {result.votingResults.winner}
              </span>
            )}
          </h2>
          {result && (
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setLatexMode(!latexMode)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5"
                style={{
                  backgroundColor: latexMode ? '#7c3aed' : 'var(--bg-tertiary)',
                  color: latexMode ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${latexMode ? '#7c3aed' : 'var(--border-primary)'}`,
                }}
                title="Toggle LaTeX formula rendering"
              >
                <span style={{ fontFamily: 'serif', fontStyle: 'italic', fontWeight: 'bold', fontSize: '13px' }}>T<sub>E</sub>X</span>
                {latexMode ? ' ON' : ' OFF'}
              </button>
              <button
                onClick={onExport}
                disabled={exporting}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2"
                style={{
                  backgroundColor: exporting ? 'var(--bg-tertiary)' : '#3b82f6',
                  color: exporting ? 'var(--text-tertiary)' : '#fff',
                  cursor: exporting ? 'not-allowed' : 'pointer',
                }}
              >
                {exporting ? (
                  <>
                    <span className="animate-spin">⏳</span> Exporting...
                  </>
                ) : (
                  <>📄 Word</>
                )}
              </button>
              <button
                onClick={onExportLaTeX}
                disabled={exportingLaTeX}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2"
                style={{
                  backgroundColor: exportingLaTeX ? 'var(--bg-tertiary)' : '#059669',
                  color: exportingLaTeX ? 'var(--text-tertiary)' : '#fff',
                  cursor: exportingLaTeX ? 'not-allowed' : 'pointer',
                }}
              >
                {exportingLaTeX ? (
                  <>
                    <span className="animate-spin">⏳</span> Exporting...
                  </>
                ) : (
                  <>🔬 LaTeX</>
                )}
              </button>
            </div>
          )}
        </div>

        {result ? (
          <>
            {/* Voting Results */}
            {result.votingResults && (
              <div className="mb-6 p-4 rounded-lg" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                  🗳️ Voting Results
                </h3>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(result.votingResults.votes).map(([model, count]) => (
                    <div
                      key={model}
                      className={`px-3 py-2 rounded-lg text-sm ${model === result.votingResults!.winner ? 'ring-2 ring-blue-500' : ''}`}
                      style={{ backgroundColor: 'var(--bg-secondary)' }}
                    >
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{model}</span>
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {count} vote{count !== 1 ? 's' : ''} ({Math.round(count / result.votingResults!.totalVotes * 100)}%)
                      </span>
                      {model === result.votingResults!.winner && <span className="ml-1">🏆</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Executive Summary */}
            <div className="mb-6">
              <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Executive Summary
              </h3>
              <div
                className="prose prose-sm max-w-none"
                style={{ color: 'var(--text-primary)' }}
              >
                {latexMode ? (
                  <LatexBlock text={result.executiveSummary} className="mb-2" />
                ) : (
                  result.executiveSummary.split('\n').map((p, i) => (
                    <p key={i} className="mb-2">{p}</p>
                  ))
                )}
              </div>
            </div>

            {/* Key Findings */}
            <div className="mb-6">
              <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                Key Findings
              </h3>
              <div className="space-y-4">
                {result.keyFindings.map((finding, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border p-4"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                  >
                    <h4 className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      {latexMode ? (
                        <LatexText text={`${idx + 1}. ${finding.title}`} />
                      ) : (
                        <>{idx + 1}. {finding.title}</>
                      )}
                    </h4>
                    {latexMode ? (
                      <LatexBlock text={finding.content} className="text-sm mb-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }} />
                    ) : (
                      <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {finding.content}
                      </p>
                    )}
                    <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span>Confidence: {finding.confidence}%</span>
                      <span>Contributors: {finding.contributors.join(', ')}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Methodology */}
            <div
              className="rounded-lg p-4 text-sm"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              <div className="font-medium mb-2">Methodology</div>
              <div>Winning Draft: {result.methodology.leadModel}</div>
              <div>Other Drafters: {result.methodology.reviewers.join(', ')}</div>
              <div>Overall Confidence: {result.overallConfidence}%</div>
            </div>
          </>
        ) : (
          /* Show draft while generating */
          latexMode ? (
            <LatexBlock
              text={draft || 'Generating synthesis...'}
              className="prose prose-sm max-w-none whitespace-pre-wrap"
              style={{ color: 'var(--text-primary)' }}
            />
          ) : (
            <div
              className="prose prose-sm max-w-none whitespace-pre-wrap"
              style={{ color: 'var(--text-primary)' }}
            >
              {draft || 'Generating synthesis...'}
            </div>
          )
        )}
      </div>

      {/* Sidebar - Points of Difference */}
      <div
        className="rounded-2xl border-2 p-4 h-fit lg:sticky lg:top-24"
        style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: '#f59e0b' }}
      >
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          ⚡ Points of Difference
        </h3>

        {differences.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No significant differences identified. Models reached consensus on all major points.
          </p>
        ) : (
          <div className="space-y-4">
            {differences.map((diff, idx) => (
              <div
                key={idx}
                className="rounded-lg p-3"
                style={{ backgroundColor: 'var(--bg-secondary)' }}
              >
                <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
                  {latexMode ? <LatexText text={diff.topic} /> : diff.topic}
                </h4>
                <div className="space-y-3">
                  {diff.positions.map((pos, pidx) => (
                    <div
                      key={pidx}
                      className="rounded-lg p-2 border-l-4"
                      style={{
                        backgroundColor: `${pos.color}10`,
                        borderLeftColor: pos.color,
                        borderTop: `1px solid ${pos.color}30`,
                        borderRight: `1px solid ${pos.color}30`,
                        borderBottom: `1px solid ${pos.color}30`,
                      }}
                    >
                      <span
                        className="inline-block px-2 py-0.5 rounded-full text-white text-xs font-medium mb-1"
                        style={{ backgroundColor: pos.color }}
                      >
                        {pos.model}
                      </span>
                      {latexMode ? (
                        <LatexBlock text={pos.position} className="text-xs" style={{ color: 'var(--text-secondary)' }} />
                      ) : (
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{pos.position}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  // Theme is locked to 'dark'. The variable is kept for backward compatibility with
  // pieces of code that still read it, but no UI affordance lets the user change it.
  const [theme] = useState<Theme>('dark');
  const [question, setQuestion] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>(PRESETS.expert.models);
  const [activePreset, setActivePreset] = useState<string>('expert');
  const [thread, setThread] = useState<DiscussionEntry[]>([]);
  // Per-model card collapse state. Tap a card header to toggle.
  const [collapsedModels, setCollapsedModels] = useState<Set<string>>(new Set());
  const toggleCardCollapse = (modelId: string) => {
    setCollapsedModels(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      return next;
    });
  };
  const [file, setFile] = useState<FileAttachment | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingLaTeX, setExportingLaTeX] = useState(false);
  const [nsfwMode, setNsfwMode] = useState(false);
  const [synthesisMode, setSynthesisMode] = useState(false);
  const [synthesisPhase, setSynthesisPhase] = useState<string>('');
  const [synthesisWinnerModel, setSynthesisWinnerModel] = useState<string>('');
  const [synthesisResult, setSynthesisResult] = useState<{
    executiveSummary: string;
    keyFindings: { title: string; content: string; confidence: number; contributors: string[] }[];
    methodology: { leadModel: string; reviewers: string[] };
    overallConfidence: number;
    votingResults?: { winner: string; votes: Record<string, number>; totalVotes: number };
  } | null>(null);
  const [synthesisDifferences, setSynthesisDifferences] = useState<{
    topic: string;
    positions: { model: string; position: string; color: string }[];
  }[]>([]);
  const [synthesisDraft, setSynthesisDraft] = useState<string>('');
  const [synthesisDrafts, setSynthesisDrafts] = useState<Record<string, string>>({});
  const [synthesisVotes, setSynthesisVotes] = useState<Record<string, string>>({});
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
    // Theme is locked to dark — ignore any saved value from prior sessions.
    document.documentElement.setAttribute('data-theme', 'dark');
    // Load NSFW mode from localStorage
    const savedNsfw = localStorage.getItem('roundtable-nsfw-mode');
    if (savedNsfw === 'true') {
      setNsfwMode(true);
    }
    // Load Synthesis mode from localStorage
    const savedSynthesis = localStorage.getItem('roundtable-synthesis-mode');
    if (savedSynthesis === 'true') {
      setSynthesisMode(true);
    }
    // Load previously saved discussion thread so models retain memory across sessions.
    // Schema-versioned key so we can change shape later without colliding with old data.
    try {
      const savedThread = localStorage.getItem('roundtable-thread-v1');
      if (savedThread) {
        const parsed = JSON.parse(savedThread) as DiscussionEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) setThread(parsed);
      }
    } catch (e) {
      console.warn('Failed to restore thread from storage:', e);
    }
  }, []);

  // Persist thread to localStorage whenever it changes.
  // Skips writes when empty (instead removes the key) so a "+ New thread" actually clears storage.
  useEffect(() => {
    try {
      if (thread.length === 0) {
        localStorage.removeItem('roundtable-thread-v1');
      } else {
        localStorage.setItem('roundtable-thread-v1', JSON.stringify(thread));
      }
    } catch (e) {
      // QuotaExceeded or storage disabled — fail silently, in-memory thread still works for this session.
      console.warn('Failed to persist thread:', e);
    }
  }, [thread]);

  const toggleNsfwMode = () => {
    setNsfwMode(prev => {
      const newValue = !prev;
      localStorage.setItem('roundtable-nsfw-mode', String(newValue));
      return newValue;
    });
  };

  const toggleSynthesisMode = () => {
    setSynthesisMode(prev => {
      const newValue = !prev;
      localStorage.setItem('roundtable-synthesis-mode', String(newValue));
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

    // 5 minutes — matches Vercel's function max-duration. Discussion votes can think 60-180s
    // and synthesis phases (drafts, finalization) can run up to 360s timeout per step. If we
    // cross 300s without any activity event, the function has either died or hit a real wall —
    // showing "stuck" then is the right call.
    const STUCK_THRESHOLD_MS = 300000;
    const checkInterval = setInterval(() => {
      const timeSinceActivity = Date.now() - discussion.lastActivityTime;
      if (timeSinceActivity > STUCK_THRESHOLD_MS && !discussion.isStuck) {
        console.warn('Discussion appears stuck - no activity for 2 minutes');
        setDiscussion(p => ({ ...p, isStuck: true }));
      }
    }, 10000); // Check every 10 seconds

    return () => clearInterval(checkInterval);
  }, [discussion.status, discussion.lastActivityTime, discussion.isStuck]);

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

  const handleSynthesisExportDOCX = async () => {
    console.log('Synthesis Export DOCX clicked');
    if (!synthesisResult) {
      console.log('No synthesis result, returning');
      return;
    }
    setExporting(true);
    try {
      const reportData: SynthesisReportData = {
        question: discussion.currentQuestion,
        date: new Date().toLocaleDateString('ru-RU', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        synthesis: synthesisResult,
        differences: synthesisDifferences,
        models: selectedModels.map(id => {
          const model = getModel(id);
          return model?.name || id;
        }),
      };

      console.log('Generating Synthesis DOCX with data:', reportData);
      const blob = await generateSynthesisDOCX(reportData);
      console.log('Synthesis DOCX blob generated:', blob);
      downloadDOCX(blob, `AI_Roundtable_Synthesis_${new Date().toISOString().split('T')[0]}.docx`);
    } catch (e) {
      console.error(e);
    }
    setExporting(false);
  };

  const handleSynthesisExportLaTeX = () => {
    if (!synthesisResult) return;
    setExportingLaTeX(true);
    try {
      const reportData: SynthesisReportData = {
        question: discussion.currentQuestion,
        date: new Date().toLocaleDateString('ru-RU', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        synthesis: synthesisResult,
        differences: synthesisDifferences,
        models: selectedModels.map(id => {
          const model = getModel(id);
          return model?.name || id;
        }),
      };
      const tex = generateSynthesisLaTeX(reportData);
      const blob = new Blob([tex], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AI_Roundtable_Synthesis_${new Date().toISOString().split('T')[0]}.tex`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
    setExportingLaTeX(false);
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

      // Synthesis Mode Events
      case 'synthesis_mode_started':
        setSynthesisPhase('started');
        setSynthesisDraft('');
        setSynthesisDrafts({});
        setSynthesisVotes({});
        setSynthesisResult(null);
        setSynthesisDifferences([]);
        setSynthesisWinnerModel('');
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'analysis_phase_start':
        setSynthesisPhase('analysis');
        setDiscussion(p => ({ ...p, phase: 'synthesis_analysis', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'analysis_complete':
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'draft_phase_start':
        setSynthesisPhase('drafting');
        setSynthesisDrafts({});
        setDiscussion(p => ({ ...p, phase: 'synthesis_drafting', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'draft_token':
        // Now drafts come from all models
        if (data.model) {
          setSynthesisDrafts(prev => ({
            ...prev,
            [data.model as string]: (prev[data.model as string] || '') + (data.token as string)
          }));
        } else {
          // Fallback for finalization tokens
          setSynthesisDraft(prev => prev + (data.token as string));
        }
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'draft_complete':
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'review_phase_start':
        setSynthesisPhase('reviewing');
        setDiscussion(p => ({ ...p, phase: 'synthesis_reviewing', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'review_token':
        // Could show per-reviewer progress if needed
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'review_complete':
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'voting_phase_start':
        setSynthesisPhase('voting');
        setSynthesisVotes({});
        setDiscussion(p => ({ ...p, phase: 'synthesis_voting', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'vote_cast':
        setSynthesisVotes(prev => ({
          ...prev,
          [data.voter as string]: data.votedFor as string
        }));
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'voting_complete':
        setSynthesisWinnerModel(data.winner as string);
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'finalization_start':
        setSynthesisPhase('finalizing');
        setSynthesisDraft(''); // Clear draft, will get final
        setDiscussion(p => ({ ...p, phase: 'synthesis_finalizing', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'finalization_token':
        setSynthesisDraft(prev => prev + (data.token as string));
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'signoff_start':
        setSynthesisPhase('signoff');
        setDiscussion(p => ({ ...p, phase: 'synthesis_signoff', lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'signoff_complete':
        setDiscussion(p => ({ ...p, lastActivityTime: Date.now(), isStuck: false }));
        break;

      case 'synthesis_complete':
        setSynthesisPhase('complete');
        setSynthesisResult(data.report as typeof synthesisResult);
        setSynthesisDifferences(data.differences as typeof synthesisDifferences);
        setDiscussion(p => ({
          ...p,
          status: 'complete',
          phase: 'idle',
        }));
        break;

      case 'synthesis_error':
        setSynthesisPhase('error');
        setDiscussion(p => ({
          ...p,
          status: 'error',
          phase: 'synthesis_error',
        }));
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

    // Reset synthesis state
    setSynthesisPhase('');
    setSynthesisWinnerModel('');
    setSynthesisResult(null);
    setSynthesisDifferences([]);
    setSynthesisDraft('');
    setSynthesisDrafts({});
    setSynthesisVotes({});

    setDiscussion({
      status: 'running',
      phase: synthesisMode ? 'synthesis_starting' : 'thinking',
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

    // Build thread context: when continuing a conversation, send the full prior history
    // (capped server-side to MAX_THREAD_ROUNDS entries). Each entry includes the question,
    // every model's final response, and the consensus synthesis if reached.
    const threadForApi = isFollowUp
      ? thread.map(e => ({
          question: e.question,
          finalResponses: e.finalResponses,
          consensus: e.consensusResult?.synthesis,
        }))
      : undefined;

    try {
      const res = await fetch('/api/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: currentQuestion,
          models: selectedModels,
          thread: threadForApi,
          file: file || undefined,
          nsfwMode,
          synthesisMode,
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

    // Synthesis mode phases
    if (phase === 'synthesis_starting') return 'Starting synthesis mode...';
    if (phase === 'synthesis_analysis') return 'All models analyzing question...';
    if (phase === 'synthesis_drafting') return `All models writing drafts... (${Object.keys(synthesisDrafts).length} drafts)`;
    if (phase === 'synthesis_reviewing') return 'Cross-review in progress...';
    if (phase === 'synthesis_voting') return `Models voting for best draft... (${Object.keys(synthesisVotes).length} votes)`;
    if (phase === 'synthesis_finalizing') return `${synthesisWinnerModel || 'Winner'} finalizing synthesis...`;
    if (phase === 'synthesis_error') return 'Synthesis error';

    // Discussion mode phases
    if (phase === 'thinking') return `${roundLabel}: Models thinking... (${completedCount}/${totalCount})`;
    if (phase === 'all_complete') return `${roundLabel}: All done`;
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
  };

  const hasActiveThread = thread.length > 0 || discussion.status !== 'idle';

  // Starmap mode follows real app state:
  //  - Not running → idle (gentle balanced network)
  //  - Running + synthesis → focused funnel mode
  //  - Running otherwise → sprawling discussion mode
  const networkMode: StarMapMode =
    discussion.status !== 'running' ? 'idle' :
    synthesisMode ? 'synthesis' : 'discussion';

  return (
    <>
      <StarMapBackground
        mode={networkMode}
        labels={AVAILABLE_MODELS.map(m => ({ name: m.name, color: m.color }))}
        active={discussion.status === 'running'}
      />
      <main className="min-h-screen transition-colors relative" style={{ backgroundColor: 'transparent', paddingBottom: 140 }}>
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
            <span className="text-xs ml-1" style={{ color: 'var(--text-tertiary)' }}>v1.6.3</span>
          </div>
          <div className="flex items-center gap-4">
            {/* Synthesis Mode Toggle */}
            <button
              onClick={toggleSynthesisMode}
              disabled={discussion.status === 'running'}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                discussion.status === 'running' ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
              }`}
              style={{
                backgroundColor: synthesisMode ? '#3b82f6' : 'var(--bg-tertiary)',
                color: synthesisMode ? '#fff' : 'var(--text-secondary)',
                borderColor: synthesisMode ? '#3b82f6' : 'var(--border-primary)',
              }}
              title={synthesisMode ? 'Synthesis Mode: Generate unified report' : 'Discussion Mode: Debate and vote'}
            >
              {synthesisMode ? '📝 Synthesis' : '💬 Discussion'}
            </button>
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

        {/* Old in-flow input area removed — input is now a fixed bar at the bottom of the viewport.
            Hidden <input> for file picker still lives here so the ref is available. */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="image/*,.pdf"
          className="hidden"
        />

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
            {/* Synthesis Mode Progress */}
            {synthesisMode && discussion.phase.startsWith('synthesis') ? (
              <>
                <SynthesisProgress phase={synthesisPhase || discussion.phase} winnerModel={synthesisWinnerModel} />
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{getPhaseText()}</span>
                </div>
              </>
            ) : (
              /* Discussion Mode Progress */
              <>
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
              </>
            )}

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

        {/* Synthesis Mode - All Drafts Preview during drafting phase */}
        {discussion.status === 'running' && synthesisMode && (synthesisPhase === 'drafting' || synthesisPhase === 'synthesis_drafting') && Object.keys(synthesisDrafts).length > 0 && (
          <div
            className="mb-6 grid gap-4"
            style={{ gridTemplateColumns: `repeat(${Math.min(Object.keys(synthesisDrafts).length, 3)}, 1fr)` }}
          >
            {Object.entries(synthesisDrafts).map(([modelId, draft]) => {
              const model = getModel(modelId);
              return (
                <div
                  key={modelId}
                  className="rounded-xl border-2 overflow-hidden"
                  style={{ backgroundColor: 'var(--bg-secondary)', borderColor: model?.color || 'var(--border-primary)' }}
                >
                  <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-secondary)' }}>
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: model?.color || '#888' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{model?.name || modelId}</span>
                    <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>{draft.split(/\s+/).length} words</span>
                  </div>
                  <div className="p-4 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                    {draft.slice(0, 500)}
                    {draft.length > 500 && '...'}
                    <span className="animate-pulse">|</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Synthesis Mode - Voting Progress */}
        {discussion.status === 'running' && synthesisMode && (synthesisPhase === 'voting' || synthesisPhase === 'synthesis_voting') && (
          <div
            className="mb-6 p-6 rounded-xl border"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: '#8b5cf6' }}
          >
            <h3 className="text-sm font-medium mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              🗳️ Voting for Best Draft
            </h3>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(selectedModels.length, 3)}, 1fr)` }}>
              {selectedModels.map(modelId => {
                const model = getModel(modelId);
                const vote = synthesisVotes[model?.name || ''];
                return (
                  <div
                    key={modelId}
                    className="rounded-lg p-3 border"
                    style={{
                      backgroundColor: vote ? 'var(--success-bg)' : 'var(--bg-tertiary)',
                      borderColor: vote ? 'var(--success-text)' : 'var(--border-primary)'
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: model?.color || '#888' }} />
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{model?.name}</span>
                    </div>
                    {vote ? (
                      <div className="text-xs" style={{ color: 'var(--success-text)' }}>
                        Voted for: {vote}
                      </div>
                    ) : (
                      <div className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>
                        Voting...
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Synthesis Mode - Final synthesis generation */}
        {discussion.status === 'running' && synthesisMode && (synthesisPhase === 'finalizing' || synthesisPhase === 'synthesis_finalizing') && synthesisDraft && (
          <div
            className="mb-6 p-6 rounded-xl border"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
          >
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              ✨ Final Synthesis by {synthesisWinnerModel}
            </h3>
            <div
              className="prose prose-sm max-w-none whitespace-pre-wrap"
              style={{ color: 'var(--text-primary)' }}
            >
              {synthesisDraft}
              <span className="animate-pulse">|</span>
            </div>
          </div>
        )}

        {/* Model responses grid (Discussion mode or Synthesis analysis phase).
            Responsive: 1 col on mobile, 2 on tablet, 3 on desktop. Cards are tap-to-collapse. */}
        {discussion.status !== 'idle' && !synthesisMode && (
          <div className="grid gap-4 mb-8 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {Object.keys(discussion.modelStates).map(modelId => {
              const model = getModel(modelId);
              const state = discussion.modelStates[modelId];
              if (!model || !state) return null;

              const isWinner = discussion.consensusResult?.closest_to_truth === model.name;
              const isCollapsed = collapsedModels.has(modelId);

              // Preview text used when collapsed — first ~120 chars of latest response.
              const previewSource = state.currentResponse || state.history[state.history.length - 1] || '';
              const previewText = previewSource.replace(/\s+/g, ' ').slice(0, 120);

              return (
                <div
                  key={modelId}
                  className="rounded-2xl border overflow-hidden flex flex-col transition-shadow"
                  style={{
                    backgroundColor: 'var(--bg-secondary)',
                    borderColor: model.color + '66',
                    boxShadow: isWinner
                      ? `0 0 0 2px ${model.color}55, 0 8px 32px ${model.color}22`
                      : `0 4px 24px rgba(0,0,0,0.25)`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleCardCollapse(modelId)}
                    aria-expanded={!isCollapsed}
                    className="w-full text-left px-5 py-4 flex items-center justify-between hover:bg-white/5 transition-colors"
                    style={{
                      borderBottom: isCollapsed ? 'none' : `1px solid var(--border-secondary)`,
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{
                          backgroundColor: model.color,
                          boxShadow: state.streaming ? `0 0 12px ${model.color}` : 'none',
                        }}
                      />
                      <span className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{model.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {state.retrying && <span className="text-xs" style={{ color: 'var(--warning-text)' }}>🔄 {state.retryAttempt}/3</span>}
                      {state.streaming && !state.retrying && <span className="text-xs animate-pulse" style={{ color: 'var(--text-tertiary)' }}>thinking…</span>}
                      {state.completed && !state.streaming && <span className="text-xs" style={{ color: 'var(--success-text)' }}><CheckIcon /></span>}
                      {isWinner && <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}>🏆</span>}
                      <span style={{ color: 'var(--text-tertiary)' }}><ChevronIcon expanded={!isCollapsed} /></span>
                    </div>
                  </button>

                  {isCollapsed && previewText && (
                    <div className="px-5 pb-3 text-xs italic line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
                      {previewText}{previewSource.length > 120 ? '…' : ''}
                    </div>
                  )}

                  {!isCollapsed && (
                  <div
                    ref={el => { columnRefs.current[modelId] = el; }}
                    className="flex-1 p-5 max-h-[60vh] overflow-y-auto"
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
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Consensus result */}
        {/* Synthesis Mode Result */}
        {discussion.status === 'complete' && synthesisMode && (synthesisResult || synthesisDraft) && (
          <div ref={consensusRef}>
            <SynthesisReport
              result={synthesisResult}
              differences={synthesisDifferences}
              draft={synthesisDraft}
              question={discussion.currentQuestion}
              selectedModels={selectedModels}
              exporting={exporting}
              onExport={handleSynthesisExportDOCX}
              exportingLaTeX={exportingLaTeX}
              onExportLaTeX={handleSynthesisExportLaTeX}
            />
          </div>
        )}

        {/* Discussion Mode Result */}
        {discussion.status === 'complete' && !synthesisMode && discussion.consensusResult && (
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

    {/* Model labels are now rendered inside the StarMapBackground canvas so they
        move/rotate/breathe together with the network (but the text itself stays upright). */}

    {/* ===== Fixed bottom prompt bar (x.ai-style) =====
        Centered, max-w-3xl on desktop, full-width with padding on mobile.
        Single arrow button that toggles to a stop square while running. */}
    <div
      className="fixed bottom-0 left-0 right-0 z-20"
      style={{
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        paddingLeft: 12, paddingRight: 12, paddingTop: 24,
        background: 'linear-gradient(to top, rgba(2,4,12,0.55) 30%, rgba(2,4,12,0) 100%)',
      }}
    >
      <div className="mx-auto" style={{ maxWidth: 760 }}>
        <div
          className="flex items-end gap-2 rounded-3xl border px-3 py-2"
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderColor: nsfwMode ? 'rgba(255,80,80,0.45)' : 'var(--border-primary)',
            boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
          }}
        >
          {/* File attach */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={discussion.status === 'running'}
            className="p-2 rounded-full transition-opacity"
            style={{ color: 'var(--text-tertiary)', opacity: discussion.status === 'running' ? 0.3 : 1 }}
            aria-label="Attach file"
          >
            <FileIcon />
          </button>

          {/* Textarea: auto-grow 1-5 rows */}
          <textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={thread.length > 0 ? 'Ask a follow-up…' : 'Ask anything…'}
            rows={1}
            className="flex-1 bg-transparent focus:outline-none resize-none py-2 px-1"
            style={{
              color: 'var(--text-primary)',
              fontSize: 16,
              lineHeight: '24px',
              maxHeight: 168, // ~7 lines
              minHeight: 24,
            }}
            disabled={discussion.status === 'running'}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && question.trim() && selectedModels.length >= 2) {
                e.preventDefault();
                startDiscussion(thread.length > 0);
              }
            }}
            onInput={e => {
              // Auto-resize: reset height then grow to scrollHeight up to maxHeight.
              const ta = e.currentTarget;
              ta.style.height = 'auto';
              ta.style.height = Math.min(168, ta.scrollHeight) + 'px';
            }}
          />

          {/* Send / Stop button */}
          {discussion.status === 'running' ? (
            <button
              onClick={stopDiscussion}
              className="rounded-full flex items-center justify-center transition-transform active:scale-95"
              style={{ width: 36, height: 36, backgroundColor: '#ef4444', color: '#fff' }}
              aria-label="Stop"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={() => startDiscussion(thread.length > 0)}
              disabled={!question.trim() || selectedModels.length < 2}
              className="rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-30"
              style={{
                width: 36, height: 36,
                backgroundColor: question.trim() ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: question.trim() ? 'var(--accent-text)' : 'var(--text-tertiary)',
              }}
              aria-label="Send"
            >
              <SendIcon />
            </button>
          )}
        </div>

        {/* File pill below the prompt */}
        {file && (
          <div
            className="mt-2 mx-auto flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
            style={{
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              width: 'fit-content',
              maxWidth: '100%',
            }}
          >
            <FileIcon />
            <span className="truncate" style={{ maxWidth: 220 }}>{file.name}</span>
            <button onClick={removeFile} className="ml-1" style={{ color: 'var(--text-tertiary)' }} aria-label="Remove file">
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
