// lib/consensus.ts

import OpenAI from 'openai';
import { CONSENSUS_CHECK_PROMPT, getConsensusCheckMessage } from './prompts';

export interface ConsensusResult {
  consensus: boolean;
  similarity_score: number;
  camps?: {
    id: number;
    position: string;
    participants: string[];
  }[];
  synthesis?: string;
  key_agreements: string[];
  key_disagreements: string[];
}

export async function checkConsensus(
  client: OpenAI,
  question: string,
  responses: { model: string; response: string }[]
): Promise<ConsensusResult> {
  // Use a fast, cheap model for consensus checking
  const judgeModel = 'google/gemini-2.0-flash-001';

  try {
    const completion = await client.chat.completions.create({
      model: judgeModel,
      messages: [
        { role: 'system', content: CONSENSUS_CHECK_PROMPT },
        { role: 'user', content: getConsensusCheckMessage(question, responses) },
      ],
      max_tokens: 1500,
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content || '';
    
    // Try to parse JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]) as ConsensusResult;
      return result;
    }

    // Fallback if parsing fails
    return {
      consensus: false,
      similarity_score: 0.5,
      key_agreements: [],
      key_disagreements: ['Unable to parse consensus check'],
    };
  } catch (error) {
    console.error('Consensus check error:', error);
    return {
      consensus: false,
      similarity_score: 0.5,
      key_agreements: [],
      key_disagreements: ['Error during consensus check'],
    };
  }
}

// Simple heuristic check (fast, no API call)
export function quickConsensusCheck(
  responses: { model: string; response: string }[]
): { likelyConsensus: boolean; confidence: number } {
  if (responses.length < 2) {
    return { likelyConsensus: true, confidence: 1.0 };
  }

  // Very basic: check if responses are roughly similar length
  // and contain similar key phrases
  const lengths = responses.map(r => r.response.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const lengthVariance = lengths.reduce((sum, l) => sum + Math.abs(l - avgLength), 0) / lengths.length;
  const lengthSimilarity = 1 - Math.min(lengthVariance / avgLength, 1);

  return {
    likelyConsensus: lengthSimilarity > 0.7,
    confidence: lengthSimilarity,
  };
}
