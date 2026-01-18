'use client';

import { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

interface ModelResponse {
  modelId: string;
  modelName: string;
  color: string;
  initialResponse: string;
  discussionResponses: string[];
}

interface ConsensusResult {
  consensus_reached: boolean;
  similarity_score: number;
  synthesis?: string;
  camps?: { position: string; participants: string[] }[];
  key_agreements: string[];
  key_disagreements: string[];
  closest_to_truth?: string;
  closest_to_truth_reason?: string;
}

interface ReportData {
  question: string;
  date: string;
  iterations: number;
  models: ModelResponse[];
  consensusResult: ConsensusResult;
}

interface ReportGeneratorProps {
  data: ReportData;
  onClose: () => void;
}

export default function ReportGenerator({ data, onClose }: ReportGeneratorProps) {
  const reportRef = useRef<HTMLDivElement>(null);
  const [generating, setGenerating] = useState(false);

  const generatePDF = async () => {
    if (!reportRef.current) return;
    setGenerating(true);

    try {
      const element = reportRef.current;
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 800,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pdfWidth - 20; // 10mm margins
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      
      let heightLeft = imgHeight;
      let position = 10; // top margin
      let page = 1;

      // First page
      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= (pdfHeight - 20);

      // Additional pages if needed
      while (heightLeft > 0) {
        position = heightLeft - imgHeight + 10;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= (pdfHeight - 20);
        page++;
      }

      const sanitizedQuestion = data.question.slice(0, 30).replace(/[^a-zA-Z0-9а-яА-Я]/g, '_');
      const dateStr = new Date().toISOString().split('T')[0];
      pdf.save(`AI_Roundtable_${sanitizedQuestion}_${dateStr}.pdf`);
    } catch (error) {
      console.error('PDF generation error:', error);
    } finally {
      setGenerating(false);
    }
  };

  const lightenColor = (color: string, amount: number) => {
    const hex = color.replace('#', '');
    const r = Math.min(255, parseInt(hex.slice(0, 2), 16) + amount);
    const g = Math.min(255, parseInt(hex.slice(2, 4), 16) + amount);
    const b = Math.min(255, parseInt(hex.slice(4, 6), 16) + amount);
    return `rgb(${r}, ${g}, ${b})`;
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-auto">
      <div className="bg-white rounded-2xl max-w-4xl w-full my-8 shadow-2xl">
        {/* Toolbar */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10 rounded-t-2xl">
          <h2 className="text-lg font-semibold text-gray-900">📄 Report Preview</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={generatePDF}
              disabled={generating}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {generating ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Download PDF
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Report Content - This gets converted to PDF */}
        <div className="p-6 overflow-auto max-h-[80vh]">
          <div ref={reportRef} className="bg-white p-8" style={{ width: '760px', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            
            {/* Header */}
            <div className="border-b-2 border-gray-200 pb-6 mb-8">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg">
                  <span className="text-white font-bold text-xl">RT</span>
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-gray-900">AI Roundtable</h1>
                  <p className="text-gray-500">Multi-Model Consensus Report</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600 mt-4">
                <span className="flex items-center gap-1.5 bg-gray-100 px-3 py-1.5 rounded-full">
                  📅 {data.date}
                </span>
                <span className="flex items-center gap-1.5 bg-gray-100 px-3 py-1.5 rounded-full">
                  🔄 {data.iterations} round{data.iterations > 1 ? 's' : ''} of discussion
                </span>
                <span className="flex items-center gap-1.5 bg-gray-100 px-3 py-1.5 rounded-full">
                  🤖 {data.models.length} AI models
                </span>
                <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full ${
                  data.consensusResult.consensus_reached 
                    ? 'bg-green-100 text-green-700' 
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {data.consensusResult.consensus_reached ? '✓ Consensus' : '⚡ Diverse Views'}
                </span>
              </div>
            </div>

            {/* Question */}
            <div className="mb-8">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">📝 QUESTION DISCUSSED</h2>
              <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-2xl p-6 border border-blue-100">
                <p className="text-xl text-gray-900 font-medium leading-relaxed">{data.question}</p>
              </div>
            </div>

            {/* Consensus Summary */}
            <div className="mb-8">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">🎯 FINAL CONCLUSION</h2>
              <div className={`rounded-2xl p-6 border-2 ${
                data.consensusResult.consensus_reached 
                  ? 'bg-green-50 border-green-200' 
                  : 'bg-amber-50 border-amber-200'
              }`}>
                <div className="flex items-center gap-4 mb-4">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl ${
                    data.consensusResult.consensus_reached ? 'bg-green-100' : 'bg-amber-100'
                  }`}>
                    {data.consensusResult.consensus_reached ? '✓' : '⚡'}
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">
                      {data.consensusResult.consensus_reached ? 'Models Reached Consensus' : 'Models Hold Different Positions'}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="h-2 w-32 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${data.consensusResult.consensus_reached ? 'bg-green-500' : 'bg-amber-500'}`}
                          style={{ width: `${data.consensusResult.similarity_score * 100}%` }}
                        />
                      </div>
                      <span className="text-sm text-gray-600">{Math.round(data.consensusResult.similarity_score * 100)}% agreement</span>
                    </div>
                  </div>
                </div>
                {data.consensusResult.synthesis && (
                  <p className="text-gray-800 leading-relaxed whitespace-pre-wrap">{data.consensusResult.synthesis}</p>
                )}
                {!data.consensusResult.synthesis && data.consensusResult.camps && (
                  <div className="space-y-3 mt-4">
                    {data.consensusResult.camps.map((camp, idx) => (
                      <div key={idx} className="bg-white/60 rounded-xl p-4">
                        <p className="text-xs text-gray-500 mb-1 font-medium">{camp.participants?.join(', ')}</p>
                        <p className="text-gray-800">{camp.position}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Key Points Grid */}
            <div className="grid grid-cols-2 gap-6 mb-8">
              {data.consensusResult.key_agreements?.length > 0 && (
                <div className="bg-green-50 rounded-2xl p-5 border border-green-100">
                  <h3 className="text-sm font-bold text-green-700 mb-3 flex items-center gap-2">
                    <span className="w-6 h-6 bg-green-200 rounded-full flex items-center justify-center text-xs">✓</span>
                    All Models Agree
                  </h3>
                  <ul className="space-y-2">
                    {data.consensusResult.key_agreements.map((point, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="text-green-500 mt-0.5 font-bold">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.consensusResult.key_disagreements?.length > 0 && (
                <div className="bg-orange-50 rounded-2xl p-5 border border-orange-100">
                  <h3 className="text-sm font-bold text-orange-700 mb-3 flex items-center gap-2">
                    <span className="w-6 h-6 bg-orange-200 rounded-full flex items-center justify-center text-xs">⚡</span>
                    Points of Difference
                  </h3>
                  <ul className="space-y-2">
                    {data.consensusResult.key_disagreements.map((point, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="text-orange-500 mt-0.5 font-bold">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Winner */}
            {data.consensusResult.closest_to_truth && (
              <div className="mb-8 bg-gradient-to-r from-amber-50 to-yellow-50 rounded-2xl p-5 border-2 border-amber-200">
                <h3 className="text-sm font-bold text-amber-700 mb-2 flex items-center gap-2">
                  <span className="text-xl">🏆</span>
                  Best Initial Answer
                </h3>
                <p className="font-bold text-gray-900 text-lg">{data.consensusResult.closest_to_truth}</p>
                {data.consensusResult.closest_to_truth_reason && (
                  <p className="text-sm text-gray-600 mt-1">{data.consensusResult.closest_to_truth_reason}</p>
                )}
              </div>
            )}

            {/* Divider */}
            <div className="flex items-center gap-4 my-10">
              <div className="flex-1 h-px bg-gray-200"></div>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Full Discussion Transcript</span>
              <div className="flex-1 h-px bg-gray-200"></div>
            </div>

            {/* Model Responses */}
            <div className="space-y-8">
              {data.models.map((model) => {
                const isWinner = data.consensusResult.closest_to_truth === model.modelName;
                
                return (
                  <div key={model.modelId} className="rounded-2xl border-2 overflow-hidden" style={{ borderColor: model.color }}>
                    {/* Model Header */}
                    <div 
                      className="px-6 py-4 flex items-center justify-between"
                      style={{ backgroundColor: lightenColor(model.color, 200) }}
                    >
                      <div className="flex items-center gap-3">
                        <div 
                          className="w-4 h-4 rounded-full shadow-sm" 
                          style={{ backgroundColor: model.color }}
                        />
                        <span className="font-bold text-gray-900 text-lg">{model.modelName}</span>
                        {isWinner && (
                          <span className="text-sm px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full font-medium">
                            🏆 Best
                          </span>
                        )}
                      </div>
                      <span className="text-sm text-gray-500">
                        {1 + model.discussionResponses.length} response{model.discussionResponses.length > 0 ? 's' : ''}
                      </span>
                    </div>
                    
                    {/* Initial Response (Round 1) */}
                    <div className="p-6 border-b" style={{ borderColor: lightenColor(model.color, 180) }}>
                      <div className="flex items-center gap-2 mb-3">
                        <span 
                          className="text-xs font-bold px-3 py-1.5 rounded-full text-white"
                          style={{ backgroundColor: model.color }}
                        >
                          Round 1
                        </span>
                        <span className="text-xs font-medium text-gray-500">Initial Position</span>
                      </div>
                      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                        {model.initialResponse || '(No response recorded)'}
                      </p>
                    </div>

                    {/* Discussion Responses (Round 2+) */}
                    {model.discussionResponses.map((response, idx) => (
                      <div 
                        key={idx} 
                        className="p-6 border-b last:border-b-0"
                        style={{ 
                          backgroundColor: lightenColor(model.color, 240),
                          borderColor: lightenColor(model.color, 180)
                        }}
                      >
                        <div className="flex items-center gap-2 mb-3">
                          <span 
                            className="text-xs font-bold px-3 py-1.5 rounded-full"
                            style={{ 
                              backgroundColor: lightenColor(model.color, 180),
                              color: model.color
                            }}
                          >
                            Round {idx + 2}
                          </span>
                          <span className="text-xs font-medium text-gray-500">
                            💬 Response to Colleagues
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{response}</p>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="border-t-2 border-gray-200 pt-6 mt-10">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
                    <span className="text-white font-bold text-xs">RT</span>
                  </div>
                  <span>Generated by AI Roundtable</span>
                </div>
                <span>{data.date}</span>
              </div>
              <p className="text-xs text-gray-400 mt-2 text-center">
                Models: {data.models.map(m => m.modelName).join(' • ')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
