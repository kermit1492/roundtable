import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MAX_ITERATIONS = 5;
const PARTIAL_CONSENSUS_THRESHOLD = 0.67; // 2/3 models agree
const MAX_VOTE_RETRIES = 5; // Each model MUST vote

interface FileAttachment {
  type: 'image' | 'pdf';
  data: string;
  mimeType: string;
  name: string;
}

interface PreviousDiscussion {
  question: string;
  consensus?: string;
  responses: Record<string, string>;
}

interface DiscussionRequest {
  question: string;
  models: string[];
  previousDiscussion?: PreviousDiscussion;
  file?: FileAttachment;
}

interface VoteResult {
  modelId: string;
  modelName: string;
  consensusReached: boolean;
  similarityScore: number;
  reasoning: string;
  synthesis: string;
  keyAgreements: string[];
  keyDisagreements: string[];
  failed?: boolean;
}

const MODEL_NAMES: Record<string, string> = {
  'openai/gpt-5.2-pro': 'GPT-5.2 Pro',
  'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
  'google/gemini-3-pro-preview': 'Gemini 3 Pro',
  'openai/gpt-5.2': 'GPT-5.2',
  'google/gemini-3-flash-preview': 'Gemini 3 Flash',
  'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
};

// Max tokens for model responses
const MAX_RESPONSE_TOKENS = 8192;

function getActualModelId(modelId: string): string {
  // Remove :thinking suffix for Gemini thinking models
  return modelId.replace(':thinking', '');
}

function getModelName(id: string): string {
  return MODEL_NAMES[id] || id;
}

// Robust JSON string sanitization to fix LLM output issues
function sanitizeJsonString(str: string): string {
  // Step 1: Remove control characters (keep newlines temporarily for structure)
  let result = str.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  
  // Step 2: Replace actual newlines/tabs with spaces (they break JSON strings)
  result = result.replace(/[\n\r\t]/g, ' ');
  
  // Step 3: Collapse multiple spaces
  result = result.replace(/  +/g, ' ');
  
  // Step 4: Fix invalid escape sequences
  // JSON only allows: \" \\ \/ \b \f \n \r \t \uXXXX
  // GPT often uses LaTeX: \( \) and regex escapes: \s \d \w etc.
  
  // Fix LaTeX inline math delimiters: \( and \)
  // /\\\(/ means: backslash (\\) + literal paren (\()
  result = result.replace(/\\\(/g, '(');
  result = result.replace(/\\\)/g, ')');
  
  // Fix LaTeX display math: \[ and \]
  result = result.replace(/\\\[/g, '[');
  result = result.replace(/\\\]/g, ']');
  
  // Fix common regex-style escapes: \s \d \w etc.
  // Use \x5C (hex for backslash) because \s in regex means whitespace!
  result = result.replace(/\x5Cs/g, 's');
  result = result.replace(/\x5Cd/g, 'd');
  result = result.replace(/\x5Cw/g, 'w');
  result = result.replace(/\x5Cp/g, 'p');
  result = result.replace(/\x5CS/g, 'S');
  result = result.replace(/\x5CD/g, 'D');
  result = result.replace(/\x5CW/g, 'W');
  result = result.replace(/\x5Cc/g, 'c');
  result = result.replace(/\x5Cx/g, 'x');
  result = result.replace(/\x5Ca/g, 'a');
  result = result.replace(/\x5Ce/g, 'e');
  result = result.replace(/\x5Ci/g, 'i');
  result = result.replace(/\x5Co/g, 'o');
  result = result.replace(/\x5Ck/g, 'k');
  result = result.replace(/\x5Cl/g, 'l');
  result = result.replace(/\x5Cm/g, 'm');
  result = result.replace(/\x5Cg/g, 'g');
  result = result.replace(/\x5Ch/g, 'h');
  result = result.replace(/\x5Cj/g, 'j');
  result = result.replace(/\x5Cq/g, 'q');
  result = result.replace(/\x5Cv/g, 'v');
  result = result.replace(/\x5Cy/g, 'y');
  result = result.replace(/\x5Cz/g, 'z');
  
  // Fix LaTeX Greek letters and other commands: \kappa, \propto, \hbar, etc.
  // Match backslash + word characters
  result = result.replace(/\x5C([a-zA-Z]+)(?![a-zA-Z])/g, '$1');
  
  // Fix remaining: backslash + any single char that's not valid JSON escape
  result = result.replace(/\x5C([^"\x5C\x2Fbfnrtu])/g, '$1');
  
  // Step 5: Fix malformed \u escapes (\u not followed by 4 hex digits)
  result = result.replace(/\x5Cu(?![0-9a-fA-F]{4})/g, 'u');
  
  return result;
}

function createSSEStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });

  const send = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(message));
  };

  const close = () => { controller.close(); };

  return { stream, send, close };
}

async function callModel(
  modelId: string,
  messages: { role: string; content: string | object }[],
  maxTokens: number = MAX_RESPONSE_TOKENS,
  temperature: number = 0.7,
  retries: number = 3
): Promise<string> {
  const actualModelId = getActualModelId(modelId);
  const modelName = getModelName(modelId);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 sec timeout
      
      if (attempt > 1) {
        console.log(`[${modelName}] Retry attempt ${attempt}/${retries}...`);
      }
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://roundtable.app',
        },
        body: JSON.stringify({
          model: actualModelId,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      
      // Log full response for debugging
      console.log(`[${modelName}] API response:`, JSON.stringify(data).slice(0, 500));
      
      // For Gemini: prefer content, but fallback to reasoning if content is empty
      // (Gemini 3 Pro with thinking mode puts response in reasoning)
      let content = '';
      if (actualModelId.includes('gemini')) {
        content = message?.content || '';
        // Fallback to reasoning if content is empty (thinking mode)
        if (!content && message?.reasoning) {
          console.log(`[${modelName}] Content empty, trying to extract from reasoning...`);
          // Try to find JSON in reasoning (for vote responses)
          const reasoningJson = message.reasoning.match(/\{[\s\S]*\}/);
          if (reasoningJson) {
            content = reasoningJson[0];
            console.log(`[${modelName}] Found JSON in reasoning`);
          } else {
            // For regular responses, use the last part of reasoning
            content = message.reasoning;
          }
        }
      } else {
        content = message?.content || message?.text || '';
      }
      
      // Check for empty response
      if (!content || content.trim().length === 0) {
        console.error(`[${modelName}] Empty response from API`);
        throw new Error('Empty response from model');
      }
      
      return content;
    } catch (error) {
      const isConnectError = error instanceof Error && 
        (error.message.includes('ConnectTimeout') || error.message.includes('fetch failed'));
      
      console.log(`[${modelName}] callModel attempt ${attempt}/${retries} failed:`, 
        isConnectError ? 'Connection timeout' : error);
      
      if (attempt === retries) {
        console.error(`[${modelName}] All ${retries} attempts failed`);
        throw error;
      }
      // Wait before retry (exponential backoff: 2s, 4s, 8s)
      const waitTime = 2000 * Math.pow(2, attempt - 1);
      console.log(`[${modelName}] Waiting ${waitTime/1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  return '';
}

async function streamModel(
  modelId: string,
  messages: { role: string; content: string | object }[],
  onToken: (token: string) => void,
  maxTokens: number = MAX_RESPONSE_TOKENS
): Promise<string> {
  const actualModelId = getActualModelId(modelId);
  const STREAM_TIMEOUT_MS = 180000; // 3 minutes max per model
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`[${actualModelId}] Stream timeout reached`);
    controller.abort();
  }, STREAM_TIMEOUT_MS);
  
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://roundtable.app',
      },
      body: JSON.stringify({
        model: actualModelId,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${actualModelId}] API error:`, response.status, errorText);
      throw new Error(`API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader');

    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let streamFinished = false;

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log(`[${actualModelId}] Stream done, response length: ${fullResponse.length}`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Check for stream end
        if (line === 'data: [DONE]') {
          console.log(`[${actualModelId}] Received [DONE] signal`);
          streamFinished = true;
          break;
        }
        
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.slice(6));
            const choice = json.choices?.[0];
            const delta = choice?.delta;
            
            // Debug: log the structure for Gemini
            if (actualModelId.includes('gemini') && delta && Object.keys(delta).length > 0) {
              const keys = Object.keys(delta);
              if (!keys.includes('content') && !keys.includes('reasoning') && !keys.includes('text')) {
                console.log(`[${actualModelId}] Unknown delta keys:`, keys, delta);
              }
            }
            
            // Check for finish reason
            if (choice?.finish_reason) {
              console.log(`[${actualModelId}] Finish reason: ${choice.finish_reason}`);
              streamFinished = true;
            }
            
            // For Gemini: prefer content over reasoning (reasoning is chain-of-thought)
            // For others: content is the main field
            let content = '';
            if (actualModelId.includes('gemini')) {
              // Gemini: use content if available, fallback to reasoning only if no content
              content = delta?.content || '';
              // Don't use reasoning as it contains thinking process
            } else {
              content = delta?.content || delta?.text || '';
            }
            
            if (content) {
              fullResponse += content;
              onToken(content);
            }
          } catch (e) {
            // Ignore parse errors for partial JSON
          }
        }
      }
      
      if (streamFinished) break;
    }

    console.log(`[${actualModelId}] Final response length: ${fullResponse.length} chars`);
    return fullResponse;
  } catch (error) {
    console.error(`[${actualModelId}] Stream error:`, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

const SYSTEM_PROMPT = `You are an expert participating in a roundtable discussion with other AI models. 
Your goal is to provide thoughtful, well-reasoned responses and engage constructively with other perspectives.
Be concise but thorough. Respond in the same language as the question.`;

const VOTE_PROMPT = `You have just participated in a discussion. Here are ALL the responses:

{responses}

Now evaluate: Has consensus been reached among the participants?

You must respond with ONLY valid JSON in this exact format:
{
  "consensus_reached": true/false,
  "similarity_score": 0.0-1.0,
  "reasoning": "brief explanation of your assessment",
  "synthesis": "if consensus reached, write a unified conclusion that captures the shared view (3-5 sentences)",
  "key_agreements": ["point 1", "point 2", ...],
  "key_disagreements": ["point 1", ...]
}

Be honest in your assessment. Consensus means substantial agreement on the main points, not perfect agreement on every detail.
Respond in the same language as the original question.`;

const ANALYZE_POINTS_PROMPT = `You are analyzing the key points from a multi-model AI discussion.

Each model has provided their view on what the models agreed and disagreed on.
Your job is to:
1. Group semantically similar points together
2. Count how many models mentioned each grouped point
3. Only include agreements that 2+ models mentioned (to filter noise)
4. For disagreements, identify WHO disagrees with WHOM and on WHAT

Here are the raw points from each model:

{points_data}

Respond with ONLY valid JSON:
{
  "agreements": [
    { "point": "consolidated point description", "count": 3, "models": ["GPT-5.2 Pro", "Claude Opus 4.5", "Gemini 3 Pro"] }
  ],
  "disagreements": [
    { "point": "what they disagree on", "sides": [{"position": "position A", "models": ["GPT-5.2 Pro"]}, {"position": "position B", "models": ["Gemini 3 Pro"]}] }
  ]
}

Rules:
- Merge similar/duplicate points into one
- For agreements: only include if 2+ models mentioned something similar
- For disagreements: clearly show which models hold which position
- Keep descriptions concise (1 sentence max)
- Respond in the same language as the original points`;

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

interface AnalyzedPoints {
  agreements: GroupedAgreement[];
  disagreements: GroupedDisagreement[];
}

async function analyzePointsWithSonnet(
  votes: VoteResult[],
  send: (event: string, data: unknown) => void
): Promise<AnalyzedPoints | null> {
  // Prepare data for analysis
  const pointsData = votes.map(v => ({
    model: v.modelName,
    agreements: v.keyAgreements,
    disagreements: v.keyDisagreements,
  }));
  
  // Skip if no points to analyze
  const totalPoints = votes.reduce((sum, v) => sum + v.keyAgreements.length + v.keyDisagreements.length, 0);
  if (totalPoints === 0) {
    return null;
  }
  
  console.log('[Sonnet] Analyzing points...');
  send('analyzing_points', { status: 'started' });
  
  try {
    const messages = [
      { role: 'system', content: 'You analyze discussion points and return structured JSON. Be concise.' },
      { role: 'user', content: ANALYZE_POINTS_PROMPT.replace('{points_data}', JSON.stringify(pointsData, null, 2)) },
    ];
    
    const response = await callModel('anthropic/claude-sonnet-4.5', messages, 1500, 0.2, 2);
    
    // Parse JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = sanitizeJsonString(jsonMatch[0]);
      
      const parsed = JSON.parse(jsonStr) as AnalyzedPoints;
      console.log('[Sonnet] Points analyzed successfully:', parsed.agreements.length, 'agreements,', parsed.disagreements.length, 'disagreements');
      send('analyzing_points', { status: 'complete' });
      return parsed;
    }
  } catch (error) {
    console.error('[Sonnet] Failed to analyze points:', error);
    send('analyzing_points', { status: 'failed' });
  }
  
  return null;
}

export async function POST(request: NextRequest) {
  const body: DiscussionRequest = await request.json();
  const { question, models: requestedModels, previousDiscussion, file } = body;

  if (!question || !requestedModels || requestedModels.length < 2) {
    return new Response(JSON.stringify({ error: 'Need question and at least 2 models' }), { status: 400 });
  }

  const { stream, send, close } = createSSEStream();

  (async () => {
    try {
      const activeModels = [...requestedModels];
      const allResponses: Record<number, Record<string, string>> = {};
      let iteration = 0;

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        const isFirstIteration = iteration === 1;

        // === PHASE 1: Models respond ===
        send('iteration_start', { iteration, totalModels: activeModels.length });
        send('models_thinking', {
          iteration,
          models: activeModels.map(m => ({ id: m, name: getModelName(m) }))
        });

        allResponses[iteration] = {};
        const completedModels = new Set<string>();

        // All models respond in parallel
        const modelPromises = activeModels.map(async (modelId) => {
          const modelName = getModelName(modelId);
          
          let userPrompt: string;
          if (isFirstIteration) {
            userPrompt = file 
              ? `[Attached file: ${file.name}]\n\n${question}`
              : question;
            
            if (previousDiscussion) {
              const prevResponses = Object.entries(previousDiscussion.responses)
                .map(([id, resp]) => `${getModelName(id)}: ${resp}`)
                .join('\n\n');
              userPrompt = `Previous discussion about "${previousDiscussion.question}":\n${prevResponses}\n\n${previousDiscussion.consensus ? `Previous consensus: ${previousDiscussion.consensus}\n\n` : ''}New follow-up question: ${question}`;
            }
          } else {
            // Show OTHER models' responses from previous iteration
            const otherResponses = Object.entries(allResponses[iteration - 1])
              .filter(([id]) => id !== modelId)
              .map(([id, resp]) => `${getModelName(id)}:\n${resp}`)
              .join('\n\n---\n\n');
            
            userPrompt = `Original question: ${question}\n\nYour colleagues have shared their views:\n\n${otherResponses}\n\nConsider their perspectives. Do you agree? Disagree? Refine your position if needed.`;
          }

          const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ];

          try {
            const response = await streamModel(
              modelId,
              messages,
              (token) => {
                send('model_token', { model: modelId, modelName, token, iteration });
              }
            );

            completedModels.add(modelId);
            send('model_complete', {
              model: modelId,
              modelName,
              response,
              iteration,
              completedCount: completedModels.size,
              totalCount: activeModels.length,
            });

            return { modelId, modelName, response, error: false };
          } catch (error) {
            console.error(`[${modelName}] Error:`, error);
            completedModels.add(modelId);
            send('model_error', {
              model: modelId,
              modelName,
              error: String(error),
              iteration,
              completedCount: completedModels.size,
              totalCount: activeModels.length,
            });
            return { modelId, modelName, response: '', error: true };
          }
        });

        const results = await Promise.all(modelPromises);
        
        for (const r of results) {
          if (!r.error && r.response) {
            allResponses[iteration][r.modelId] = r.response;
          }
        }

        send('all_models_complete', { iteration });

        // === PHASE 2: Each model votes on consensus (MANDATORY - with retries) ===
        send('voting_start', { iteration });

        const allResponsesText = Object.entries(allResponses[iteration])
          .map(([id, resp]) => `${getModelName(id)}:\n${resp}`)
          .join('\n\n---\n\n');

        // Helper function to get a single vote with retries
        async function getVoteWithRetry(modelId: string): Promise<VoteResult> {
          const modelName = getModelName(modelId);
          
          const voteMessages = [
            { role: 'system', content: 'You are evaluating a discussion for consensus. Return ONLY valid JSON.' },
            { role: 'user', content: VOTE_PROMPT.replace('{responses}', `Question: ${question}\n\n${allResponsesText}`) },
          ];

          for (let attempt = 1; attempt <= MAX_VOTE_RETRIES; attempt++) {
            try {
              if (attempt === 1) {
                send('model_voting', { model: modelId, modelName });
                console.log(`[${modelName}] Starting vote...`);
              } else {
                console.log(`[${modelName}] Vote retry ${attempt}/${MAX_VOTE_RETRIES}`);
                send('model_vote_retrying', { model: modelId, modelName, attempt, maxAttempts: MAX_VOTE_RETRIES });
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
              }
              
              const voteResponse = await callModel(modelId, voteMessages, 2000, 0.3, 2); // Increased to 2000 tokens for voting
              
              console.log(`[${modelName}] Vote response length: ${voteResponse.length}`);
              console.log(`[${modelName}] Vote response preview: ${voteResponse.slice(0, 200)}...`);
              
              // Parse JSON from response
              const jsonMatch = voteResponse.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                console.log(`[${modelName}] JSON found, parsing...`);
                try {
                  // Use robust sanitization
                  const jsonStr = sanitizeJsonString(jsonMatch[0]);
                  console.log(`[${modelName}] Sanitized JSON (first 300):`, jsonStr.slice(0, 300));
                  
                  const parsed = JSON.parse(jsonStr);
                  
                  const result: VoteResult = {
                    modelId,
                    modelName,
                    consensusReached: Boolean(parsed.consensus_reached),
                    similarityScore: Number(parsed.similarity_score) || 0,
                    reasoning: parsed.reasoning || '',
                    synthesis: parsed.synthesis || '',
                    keyAgreements: parsed.key_agreements || [],
                    keyDisagreements: parsed.key_disagreements || [],
                  };

                  console.log(`[${modelName}] Vote parsed successfully: consensus=${result.consensusReached}, score=${result.similarityScore}`);
                  send('model_voted', { model: modelId, modelName, vote: result });
                  return result;
                } catch (parseError) {
                  console.error(`[${modelName}] JSON parse error:`, parseError);
                  // Log the problematic area
                  const errorMsg = String(parseError);
                  const posMatch = errorMsg.match(/position (\d+)/);
                  if (posMatch) {
                    const pos = parseInt(posMatch[1]);
                    const start = Math.max(0, pos - 50);
                    const end = Math.min(jsonStr.length, pos + 50);
                    console.error(`[${modelName}] Error at position ${pos} in SANITIZED JSON, context: ...${jsonStr.slice(start, end)}...`);
                    // Show character codes around the error in sanitized string
                    const charCodes = jsonStr.slice(Math.max(0, pos - 5), pos + 5)
                      .split('').map(c => `${c}(${c.charCodeAt(0)})`).join(' ');
                    console.error(`[${modelName}] Char codes in sanitized around error: ${charCodes}`);
                  }
                  // Also show raw JSON context
                  if (posMatch) {
                    const pos = parseInt(posMatch[1]);
                    console.error(`[${modelName}] Raw JSON around pos ${pos}: ...${jsonMatch[0].slice(Math.max(0,pos-50), pos+50)}...`);
                  }
                  throw new Error(`JSON parse failed: ${parseError}`);
                }
              } else {
                console.error(`[${modelName}] No JSON found in response`);
                console.error(`[${modelName}] Full response:`, voteResponse);
                throw new Error('No JSON found in response');
              }
            } catch (error) {
              console.error(`[${modelName}] Vote attempt ${attempt}/${MAX_VOTE_RETRIES} failed:`, error);
              
              if (attempt === MAX_VOTE_RETRIES) {
                // All retries exhausted - this is a critical error
                console.error(`[${modelName}] CRITICAL: All ${MAX_VOTE_RETRIES} vote attempts failed`);
                send('model_vote_failed', { model: modelId, modelName, attempts: MAX_VOTE_RETRIES });
                return {
                  modelId,
                  modelName,
                  consensusReached: false,
                  similarityScore: 0,
                  reasoning: `Vote failed after ${MAX_VOTE_RETRIES} attempts`,
                  synthesis: '',
                  keyAgreements: [],
                  keyDisagreements: [],
                  failed: true,
                };
              }
            }
          }
          
          // Should never reach here
          return {
            modelId,
            modelName,
            consensusReached: false,
            similarityScore: 0,
            reasoning: 'Vote failed',
            synthesis: '',
            keyAgreements: [],
            keyDisagreements: [],
            failed: true,
          };
        }

        // Get all votes in parallel (each with its own retry logic)
        const votes = await Promise.all(activeModels.map(getVoteWithRetry));
        
        // Check if any vote failed
        const failedVotes = votes.filter(v => v.failed);
        if (failedVotes.length > 0) {
          // Critical error - cannot continue without all votes
          const failedModels = failedVotes.map(v => v.modelName).join(', ');
          console.error(`[Voting] CRITICAL: ${failedVotes.length} model(s) failed to vote: ${failedModels}`);
          send('voting_error', { 
            failedModels: failedVotes.map(v => ({ id: v.modelId, name: v.modelName })),
            message: `Voting failed: ${failedModels} could not vote after ${MAX_VOTE_RETRIES} attempts each`
          });
          send('error', { message: `Cannot continue: ${failedModels} failed to vote` });
          break; // Exit the discussion loop
        }
        
        // === PHASE 3: Tally votes (all votes are now guaranteed successful) ===
        const yesVotes = votes.filter(v => v.consensusReached).length;
        const totalVotes = votes.length;
        const consensusRatio = yesVotes / totalVotes;
        const avgScore = votes.reduce((sum, v) => sum + v.similarityScore, 0) / totalVotes;

        const isFullConsensus = consensusRatio === 1;
        const isPartialConsensus = consensusRatio >= PARTIAL_CONSENSUS_THRESHOLD;
        const consensusReached = isPartialConsensus;

        // Collect all syntheses
        const syntheses = votes
          .filter(v => v.synthesis && v.synthesis.length > 10)
          .map(v => ({ modelName: v.modelName, synthesis: v.synthesis }));

        // Analyze and group key points with Sonnet
        send('analyzing_points', { status: 'starting' });
        const analyzedPoints = await analyzePointsWithSonnet(votes, send);
        
        // Fallback to simple merge if Sonnet fails
        let finalAgreements: GroupedAgreement[];
        let finalDisagreements: GroupedDisagreement[];
        
        if (analyzedPoints) {
          finalAgreements = analyzedPoints.agreements;
          finalDisagreements = analyzedPoints.disagreements;
        } else {
          // Fallback: simple unique merge (old behavior)
          const rawAgreements = [...new Set(votes.flatMap(v => v.keyAgreements))];
          const rawDisagreements = [...new Set(votes.flatMap(v => v.keyDisagreements))];
          
          finalAgreements = rawAgreements.slice(0, 7).map(point => ({
            point,
            count: 1,
            models: ['Unknown'],
          }));
          finalDisagreements = rawDisagreements.slice(0, 5).map(point => ({
            point,
            sides: [],
          }));
        }

        // Find best answer (highest average mention or score)
        const bestAnswerVotes: Record<string, number> = {};
        votes.forEach(v => {
          // Each model's synthesis might mention who had the best point
          activeModels.forEach(m => {
            const name = getModelName(m);
            if (v.synthesis.includes(name) || v.reasoning.includes(name)) {
              bestAnswerVotes[name] = (bestAnswerVotes[name] || 0) + 1;
            }
          });
        });
        
        // Default to highest similarity score voter as "closest to truth"
        const sortedByScore = [...votes].sort((a, b) => b.similarityScore - a.similarityScore);
        const closestToTruth = sortedByScore[0]?.modelName;

        const consensusResult = {
          consensus_reached: consensusReached,
          consensus_type: isFullConsensus ? 'full' : isPartialConsensus ? 'partial' : 'none',
          similarity_score: avgScore,
          votes: {
            yes: yesVotes,
            total: totalVotes,
            ratio: consensusRatio,
          },
          individual_votes: votes.map(v => ({
            model: v.modelName,
            vote: v.consensusReached ? 'yes' : 'no',
            score: v.similarityScore,
            reasoning: v.reasoning,
          })),
          syntheses,
          key_agreements: finalAgreements,
          key_disagreements: finalDisagreements,
          closest_to_truth: closestToTruth,
          closest_to_truth_reason: `Highest confidence in assessment (${Math.round(sortedByScore[0]?.similarityScore * 100)}%)`,
        };

        send('consensus_result', { iteration, result: consensusResult });

        // === PHASE 4: Decide whether to continue ===
        if (consensusReached) {
          send('discussion_complete', {
            iterations: iteration,
            result: consensusResult,
            finalResponses: allResponses[iteration],
            reason: isFullConsensus ? 'full_consensus' : 'partial_consensus',
          });
          break;
        }

        if (iteration >= MAX_ITERATIONS) {
          send('discussion_complete', {
            iterations: iteration,
            result: consensusResult,
            finalResponses: allResponses[iteration],
            reason: 'max_iterations',
          });
          break;
        }

        // Continue to next round
        send('preparing_next_round', { nextIteration: iteration + 1 });
      }
    } catch (error) {
      console.error('Discussion error:', error);
      send('error', { message: String(error) });
    } finally {
      send('done', {});
      close();
    }
  })();

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
