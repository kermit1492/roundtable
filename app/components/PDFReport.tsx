'use client';

import { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType, VerticalAlign, ShadingType } from 'docx';

export interface ModelResponse {
  modelId: string;
  modelName: string;
  color: string;
  responses: { round: number; text: string; isInitial: boolean }[];
}

export interface GroupedAgreement {
  point: string;
  count: number;
  models: string[];
}

export interface DisagreementSide {
  position: string;
  models: string[];
}

export interface GroupedDisagreement {
  point: string;
  sides: DisagreementSide[];
}

export interface ConsensusResult {
  consensus_reached: boolean;
  consensus_type?: 'full' | 'partial' | 'none';
  similarity_score: number;
  synthesis?: string;
  syntheses?: { modelName: string; synthesis: string }[];
  camps?: { position: string; participants: string[] }[];
  key_agreements: GroupedAgreement[];
  key_disagreements: GroupedDisagreement[];
  closest_to_truth?: string;
  closest_to_truth_reason?: string;
  votes?: { yes: number; total: number; ratio: number };
  individual_votes?: { model: string; vote: string; score: number; reasoning: string }[];
  is_final_round?: boolean;
  models_agreed?: string[];
  models_disagreed?: string[];
}

export interface VotingRound {
  votes: Array<{
    modelName: string;
    consensusReached: boolean;
    similarityScore: number;
    reasoning: string;
  }>;
  consensusType: string;
  yesCount: number;
  totalCount: number;
}

export interface ReportData {
  question: string;
  date: string;
  iterations: number;
  models: ModelResponse[];
  consensusResult: ConsensusResult;
  votingHistory?: Record<number, VotingRound>;
}

function generateMarkdown(data: ReportData): string {
  const lines: string[] = [];

  // Header
  lines.push('# AI Roundtable Report');
  lines.push('');
  lines.push(`**Date:** ${data.date}`);
  lines.push(`**Rounds:** ${data.iterations}`);
  lines.push(`**Models:** ${data.models.map(m => m.modelName).join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Question
  lines.push('## Question');
  lines.push('');
  lines.push(`> ${data.question}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Conclusion
  lines.push('## Conclusion');
  lines.push('');

  const consensusTypeText = data.consensusResult.consensus_type === 'full'
    ? 'Full Consensus'
    : data.consensusResult.consensus_type === 'partial'
      ? 'Partial Consensus'
      : 'No Consensus';
  const consensusEmoji = data.consensusResult.consensus_type === 'full' ? '[FULL]' :
    data.consensusResult.consensus_type === 'partial' ? '[PARTIAL]' : '[NONE]';
  lines.push(`### ${consensusEmoji} ${consensusTypeText}`);
  lines.push(`**Agreement Level:** ${Math.round(data.consensusResult.similarity_score * 100)}%`);

  if (data.consensusResult.is_final_round) {
    lines.push(`**Status:** Final Round (5/5)`);
  }

  if (data.consensusResult.models_agreed && data.consensusResult.models_agreed.length > 0) {
    lines.push(`**Models Agreed:** ${data.consensusResult.models_agreed.join(', ')}`);
  }
  if (data.consensusResult.models_disagreed && data.consensusResult.models_disagreed.length > 0) {
    lines.push(`**Models Disagreed:** ${data.consensusResult.models_disagreed.join(', ')}`);
  }
  lines.push('');

  // Best answer
  if (data.consensusResult.closest_to_truth) {
    lines.push(`### Best Initial Answer: **${data.consensusResult.closest_to_truth}**`);
    if (data.consensusResult.closest_to_truth_reason) {
      lines.push(`> ${data.consensusResult.closest_to_truth_reason}`);
    }
    lines.push('');
  }

  // Syntheses from models
  if (data.consensusResult.syntheses && data.consensusResult.syntheses.length > 0) {
    lines.push('### Model Syntheses');
    lines.push('');
    for (const s of data.consensusResult.syntheses) {
      lines.push(`**${s.modelName}:**`);
      lines.push(s.synthesis);
      lines.push('');
    }
  } else if (data.consensusResult.synthesis) {
    lines.push('### Synthesis');
    lines.push(data.consensusResult.synthesis);
    lines.push('');
  }

  // Agreements
  if (data.consensusResult.key_agreements?.length > 0) {
    lines.push('### Points of Agreement');
    lines.push('');
    for (const agreement of data.consensusResult.key_agreements) {
      const modelsStr = agreement.models?.length > 0 ? ` (${agreement.models.join(', ')})` : '';
      lines.push(`- ${agreement.point}${modelsStr}`);
    }
    lines.push('');
  }

  // Disagreements
  if (data.consensusResult.key_disagreements?.length > 0) {
    lines.push('### Points of Disagreement');
    lines.push('');
    for (const disagreement of data.consensusResult.key_disagreements) {
      lines.push(`- **${disagreement.point}**`);
      if (disagreement.sides?.length > 0) {
        for (const side of disagreement.sides) {
          lines.push(`  - ${side.models.join(', ')}: ${side.position}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Discussion by Rounds (chronological order)
  lines.push('## Full Discussion');
  lines.push('');

  // Find max rounds across all models
  const maxRounds = Math.max(...data.models.map(m => m.responses.length));

  for (let round = 1; round <= maxRounds; round++) {
    const isFinalRound = round === 5;
    const roundType = round === 1 ? 'Round 1 — Initial Positions' :
      isFinalRound ? `Round ${round} — Final Round` : `Round ${round} — Responses`;

    lines.push(`### ${roundType}`);
    lines.push('');

    // Model responses for this round
    for (const model of data.models) {
      const response = model.responses.find(r => r.round === round);
      if (response) {
        const isBest = data.consensusResult.closest_to_truth === model.modelName;
        const badge = isBest ? ' [BEST]' : '';

        lines.push(`#### ${model.modelName}${badge}`);
        lines.push('');
        lines.push(response.text);
        lines.push('');
      }
    }

    // Voting results for this round
    if (data.votingHistory && data.votingHistory[round]) {
      const voting = data.votingHistory[round];
      lines.push('');
      lines.push(`#### Voting Results (Round ${round})`);
      lines.push('');

      const statusText = voting.consensusType === 'full' ? 'Full Consensus' :
        voting.consensusType === 'partial' ? 'Partial Consensus' : 'No Consensus';
      lines.push(`**Status:** ${statusText} (${voting.yesCount}/${voting.totalCount} agreed)`);
      lines.push('');

      for (const vote of voting.votes) {
        const voteIcon = vote.consensusReached ? '[YES]' : '[NO]';
        const confidence = Math.round(vote.similarityScore * 100);
        lines.push(`**${vote.modelName}** ${voteIcon} (${confidence}% confidence)`);
        lines.push(`> ${vote.reasoning}`);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push(`*Generated by AI Roundtable | ${data.date}*`);

  return lines.join('\n');
}

export async function generatePDF(data: ReportData): Promise<Blob> {
  const markdown = generateMarkdown(data);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  return blob;
}

export function downloadPDF(blob: Blob, filename: string) {
  // Change extension to .md
  const mdFilename = filename.replace(/\.pdf$/i, '.md');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = mdFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Generate Word document
export async function generateDOCX(data: ReportData): Promise<Blob> {
  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      text: 'AI Roundtable Report',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    })
  );

  // Metadata
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'Date: ', bold: true }),
      new TextRun({ text: data.date }),
    ],
  }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'Rounds: ', bold: true }),
      new TextRun({ text: String(data.iterations) }),
    ],
  }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'Models: ', bold: true }),
      new TextRun({ text: data.models.map(m => m.modelName).join(', ') }),
    ],
  }));

  // Question
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    text: 'Question',
    heading: HeadingLevel.HEADING_1,
  }));
  children.push(new Paragraph({
    text: data.question,
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: '808080' },
    },
    indent: { left: 720 },
  }));

  // Conclusion
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    text: 'Conclusion',
    heading: HeadingLevel.HEADING_1,
  }));

  const consensusTypeText = data.consensusResult.consensus_type === 'full'
    ? 'Full Consensus'
    : data.consensusResult.consensus_type === 'partial'
      ? 'Partial Consensus'
      : 'No Consensus';

  children.push(new Paragraph({
    children: [
      new TextRun({ text: `Status: ${consensusTypeText}`, bold: true }),
    ],
  }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: `Agreement Level: ${Math.round(data.consensusResult.similarity_score * 100)}%` }),
    ],
  }));

  if (data.consensusResult.models_agreed && data.consensusResult.models_agreed.length > 0) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Models Agreed: ', bold: true }),
        new TextRun({ text: data.consensusResult.models_agreed.join(', ') }),
      ],
    }));
  }

  if (data.consensusResult.models_disagreed && data.consensusResult.models_disagreed.length > 0) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Models Disagreed: ', bold: true }),
        new TextRun({ text: data.consensusResult.models_disagreed.join(', ') }),
      ],
    }));
  }

  // Syntheses
  if (data.consensusResult.syntheses && data.consensusResult.syntheses.length > 0) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({
      text: 'Model Syntheses',
      heading: HeadingLevel.HEADING_2,
    }));
    for (const s of data.consensusResult.syntheses) {
      children.push(new Paragraph({
        children: [new TextRun({ text: s.modelName, bold: true })],
      }));
      children.push(new Paragraph({ text: s.synthesis }));
      children.push(new Paragraph({ text: '' }));
    }
  }

  // Agreements
  if (data.consensusResult.key_agreements?.length > 0) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({
      text: 'Points of Agreement',
      heading: HeadingLevel.HEADING_2,
    }));
    for (const agreement of data.consensusResult.key_agreements) {
      const modelsStr = agreement.models?.length > 0 ? ` (${agreement.models.join(', ')})` : '';
      children.push(new Paragraph({
        text: `• ${agreement.point}${modelsStr}`,
        indent: { left: 360 },
      }));
    }
  }

  // Disagreements
  if (data.consensusResult.key_disagreements?.length > 0) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({
      text: 'Points of Disagreement',
      heading: HeadingLevel.HEADING_2,
    }));
    for (const disagreement of data.consensusResult.key_disagreements) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `• ${disagreement.point}`, bold: true })],
        indent: { left: 360 },
      }));
      if (disagreement.sides?.length > 0) {
        for (const side of disagreement.sides) {
          children.push(new Paragraph({
            text: `  - ${side.models.join(', ')}: ${side.position}`,
            indent: { left: 720 },
          }));
        }
      }
    }
  }

  // Discussion
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    text: 'Full Discussion',
    heading: HeadingLevel.HEADING_1,
  }));

  const maxRounds = Math.max(...data.models.map(m => m.responses.length));

  for (let round = 1; round <= maxRounds; round++) {
    const isFinalRound = round === 5;
    const roundType = round === 1 ? 'Round 1 — Initial Positions' :
      isFinalRound ? `Round ${round} — Final Round` : `Round ${round} — Responses`;

    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({
      text: roundType,
      heading: HeadingLevel.HEADING_2,
    }));

    // Model responses
    for (const model of data.models) {
      const response = model.responses.find(r => r.round === round);
      if (response) {
        const isBest = data.consensusResult.closest_to_truth === model.modelName;
        const badge = isBest ? ' [BEST]' : '';

        children.push(new Paragraph({
          children: [new TextRun({ text: `${model.modelName}${badge}`, bold: true })],
        }));
        children.push(new Paragraph({ text: response.text }));
        children.push(new Paragraph({ text: '' }));
      }
    }

    // Voting results
    if (data.votingHistory && data.votingHistory[round]) {
      const voting = data.votingHistory[round];

      children.push(new Paragraph({
        children: [new TextRun({ text: `Voting Results (Round ${round})`, bold: true, italics: true })],
      }));

      const statusText = voting.consensusType === 'full' ? 'Full Consensus' :
        voting.consensusType === 'partial' ? 'Partial Consensus' : 'No Consensus';
      children.push(new Paragraph({
        text: `Status: ${statusText} (${voting.yesCount}/${voting.totalCount} agreed)`,
      }));

      for (const vote of voting.votes) {
        const voteIcon = vote.consensusReached ? '[YES]' : '[NO]';
        const confidence = Math.round(vote.similarityScore * 100);
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${vote.modelName} ${voteIcon}`, bold: true }),
            new TextRun({ text: ` (${confidence}% confidence)` }),
          ],
        }));
        children.push(new Paragraph({
          text: vote.reasoning,
          border: {
            left: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' },
          },
          indent: { left: 360 },
        }));
      }
      children.push(new Paragraph({ text: '' }));
    }
  }

  // Footer
  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: `Generated by AI Roundtable | ${data.date}`, italics: true }),
    ],
    alignment: AlignmentType.CENTER,
  }));

  const doc = new Document({
    sections: [{
      properties: {},
      children,
    }],
  });

  return await Packer.toBlob(doc);
}

export function downloadDOCX(blob: Blob, filename: string) {
  const docxFilename = filename.replace(/\.(pdf|md)$/i, '.docx');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = docxFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ============================================
// SYNTHESIS MODE EXPORTS
// ============================================

export interface SynthesisReportData {
  question: string;
  date: string;
  synthesis: {
    executiveSummary: string;
    keyFindings: { title: string; content: string; confidence: number; contributors: string[] }[];
    methodology: { leadModel: string; reviewers: string[] };
    overallConfidence: number;
    votingResults?: { winner: string; votes: Record<string, number>; totalVotes: number };
  };
  differences: {
    topic: string;
    positions: { model: string; position: string; color: string }[];
  }[];
  models: string[];
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 128, g: 128, b: 128 };
}

function generateSynthesisMarkdown(data: SynthesisReportData): string {
  const lines: string[] = [];

  // Header
  lines.push('# AI Roundtable - Synthesis Report');
  lines.push('');
  lines.push(`**Date:** ${data.date}`);
  lines.push(`**Models:** ${data.models.join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Question
  lines.push('## Question');
  lines.push('');
  lines.push(`> ${data.question}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Voting Results
  if (data.synthesis.votingResults) {
    lines.push('## 🗳️ Voting Results');
    lines.push('');
    lines.push(`**Winner:** ${data.synthesis.votingResults.winner} 🏆`);
    lines.push('');
    for (const [model, count] of Object.entries(data.synthesis.votingResults.votes)) {
      const percentage = Math.round(count / data.synthesis.votingResults.totalVotes * 100);
      const isWinner = model === data.synthesis.votingResults.winner;
      lines.push(`- **${model}**: ${count} vote${count !== 1 ? 's' : ''} (${percentage}%)${isWinner ? ' 🏆' : ''}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(data.synthesis.executiveSummary);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Key Findings
  lines.push('## Key Findings');
  lines.push('');
  data.synthesis.keyFindings.forEach((finding, idx) => {
    lines.push(`### ${idx + 1}. ${finding.title}`);
    lines.push('');
    lines.push(finding.content);
    lines.push('');
    lines.push(`*Confidence: ${finding.confidence}% | Contributors: ${finding.contributors.join(', ')}*`);
    lines.push('');
  });
  lines.push('---');
  lines.push('');

  // Points of Difference
  if (data.differences.length > 0) {
    lines.push('## ⚡ Points of Difference');
    lines.push('');
    data.differences.forEach(diff => {
      lines.push(`### ${diff.topic}`);
      lines.push('');
      diff.positions.forEach(pos => {
        lines.push(`**${pos.model}:** ${pos.position}`);
        lines.push('');
      });
    });
    lines.push('---');
    lines.push('');
  }

  // Methodology
  lines.push('## Methodology');
  lines.push('');
  lines.push(`- **Winning Draft:** ${data.synthesis.methodology.leadModel}`);
  lines.push(`- **Other Drafters:** ${data.synthesis.methodology.reviewers.join(', ')}`);
  lines.push(`- **Overall Confidence:** ${data.synthesis.overallConfidence}%`);
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`*Generated by AI Roundtable - Synthesis Mode | ${data.date}*`);

  return lines.join('\n');
}

export async function generateSynthesisPDF(data: SynthesisReportData): Promise<Blob> {
  const markdown = generateSynthesisMarkdown(data);
  return new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
}

export async function generateSynthesisDOCX(data: SynthesisReportData): Promise<Blob> {
  // Build main content (left column)
  const mainContent: Paragraph[] = [];

  // Title with winner badge
  const titleChildren = [
    new TextRun({ text: '📝 Unified Synthesis', bold: true, size: 32 }),
  ];
  if (data.synthesis.votingResults) {
    titleChildren.push(
      new TextRun({ text: '   ' }),
      new TextRun({ text: `🏆 Winner: ${data.synthesis.votingResults.winner}`, size: 20, color: '1d4ed8' })
    );
  }
  mainContent.push(new Paragraph({ children: titleChildren }));
  mainContent.push(new Paragraph({ text: '' }));

  // Voting Results (if exists)
  if (data.synthesis.votingResults) {
    mainContent.push(new Paragraph({
      children: [new TextRun({ text: '🗳️ Voting Results', bold: true, size: 24 })],
      shading: { type: ShadingType.SOLID, color: 'F3F4F6' },
    }));
    mainContent.push(new Paragraph({ text: '' }));
    for (const [model, count] of Object.entries(data.synthesis.votingResults.votes)) {
      const percentage = Math.round(count / data.synthesis.votingResults.totalVotes * 100);
      const isWinner = model === data.synthesis.votingResults.winner;
      mainContent.push(new Paragraph({
        children: [
          new TextRun({ text: model, bold: true }),
          new TextRun({ text: ` — ${count} vote${count !== 1 ? 's' : ''} (${percentage}%)` }),
          new TextRun({ text: isWinner ? ' 🏆' : '' }),
        ],
        indent: { left: 360 },
      }));
    }
    mainContent.push(new Paragraph({ text: '' }));
  }

  // Executive Summary
  mainContent.push(new Paragraph({
    children: [new TextRun({ text: 'Executive Summary', bold: true, size: 24 })],
  }));
  mainContent.push(new Paragraph({ text: '' }));
  // Split by paragraphs
  data.synthesis.executiveSummary.split('\n').forEach(para => {
    if (para.trim()) {
      mainContent.push(new Paragraph({ text: para.trim() }));
    }
  });
  mainContent.push(new Paragraph({ text: '' }));

  // Key Findings
  mainContent.push(new Paragraph({
    children: [new TextRun({ text: 'Key Findings', bold: true, size: 24 })],
  }));
  mainContent.push(new Paragraph({ text: '' }));

  data.synthesis.keyFindings.forEach((finding, idx) => {
    mainContent.push(new Paragraph({
      children: [new TextRun({ text: `${idx + 1}. ${finding.title}`, bold: true })],
      shading: { type: ShadingType.SOLID, color: 'F9FAFB' },
      border: {
        left: { style: BorderStyle.SINGLE, size: 12, color: '3B82F6' },
      },
    }));
    mainContent.push(new Paragraph({ text: finding.content }));
    mainContent.push(new Paragraph({
      children: [
        new TextRun({ text: `Confidence: ${finding.confidence}%`, italics: true, color: '6B7280' }),
        new TextRun({ text: ` | Contributors: ${finding.contributors.join(', ')}`, italics: true, color: '6B7280' }),
      ],
    }));
    mainContent.push(new Paragraph({ text: '' }));
  });

  // Methodology
  mainContent.push(new Paragraph({
    children: [new TextRun({ text: 'Methodology', bold: true, size: 24 })],
    shading: { type: ShadingType.SOLID, color: 'F9FAFB' },
  }));
  mainContent.push(new Paragraph({
    children: [
      new TextRun({ text: 'Winning Draft: ', bold: true }),
      new TextRun({ text: data.synthesis.methodology.leadModel }),
    ],
  }));
  mainContent.push(new Paragraph({
    children: [
      new TextRun({ text: 'Other Drafters: ', bold: true }),
      new TextRun({ text: data.synthesis.methodology.reviewers.join(', ') }),
    ],
  }));
  mainContent.push(new Paragraph({
    children: [
      new TextRun({ text: 'Overall Confidence: ', bold: true }),
      new TextRun({ text: `${data.synthesis.overallConfidence}%` }),
    ],
  }));

  // Build sidebar content (right column) - Points of Difference
  const sidebarContent: Paragraph[] = [];

  sidebarContent.push(new Paragraph({
    children: [new TextRun({ text: '⚡ Points of Difference', bold: true, size: 22 })],
  }));
  sidebarContent.push(new Paragraph({ text: '' }));

  if (data.differences.length === 0) {
    sidebarContent.push(new Paragraph({
      children: [new TextRun({ text: 'No significant differences identified. Models reached consensus on all major points.', italics: true, color: '6B7280' })],
    }));
  } else {
    data.differences.forEach(diff => {
      sidebarContent.push(new Paragraph({
        children: [new TextRun({ text: diff.topic, bold: true })],
      }));
      sidebarContent.push(new Paragraph({ text: '' }));

      diff.positions.forEach(pos => {
        const rgb = hexToRgb(pos.color);
        const colorHex = `${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`.toUpperCase();

        sidebarContent.push(new Paragraph({
          children: [
            new TextRun({ text: pos.model, bold: true, size: 18, color: colorHex }),
          ],
          shading: { type: ShadingType.SOLID, color: 'F9FAFB' },
          border: {
            left: { style: BorderStyle.SINGLE, size: 16, color: colorHex },
          },
        }));
        sidebarContent.push(new Paragraph({
          children: [new TextRun({ text: pos.position, size: 18 })],
          border: {
            left: { style: BorderStyle.SINGLE, size: 16, color: colorHex },
          },
        }));
        sidebarContent.push(new Paragraph({ text: '' }));
      });
    });
  }

  // Create two-column table layout
  const layoutTable = new Table({
    rows: [
      new TableRow({
        children: [
          // Main content column (70%)
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            children: mainContent,
            verticalAlign: VerticalAlign.TOP,
            borders: {
              top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
              bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
              left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
              right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
            },
            margins: { right: 200 },
          }),
          // Sidebar column (30%) with amber border
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            children: sidebarContent,
            verticalAlign: VerticalAlign.TOP,
            shading: { type: ShadingType.SOLID, color: 'FFFBEB' }, // Amber-50 background
            borders: {
              top: { style: BorderStyle.SINGLE, size: 12, color: 'F59E0B' },
              bottom: { style: BorderStyle.SINGLE, size: 12, color: 'F59E0B' },
              left: { style: BorderStyle.SINGLE, size: 12, color: 'F59E0B' },
              right: { style: BorderStyle.SINGLE, size: 12, color: 'F59E0B' },
            },
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
          }),
        ],
      }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });

  // Header
  const header: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({ text: 'AI Roundtable - Synthesis Report', bold: true, size: 28 }),
      ],
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${data.date} | Models: ${data.models.join(', ')}`, size: 18, color: '6B7280' }),
      ],
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: '' }),
  ];

  // Footer
  const footer: Paragraph[] = [
    new Paragraph({ text: '' }),
    new Paragraph({
      children: [
        new TextRun({ text: `Generated by AI Roundtable - Synthesis Mode | ${data.date}`, italics: true, size: 16, color: '9CA3AF' }),
      ],
      alignment: AlignmentType.CENTER,
    }),
  ];

  const doc = new Document({
    sections: [{
      properties: {},
      children: [...header, layoutTable, ...footer],
    }],
  });

  return await Packer.toBlob(doc);
}
