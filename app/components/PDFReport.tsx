'use client';

import { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType, BorderStyle } from 'docx';

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
