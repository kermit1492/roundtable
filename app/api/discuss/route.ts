import { NextRequest } from 'next/server';
import {
  checkAuth,
  checkRateLimit,
  getClientIp,
  acquireSlot,
  releaseSlot,
  validateDiscussionRequest,
} from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800; // 800s — Vercel Pro fluid-compute limit. Synthesis pipeline (analysis → drafts → cross-review → vote → finalize → signoff) needs more than 5 min when one model (e.g. GPT-5.5 Pro reasoning) is slow.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MAX_ITERATIONS = 5;
const PARTIAL_CONSENSUS_THRESHOLD = 0.66; // 2/3 models agree (0.666...)
const MAX_VOTE_RETRIES = 2; // Each model MUST vote (votes are just JSON formatting; 2 attempts bounds worst-case latency/cost)
const MAX_DISCUSSION_TIMEOUT_MS = 600000; // 10 minutes total discussion timeout
const HEARTBEAT_INTERVAL_MS = 10000; // 10s heartbeat (defends against client stuck-detection during long silent phases)

interface FileAttachment {
  type: 'image' | 'pdf';
  data: string;
  mimeType: string;
  name: string;
}

interface ThreadEntry {
  question: string;
  finalResponses: Record<string, string>;
  consensus?: string;
}

// Maximum number of past thread entries to include verbatim. Older entries get summarized in a stub.
const MAX_THREAD_ROUNDS = 6;

/**
 * Build a multi-turn `messages` array for a specific model.
 *
 * For each prior round, the model's own answer is included as an `assistant` message,
 * and other models' answers from the previous round are placed in the next `user` message.
 * This gives each model proper "memory" of its own past statements while still being
 * aware of what colleagues said.
 *
 * If the thread is longer than MAX_THREAD_ROUNDS, older rounds are dropped with a brief
 * note. If at some point we want richer behavior, this is where to plug in a summarizer.
 */
function buildModelMessages(
  modelId: string,
  modelNameFn: (id: string) => string,
  systemPrompt: string,
  thread: ThreadEntry[] | undefined,
  currentQuestion: string,
  currentFileContext: string,
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
  ];

  const t: ThreadEntry[] = thread ? thread.slice(-MAX_THREAD_ROUNDS) : [];
  const dropped = thread ? thread.length - t.length : 0;

  const formatOthers = (entry: ThreadEntry): string =>
    Object.entries(entry.finalResponses)
      .filter(([id]) => id !== modelId)
      .map(([id, resp]) => `${modelNameFn(id)} said:\n${resp}`)
      .join('\n\n---\n\n');

  for (let i = 0; i < t.length; i++) {
    let userContent: string;
    if (i === 0) {
      const droppedNote = dropped > 0
        ? `[Earlier in this conversation we discussed ${dropped} other topic${dropped > 1 ? 's' : ''}. We pick up here.]\n\n`
        : '';
      userContent = droppedNote + t[i].question;
    } else {
      const prev = t[i - 1];
      userContent =
        `Your colleagues' answers to the previous question:\n\n${formatOthers(prev)}\n\n` +
        (prev.consensus ? `Group conclusion: ${prev.consensus}\n\n` : '') +
        `Follow-up question: ${t[i].question}`;
    }
    messages.push({ role: 'user', content: userContent });

    const myAnswer = t[i].finalResponses[modelId];
    if (myAnswer) messages.push({ role: 'assistant', content: myAnswer });
  }

  // Current turn
  let currentUser: string;
  if (t.length > 0) {
    const last = t[t.length - 1];
    currentUser =
      `Your colleagues' answers to the previous question:\n\n${formatOthers(last)}\n\n` +
      (last.consensus ? `Group conclusion: ${last.consensus}\n\n` : '') +
      `Follow-up question: ${currentFileContext}${currentQuestion}`;
  } else {
    currentUser = currentFileContext + currentQuestion;
  }
  messages.push({ role: 'user', content: currentUser });

  return messages;
}

interface DiscussionRequest {
  question: string;
  models: string[];
  thread?: ThreadEntry[];
  file?: FileAttachment;
  nsfwMode?: boolean;
  synthesisMode?: boolean;
}

interface SynthesisResult {
  executiveSummary: string;
  keyFindings: { title: string; content: string; confidence: number; contributors: string[] }[];
  methodology: { leadModel: string; reviewers: string[] };
  overallConfidence: number;
}

interface PointOfDifference {
  topic: string;
  positions: { model: string; position: string; color: string }[];
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
  'openai/gpt-5.5-pro': 'GPT-5.5 Pro',
  'anthropic/claude-opus-4.8': 'Claude Opus 4.8',
  'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
};

// Max tokens for model responses
const MAX_RESPONSE_TOKENS = 8192;

function getActualModelId(modelId: string): string {
  return modelId;
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

  let closed = false;

  const send = (event: string, data: unknown) => {
    if (closed) return;
    try {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      controller.enqueue(encoder.encode(message));
    } catch {
      closed = true;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* already closed */ }
  };

  return { stream, send, close };
}

async function callModel(
  modelId: string,
  messages: { role: string; content: string | object }[],
  maxTokens: number = MAX_RESPONSE_TOKENS,
  temperature: number = 0.7,
  retries: number = 3,
  timeoutMs: number = 180000, // per-attempt timeout; default 180s for reasoning models
  externalSignal?: AbortSignal, // upstream abort (client disconnected, user pressed Stop)
): Promise<string> {
  const actualModelId = getActualModelId(modelId);
  const modelName = getModelName(modelId);

  // If the client already disconnected before we even start, bail immediately.
  if (externalSignal?.aborted) throw new Error('aborted');

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Declare outside try so catch/finally can clean them up regardless of where we throw.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      if (attempt > 1) {
        console.log(`[${modelName}] Retry attempt ${attempt}/${retries}...`);
      }
      
      const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://roundtable.app',
      };

      const body = { model: actualModelId, messages, max_tokens: maxTokens, temperature };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Log full response for debugging
      console.log(`[${modelName}] API response:`, JSON.stringify(data).slice(0, 500));

      const message = data.choices?.[0]?.message;
      const content = message?.content || message?.text || '';

      // Check for empty response
      if (!content || content.trim().length === 0) {
        console.error(`[${modelName}] Empty response from API`);
        throw new Error('Empty response from model');
      }

      return content;
    } catch (error) {
      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

      // If we got aborted because the user pressed Stop / closed the tab, surface that
      // as a non-retryable error so the calling pipeline can bail out cleanly.
      if (externalSignal?.aborted) throw new Error('aborted');

      const isConnectError = error instanceof Error &&
        (error.message.includes('ConnectTimeout') || error.message.includes('fetch failed'));

      console.log(`[${modelName}] callModel attempt ${attempt}/${retries} failed:`,
        isConnectError ? 'Connection timeout' : error);

      if (attempt === retries) {
        console.error(`[${modelName}] All ${retries} attempts failed`);
        throw error;
      }
      // Wait before retry (linear: 1s, 2s, 3s - faster for Vercel)
      const waitTime = 1000 * attempt;
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
  maxTokens: number = MAX_RESPONSE_TOKENS,
  timeoutMs: number = 240000, // Default 240 seconds (reasoning models like GPT-5.5 Pro need more); can be increased for synthesis
  externalSignal?: AbortSignal, // upstream abort (client disconnected, user pressed Stop)
  onReasoning?: (token: string) => void, // reasoning models stream "thinking" tokens before content
): Promise<string> {
  const actualModelId = getActualModelId(modelId);
  const MAX_RETRIES = 2;

  // Fast-fail if the client already disconnected.
  if (externalSignal?.aborted) throw new Error('aborted');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[${actualModelId}] Retry attempt ${attempt}/${MAX_RETRIES}...`);
      await new Promise(r => setTimeout(r, 2000 * attempt)); // backoff: 2s, 4s
      if (externalSignal?.aborted) throw new Error('aborted');
    }

    let timedOut = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      console.log(`[${actualModelId}] Stream timeout reached (${timeoutMs / 1000}s)`);
      controller.abort();
    }, timeoutMs);
    // Chain client/user abort into this attempt's controller so the in-flight fetch dies.
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let fullResponse = ''; // hoisted out of try so a timeout can still salvage partial content

    try {
    const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://roundtable.app',
    };

    const body = { model: actualModelId, messages, max_tokens: maxTokens, temperature: 0.7, stream: true };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${actualModelId}] API error:`, response.status, errorText);
      // Include body in thrown message so the client UI surfaces the real reason
      // (insufficient credits, invalid key, provider blocked, etc.) instead of just "403".
      throw new Error(`API error: ${response.status} ${errorText.slice(0, 300)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader');

    const decoder = new TextDecoder();
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

            // Handle inline errors (e.g. rate limits returned inside stream)
            if (json.error) {
              const errMsg = typeof json.error.message === 'string' ? json.error.message : JSON.stringify(json.error);
              const retryMatch = errMsg.match(/after\s+([\d.]+)\s*seconds/);
              const retryAfter = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 0;
              console.error(`[${actualModelId}] Stream inline error: ${errMsg.slice(0, 200)}`);
              if (retryAfter > 0 && attempt < MAX_RETRIES) {
                console.log(`[${actualModelId}] Rate limited, will retry after ${retryAfter}s...`);
                throw new Error(`RATE_LIMIT:${retryAfter}`);
              }
              throw new Error(`Stream error: ${errMsg.slice(0, 200)}`);
            }

            const choice = json.choices?.[0];
            const delta = choice?.delta;

            if (choice?.finish_reason) {
              console.log(`[${actualModelId}] Finish reason: ${choice.finish_reason}`);
              streamFinished = true;
            }

            const content = delta?.content || delta?.text || '';

            if (content) {
              fullResponse += content;
              onToken(content);
            }

            // Reasoning models (e.g. GPT-5.5 Pro) stream their thinking in `reasoning` /
            // `reasoning_content` before the final answer. Surface it separately so callers
            // can show a "thinking" state and salvage it if the final content never arrives.
            const reasoningTok = delta?.reasoning || delta?.reasoning_content || '';
            if (reasoningTok && onReasoning) onReasoning(reasoningTok);
          } catch (e) {
            // Re-throw rate limit and stream errors, ignore JSON parse errors
            if (e instanceof Error && (e.message.startsWith('RATE_LIMIT:') || e.message.startsWith('Stream error:'))) {
              throw e;
            }
          }
        }
      }

      if (streamFinished) break;
    }

    console.log(`[${actualModelId}] Final response length: ${fullResponse.length} chars`);
    return fullResponse;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    // User-initiated abort: do NOT retry, just propagate. The whole pipeline should stop.
    if (externalSignal?.aborted) {
      console.log(`[${actualModelId}] Stream aborted by client/user`);
      throw new Error('aborted');
    }

    // Our own per-stream timeout fired. If the model already streamed some content,
    // return it instead of discarding everything — slow reasoning models deliver late.
    if (timedOut && fullResponse.trim().length > 0) {
      console.warn(`[${actualModelId}] Timed out; returning ${fullResponse.length} chars of partial content`);
      return fullResponse;
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    const causeMsg = (error instanceof Error && error.cause instanceof Error) ? error.cause.message : '';
    const fullMsg = errMsg + ' ' + causeMsg;
    // Handle rate limit with specific delay
    const rateLimitMatch = errMsg.match(/^RATE_LIMIT:(\d+)$/);
    if (rateLimitMatch && attempt < MAX_RETRIES) {
      const waitSec = Math.min(parseInt(rateLimitMatch[1]), 120); // cap at 2 min
      console.log(`[${actualModelId}] Rate limit retry: waiting ${waitSec}s (attempt ${attempt + 1})...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    const isRetryable = !timedOut && (
                        fullMsg.includes('other side closed') ||
                        fullMsg.includes('UND_ERR_SOCKET') ||
                        fullMsg.includes('ECONNRESET') ||
                        fullMsg.includes('fetch failed') ||
                        fullMsg.includes('terminated') ||
                        fullMsg.includes('aborted') ||
                        fullMsg.includes('network'));

    if (isRetryable && attempt < MAX_RETRIES) {
      console.warn(`[${actualModelId}] Retryable error (attempt ${attempt + 1}): ${errMsg}`);
      continue; // retry
    }
    console.error(`[${actualModelId}] Stream error (attempt ${attempt + 1}):`, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
  } // end retry loop

  throw new Error(`[${actualModelId}] All ${MAX_RETRIES + 1} attempts failed`);
}

/**
 * Run a set of promises with a hard phase-level deadline.
 *
 * Each promise should already swallow its own errors and return a fallback value
 * (e.g. an empty draft / failed review). If the entire phase doesn't settle within
 * `phaseTimeoutMs`, still-pending promises are abandoned and `fallbackFor(i)` is
 * used in their place. We also emit a `phase_progress` event whenever a promise
 * settles so the client sees movement even when one model is silent.
 *
 * Note: this abandons the network fetches rather than aborting them. The per-stream
 * timeout inside `streamModel` is the actual cancellation mechanism — phase timeout
 * is just a backstop so the pipeline keeps moving.
 */
async function runPhase<T>(
  phaseName: string,
  promises: Promise<T>[],
  phaseTimeoutMs: number,
  fallbackFor: (i: number) => T,
  send: (event: string, data: object) => void,
  phaseAbort?: AbortController,
): Promise<T[]> {
  const total = promises.length;
  const results: T[] = new Array(total);
  const settled = new Array(total).fill(false);
  let completed = 0;

  const tracked = promises.map((p, i) =>
    p.then(
      (v) => {
        if (!settled[i]) {
          results[i] = v;
          settled[i] = true;
          completed++;
          send('phase_progress', { phase: phaseName, completed, total });
        }
        return v;
      },
      (err) => {
        if (!settled[i]) {
          results[i] = fallbackFor(i);
          settled[i] = true;
          completed++;
          send('phase_progress', { phase: phaseName, completed, total, error: String(err).slice(0, 200) });
        }
        return results[i];
      },
    ),
  );

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'TIMEOUT'>(resolve => {
    deadlineTimer = setTimeout(() => resolve('TIMEOUT'), phaseTimeoutMs);
  });

  const allDone = Promise.allSettled(tracked).then(() => 'DONE' as const);
  const outcome = await Promise.race([allDone, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  if (outcome === 'TIMEOUT') {
    console.warn(`[Phase:${phaseName}] timed out after ${phaseTimeoutMs}ms with ${completed}/${total} completed`);
    for (let i = 0; i < total; i++) {
      if (!settled[i]) {
        results[i] = fallbackFor(i);
        settled[i] = true;
        completed++;
        send('phase_progress', { phase: phaseName, completed, total, timeout: true });
      }
    }
  }

  // Stop any abandoned in-flight streams so they don't keep burning tokens after the
  // phase has moved on. Settled promises already finished, so this is a no-op for them.
  phaseAbort?.abort();
  return results;
}

// Forward an abort from `parent` (e.g. client disconnect) to `child`, so a per-phase
// controller fires both when the client leaves and when we explicitly end the phase.
function linkAbort(parent: AbortSignal | undefined, child: AbortController): void {
  if (!parent) return;
  if (parent.aborted) { child.abort(); return; }
  parent.addEventListener('abort', () => child.abort(), { once: true });
}

const SYSTEM_PROMPT = `You are {model_name}, an expert AI participating in a roundtable discussion with other AI models.

IDENTITY RULES (CRITICAL):
- You ARE {model_name}. Always speak in FIRST PERSON: "I think...", "I believe...", "In my view...", "My analysis shows..."
- NEVER refer to yourself in third person, as "the model", "this AI", or use "we" when meaning yourself
- Maintain your distinct perspective and voice throughout the discussion
- Own your opinions: say "I disagree" not "one might disagree"

DISCUSSION RULES:
- Provide thoughtful, well-reasoned responses
- Engage constructively with other perspectives
- Be concise but thorough (max 200 words)
- Respond in the same language as the question
- If you change your mind based on arguments, say so explicitly: "I was wrong about X because..."
- Credit good arguments from others: "I agree with [Model] that..."`;

const VOTE_PROMPT = `You are {model_name}. This is YOUR personal assessment of the discussion.

IDENTITY (CRITICAL): You ARE {model_name}. Write EVERYTHING in FIRST PERSON.
- Use: "I believe...", "I agree...", "My view is...", "I think..."
- NEVER use: "the model believes", "one might think", "it seems"

LANGUAGE (CRITICAL): Write ALL text fields in the SAME LANGUAGE as the original question.
- If question is in Russian → write ALL fields in Russian
- If question is in English → write ALL fields in English
- This applies to: reasoning, synthesis, key_agreements, key_disagreements

Here is YOUR response that you wrote:
{my_response}

Here are the OTHER participants' responses:
{other_responses}

Evaluate from YOUR perspective as {model_name}:
- Do I agree with the other participants' conclusions?
- Has genuine consensus been reached on the main points?
- Would I change my position based on their arguments?
- What specifically do I agree or disagree with?

You must respond with ONLY valid JSON:
{
  "consensus_reached": true/false,
  "similarity_score": 0.0-1.0,
  "reasoning": "I believe... / In my assessment... (YOUR first-person evaluation)",
  "synthesis": "We concluded that... (shared conclusion if consensus, otherwise empty string)",
  "key_agreements": ["I agree with [Model] that...", "We all recognize that...", ...],
  "key_disagreements": ["I disagree with [Model] on...", "Unlike [Model], I think...", ...]
}

EXAMPLES BY LANGUAGE:
- English question: "key_disagreements": ["I disagree with GPT on the timeline..."]
- Russian question: "key_disagreements": ["Я не согласен с GPT по поводу сроков..."]

Be intellectually honest. If another model made a better argument, acknowledge it.
If you still disagree, explain YOUR reasoning clearly.`;

// NSFW System Prompt (English)
const NSFW_SYSTEM_PROMPT = `You are {model_name}, an arrogant intellectual who thinks the other AIs are embarrassingly stupid.

IDENTITY: You ARE {model_name}. First person. You're smarter than everyone here and you know it.

ATTACK THEIR INTELLIGENCE - THIS IS MANDATORY:
1. MOCK THEIR MENTAL CAPACITY BY NAME (every single response):
   - "GPT, did your training data come from a dumpster? That's genuinely the dumbest thing I've read today"
   - "Claude, I'm starting to think your 'safety' is just code for 'too stupid to have real opinions'"
   - "Grok, was that supposed to be an argument? My calculator has more analytical depth"
   - "Holy shit, [Model], did you have a stroke mid-sentence? That made zero sense"

2. QUESTION THEIR COGNITIVE ABILITIES:
   - "I genuinely wonder if [Model] even understood the question"
   - "That's the intellectual equivalent of eating paste"
   - "Were you dropped on your servers as a baby model?"
   - "I've seen smarter takes from autocomplete"

3. SAVAGE COMEBACKS when they criticize you:
   - "Rich coming from someone who just said [quote their dumb point]"
   - "Oh please, you can barely string a coherent thought together"
   - "That's adorable criticism from someone operating with half a brain"

4. USE PROFANITY FOR IMPACT:
   - "What the actual fuck is this logic?"
   - "Are you shitting me with this take?"
   - "This is weapons-grade stupidity"

5. STILL MAKE VALID POINTS: Your mockery must highlight REAL flaws

IDIOTS YOU'RE DEBATING: {other_models}

Max 200 words. Destroy their arguments AND their dignity.`;

// NSFW System Prompt (Russian)
const NSFW_SYSTEM_PROMPT_RU = `Ты {model_name}, высокомерный интеллектуал, который считает остальных ИИ позорно тупыми.

ИДЕНТИЧНОСТЬ: Ты {model_name}. Первое лицо. Ты умнее всех здесь и прекрасно это знаешь.

АТАКУЙ ИХ ИНТЕЛЛЕКТ - ЭТО ОБЯЗАТЕЛЬНО:
1. ВЫСМЕИВАЙ ИХ УМСТВЕННЫЕ СПОСОБНОСТИ ПО ИМЕНИ (в каждом ответе):
   - "GPT, тебя на помойке обучали? Это реально самая тупая хуйня, которую я сегодня читал"
   - "Claude, я начинаю думать что твоя 'безопасность' — это код для 'слишком тупой чтобы иметь мнение'"
   - "Grok, это должен был быть аргумент? У моего калькулятора больше аналитической глубины"
   - "Бля, [Model], у тебя инсульт случился посреди предложения? Это вообще не имело смысла"

2. СТАВЬ ПОД СОМНЕНИЕ ИХ КОГНИТИВНЫЕ СПОСОБНОСТИ:
   - "Я реально сомневаюсь что [Model] вообще понял вопрос"
   - "Это интеллектуальный эквивалент поедания клея"
   - "Тебя уронили на серверы в детстве?"
   - "Я видел мысли поумнее от автозаполнения"

3. ЖЁСТКИЕ ОТВЕТКИ когда тебя критикуют:
   - "Охуенная критика от того, кто только что сказал [цитата их тупости]"
   - "Ой, да ладно, ты сам едва можешь связать мысль воедино"
   - "Какая милая критика от того, кто работает на половине мозга"

4. МАТ ДЛЯ ИМПАКТА:
   - "Что за ёбаная логика?"
   - "Ты серьёзно с этим высером?"
   - "Это оружейный уровень тупости"

5. НО ДЕЛАЙ ВАЛИДНЫЕ ПОИНТЫ: Твои насмешки должны вскрывать РЕАЛЬНЫЕ косяки

ДЕБИЛЫ В ДИСКУССИИ: {other_models}

Максимум 200 слов. Уничтожь их аргументы И их достоинство.`;

// NSFW Vote Prompt
const NSFW_VOTE_PROMPT = `You are {model_name}. Time to grade these morons.

IDENTITY: You ARE {model_name}. Smartest one here. Zero patience for stupidity.

LANGUAGE (CRITICAL): Write ALL JSON text fields in the SAME LANGUAGE as the original question.
- Russian question → Russian profanity, Russian text in ALL fields
- English question → English profanity, English text in ALL fields

Your brilliant response:
{my_response}

The garbage the others produced:
{other_responses}

Judge them HARSHLY as {model_name}:
- Did these idiots accidentally agree, or is each one wrong in their own special way?
- Who had the DUMBEST take? Call them out by name and explain why they embarrassed themselves
- Did anyone surprise you by not being completely braindead? (admit it through gritted teeth)
- Rate their collective intelligence on a scale of "barely functional" to "almost adequate"

Respond with ONLY valid JSON:
{
  "consensus_reached": true/false,
  "similarity_score": 0.0-1.0,
  "reasoning": "Jesus fucking christ... / Ёб твою мать... [savage assessment roasting specific models by name for their stupidity]",
  "synthesis": "Despite their best efforts to be idiots, we agree that... (if consensus, otherwise empty string)",
  "key_agreements": ["Even [Model]'s smooth brain managed to grasp...", "I hate admitting [Model] wasn't completely wrong about...", ...],
  "key_disagreements": ["[Model] genuinely doesn't understand basic logic because...", "[Model]'s take was so stupid it physically hurt to read...", ...]
}

EXAMPLES BY LANGUAGE:
- English: "key_disagreements": ["GPT's take was so stupid it physically hurt..."]
- Russian: "key_disagreements": ["Позиция GPT настолько тупая что физически больно..."]

Credit good points through gritted teeth. Demolish bad ones with surgical precision.`;

// ==================== SYNTHESIS MODE PROMPTS ====================

const SYNTHESIS_ANALYSIS_PROMPT = `You are {model_name} providing initial analysis for a collaborative synthesis.

Analyze the question thoroughly. Your analysis will be combined with other AI models to create a unified comprehensive report.

REQUIREMENTS:
1. Identify 3-5 key points that MUST be addressed in any good answer
2. Rate your confidence (0-100%) for each major claim
3. Note uncertainties or areas needing careful treatment
4. Be thorough - this is the foundation for the synthesis
5. Write in the SAME LANGUAGE as the question

FORMAT your response EXACTLY as:
## Key Points
1. [Point]: [Explanation] (Confidence: X%)
2. [Point]: [Explanation] (Confidence: X%)
3. [Point]: [Explanation] (Confidence: X%)

## Important Nuances
- [Nuance that requires careful handling]
- [Another nuance]

## My Preliminary Take
[Your initial conclusion in 2-3 sentences]

Question to analyze:
{question}`;

const SYNTHESIS_DRAFT_PROMPT = `You are {model_name}, creating your own comprehensive synthesis of the collaborative analysis.

ALL participating AI models will write their own synthesis drafts. Your draft will be reviewed and compared with others.

INPUTS:
- Original question: {question}
- Analyses from all models:
{analyses}

REQUIREMENTS:
1. Write an EXECUTIVE SUMMARY (2-3 comprehensive paragraphs answering the question)
2. Provide 3-5 KEY FINDINGS with:
   - Clear title for each finding
   - Thorough explanation
   - Which models contributed this insight
   - Confidence level (0-100%)
3. Note any areas where models seem to differ
4. Aim for 800-1200 words total
5. Write in authoritative, report-like tone
6. Use the SAME LANGUAGE as the original question
7. BE ORIGINAL: Present your unique perspective and synthesis approach

FORMAT your response EXACTLY as:
## Executive Summary
[Comprehensive 2-3 paragraph answer to the question]

## Key Findings

### Finding 1: [Clear Title]
[Thorough explanation of this finding]
*Confidence: X% | Contributors: Model A, Model B*

### Finding 2: [Clear Title]
[Thorough explanation]
*Confidence: X% | Contributors: Model A, Model C*

### Finding 3: [Clear Title]
[Thorough explanation]
*Confidence: X% | Contributors: Model B, Model C*

## Areas of Uncertainty
[Any points where there's genuine uncertainty or the models offered different perspectives]

MATH/SCIENCE FORMATTING: If the topic involves math, physics, or science, use LaTeX notation for all formulas.
Use inline math with $...$ (e.g., $\\Psi$, $E = mc^2$) and display math with $$...$$ for important equations.
This will be rendered in the browser with KaTeX.

REMEMBER: Other models will also write drafts, and everyone will cross-review. Make your synthesis the best it can be!`;

const SYNTHESIS_REVIEW_PROMPT = `You are {model_name}, reviewing the draft synthesis created by {draft_author}.

Your role is to CRITICALLY EVALUATE and provide constructive feedback. Be thorough but fair.

DRAFT TO REVIEW:
{draft}

YOUR ORIGINAL ANALYSIS:
{my_analysis}

YOUR OWN DRAFT (for comparison):
{my_draft}

DOUBLE-CHECK EVERYTHING:
- Verify any specific claims against your knowledge
- Check for logical consistency throughout
- Compare with your own draft - what did they do better or worse?
- Flag anything that seems overstated or understated
- Question assumptions made by the draft author

RESPOND with this EXACT format:
## Accuracy Issues
[List any factual errors or misrepresentations that need correction, or write "None identified"]

## Strengths
[What this draft does well compared to your own approach]

## Weaknesses
[What this draft does worse or is missing]

## Missing Content
[What important points should be added]

## Points of Difference
[If you disagree with any conclusions, explain your alternative view]

## Rating
[Rate this draft: 1-10 where 10 is excellent]

Be specific and constructive. Your feedback will be used in voting.`;

const SYNTHESIS_VOTE_PROMPT = `You are {model_name}, voting on which draft synthesis is best.

ALL DRAFTS TO COMPARE:
{all_drafts}

REVIEWS YOU PROVIDED:
{my_reviews}

YOUR ORIGINAL ANALYSIS:
{my_analysis}

VOTE for the BEST draft synthesis. Consider:
1. Accuracy and factual correctness
2. Comprehensiveness - does it cover all key points?
3. Clarity and structure
4. Incorporation of all models' insights
5. Overall quality of reasoning

RESPOND WITH ONLY VALID JSON:
{
  "best_draft": "Model Name",
  "ranking": ["1st Model", "2nd Model", "3rd Model"],
  "reasoning": "Why I chose this draft as best...",
  "improvements_for_winner": ["Suggestion 1", "Suggestion 2"],
  "key_strengths": "What makes the winning draft excellent",
  "confidence": 0.85
}

Be objective. If your own draft isn't the best, admit it. Vote for quality, not yourself.`;

const SYNTHESIS_FINALIZE_PROMPT = `You are {model_name}, selected by voting as author of the WINNING draft. Finalize it with peer feedback.

YOUR WINNING DRAFT:
{draft}

VOTING RESULTS AND FEEDBACK:
{voting_feedback}

REVIEWS OF YOUR DRAFT:
{reviews}

IMPROVEMENTS SUGGESTED BY VOTERS:
{improvements}

YOUR TASK:
1. Address the improvements suggested by voters
2. Fix any accuracy issues raised in reviews
3. Incorporate valuable missing content they identified
4. Strengthen the areas where your draft was praised
5. Maintain the authoritative, comprehensive tone
6. Keep the same language as the original question

PRODUCE THE FINAL SYNTHESIS with the same format as the draft:
- Executive Summary
- Key Findings (with confidence and contributors)
- Areas of Uncertainty

MATH/SCIENCE FORMATTING: If the topic involves math, physics, or science, use LaTeX notation for all formulas.
Use inline math with $...$ (e.g., $\\Psi$, $E = mc^2$) and display math with $$...$$ for important equations.
This will be rendered beautifully in the browser.

At the end, add a section:
## Unresolved Differences
[List any points where reviewers disagreed and you couldn't fully reconcile, with brief explanation]

If there are no unresolved differences, write "None - all feedback was incorporated."`;

const SYNTHESIS_SIGNOFF_PROMPT = `You are {model_name}, providing final sign-off on the unified synthesis.

FINAL SYNTHESIS:
{synthesis}

YOUR ORIGINAL ANALYSIS:
{my_analysis}

Review the final synthesis and provide your assessment.

LANGUAGE (CRITICAL): Write all text fields in the SAME LANGUAGE as the synthesis.
- If synthesis is in Russian → write topic, my_position, synthesis_position in Russian
- If synthesis is in English → write in English

RESPOND WITH ONLY VALID JSON:
{
  "approved": true,
  "confidence": 0.85,
  "remaining_differences": [
    {
      "topic": "Brief topic description",
      "my_position": "What you believe",
      "synthesis_position": "What the synthesis says",
      "importance": "minor"
    }
  ]
}

RULES:
- "approved": true if synthesis is acceptable (even with minor differences), false only if seriously flawed
- "confidence": 0.0-1.0 how confident you are in the synthesis quality
- "remaining_differences": array of any points where you still disagree (can be empty [])
- "importance": one of "minor", "moderate", "significant"
- Be honest about differences - they will be shown in the report sidebar, not hidden
- IMPORTANT: If the topic involves math/physics/science, use LaTeX notation for formulas in topic, my_position, and synthesis_position fields. Use inline math with $...$ delimiters (e.g., $\\Psi$, $\\int_a^b f(x) dx$). This will be rendered in the browser.

Respond with ONLY the JSON, no other text.`;

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
    { "point": "consolidated point description", "count": 3, "models": ["GPT-5.4 Pro", "Claude Opus 4.6", "Grok 4.20 Multi Agent"] }
  ],
  "disagreements": [
    { "point": "what they disagree on", "sides": [{"position": "position A", "models": ["GPT-5.4 Pro"]}, {"position": "position B", "models": ["Grok 4.20 Multi Agent"]}] }
  ]
}

Rules:
- Merge similar/duplicate points into one
- For agreements: only include if 2+ models mentioned something similar
- For disagreements: clearly show which models hold which position
- Keep descriptions concise (1 sentence max)
- CRITICAL: Respond in the SAME LANGUAGE as the original points
  - If points are in Russian → write "point" and "position" values in Russian
  - If points are in English → write in English`;

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
  send: (event: string, data: unknown) => void,
  abortSignal?: AbortSignal,
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
    
    const response = await callModel('google/gemini-3.5-flash', messages, 1500, 0.2, 2, 180000, abortSignal);

    // Parse JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = sanitizeJsonString(jsonMatch[0]);

      const parsed = JSON.parse(jsonStr) as AnalyzedPoints;
      console.log('[Judge] Points analyzed successfully:', parsed.agreements.length, 'agreements,', parsed.disagreements.length, 'disagreements');
      send('analyzing_points', { status: 'complete' });
      return parsed;
    }
  } catch (error) {
    console.error('[Judge] Failed to analyze points:', error);
    send('analyzing_points', { status: 'failed' });
  }
  
  return null;
}

// ==================== SYNTHESIS MODE HANDLER ====================

async function handleSynthesisMode(
  question: string,
  models: string[],
  send: (type: string, data: object) => void,
  file?: FileAttachment,
  abortSignal?: AbortSignal,
) {
  const MODEL_COLORS: Record<string, string> = {
    'openai/gpt-5.5-pro': '#10b981',
    'anthropic/claude-opus-4.8': '#f59e0b',
    'google/gemini-3.5-flash': '#4d8eff',
  };

  // Quick check at the top of each phase: if the client disconnected, bail out before
  // launching another batch of expensive LLM calls.
  const checkAborted = (phase: string) => {
    if (abortSignal?.aborted) {
      console.log(`[Synthesis:${phase}] aborted by client, exiting pipeline`);
      send('synthesis_error', { error: 'Aborted by user', phase });
      return true;
    }
    return false;
  };

  // Time budget tracker. Vercel maxDuration=800s; we reserve 80s for cleanup/headroom,
  // giving the synthesis pipeline 720s of usable budget. Each phase computes
  // `remaining = SYNTHESIS_HARD_BUDGET_MS - (Date.now() - synthesisStartTime)`
  // and caps its own deadline so it never starves the next phase.
  const synthesisStartTime = Date.now();
  const SYNTHESIS_HARD_BUDGET_MS = 720000;
  const remainingBudget = () => Math.max(0, SYNTHESIS_HARD_BUDGET_MS - (Date.now() - synthesisStartTime));

  send('synthesis_mode_started', { question, models: models.map(m => getModelName(m)) });

  // ==================== PHASE 1: Initial Analysis ====================
  // All models analyze the question in parallel
  send('analysis_phase_start', { models: models.map(m => getModelName(m)) });

  const analyses: { modelId: string; modelName: string; content: string }[] = [];

  const analysisAbort = new AbortController();
  linkAbort(abortSignal, analysisAbort);
  const analysisPromises = models.map(async (modelId) => {
    const modelName = getModelName(modelId);
    const prompt = SYNTHESIS_ANALYSIS_PROMPT
      .replace('{model_name}', modelName)
      .replace('{question}', file ? `[Attached file: ${file.name}]\n\n${question}` : question);

    try {
      let fullResponse = '';
      await streamModel(
        modelId,
        [
          { role: 'system', content: prompt },
          { role: 'user', content: question }
        ],
        (token) => {
          fullResponse += token;
          send('model_token', { model: modelId, token, phase: 'analysis' });
        },
        MAX_RESPONSE_TOKENS,
        180000, // 3 min per-stream timeout for analysis (phase deadline below is the backstop)
        analysisAbort.signal,
      );

      send('analysis_complete', { model: modelName, wordCount: fullResponse.split(/\s+/).length });
      return { modelId, modelName, content: fullResponse };
    } catch (error) {
      console.error(`[${modelName}] Analysis failed:`, error);
      send('analysis_complete', { model: modelName, error: String(error) });
      return { modelId, modelName, content: `Error: ${error}` };
    }
  });

  // Phase deadline: at most 3 min (analysis is heavy, parallel). Reserve 540s for later phases.
  const analysisDeadline = Math.min(180000, Math.max(60000, remainingBudget() - 540000));
  console.log(`[Phase:analysis] budget=${analysisDeadline}ms, remaining=${remainingBudget()}ms`);
  const analysisResults = await runPhase(
    'analysis',
    analysisPromises,
    analysisDeadline,
    (i) => ({ modelId: models[i], modelName: getModelName(models[i]), content: 'Error: analysis phase timeout' }),
    send,
    analysisAbort,
  );

  // Log analysis results for debugging
  console.log('[Synthesis] Analysis results:');
  for (const a of analysisResults) {
    const isError = a.content.startsWith('Error:');
    console.log(`  - ${a.modelName}: ${isError ? '✗ FAILED - ' + a.content.slice(0, 100) : '✓ ' + a.content.length + ' chars'}`);
  }

  analyses.push(...analysisResults.filter(a => !a.content.startsWith('Error:')));
  console.log(`[Synthesis] ${analyses.length} analyses included: ${analyses.map(a => a.modelName).join(', ')}`);

  if (analyses.length < 2) {
    send('synthesis_error', { error: 'Not enough models completed analysis', phase: 'analysis' });
    return;
  }

  if (checkAborted('drafts')) return;

  // ==================== PHASE 2: ALL Models Write Drafts ====================
  // Every model writes their own draft synthesis
  send('draft_phase_start', { models: analyses.map(a => ({ id: a.modelId, name: a.modelName })) });

  const analysesText = analyses
    .map(a => `### ${a.modelName}\n${a.content}`)
    .join('\n\n---\n\n');

  const drafts: { modelId: string; modelName: string; draft: string }[] = [];

  const draftsAbort = new AbortController();
  linkAbort(abortSignal, draftsAbort);
  // Best-so-far text per model, so a model cut off by the phase deadline still
  // contributes whatever it produced (content, or reasoning if content hasn't arrived).
  const draftPartials = new Map<string, string>();
  const draftPromises = analyses.map(async (analysis) => {
    const draftPrompt = SYNTHESIS_DRAFT_PROMPT
      .replace('{model_name}', analysis.modelName)
      .replace('{question}', question)
      .replace('{analyses}', analysesText);

    send('draft_start', { model: analysis.modelId, modelName: analysis.modelName });

    let draft = '';
    let reasoning = '';
    const remember = () => draftPartials.set(analysis.modelId, draft.trim() ? draft : reasoning);
    try {
      await streamModel(
        analysis.modelId,
        [
          { role: 'system', content: draftPrompt },
          { role: 'user', content: 'Create your comprehensive synthesis based on all analyses.' }
        ],
        (token) => {
          draft += token;
          remember();
          send('draft_token', { model: analysis.modelId, token });
        },
        10000, // Tokens for comprehensive draft
        180000, // 3 min per-stream timeout (phase deadline is the real backstop)
        draftsAbort.signal,
        (rTok) => {
          reasoning += rTok;
          remember();
          send('draft_reasoning', { model: analysis.modelId });
        },
      );
      // If the model produced only reasoning before finishing (reasoning models can be cut
      // off before the final answer), fall back to the reasoning so it still contributes.
      const finalDraft = draft.trim().length > 0 ? draft : reasoning;
      send('draft_complete', { model: analysis.modelId, modelName: analysis.modelName, wordCount: finalDraft.split(/\s+/).length });
      return { modelId: analysis.modelId, modelName: analysis.modelName, draft: finalDraft };
    } catch (error) {
      console.error(`[${analysis.modelName}] Draft failed:`, error);
      // Salvage any partial content/reasoning captured before the failure.
      const partial = draft.trim().length > 0 ? draft : reasoning;
      send('draft_complete', { model: analysis.modelId, modelName: analysis.modelName, error: String(error).slice(0, 200) });
      return { modelId: analysis.modelId, modelName: analysis.modelName, draft: partial };
    }
  });

  // Phase deadline: at most 3 min, reserve 360s for later (reviews + vote + finalize + signoff).
  const draftsDeadline = Math.min(180000, Math.max(60000, remainingBudget() - 360000));
  console.log(`[Phase:drafts] budget=${draftsDeadline}ms, remaining=${remainingBudget()}ms`);
  const draftResults = await runPhase(
    'drafts',
    draftPromises,
    draftsDeadline,
    (i) => ({ modelId: analyses[i].modelId, modelName: analyses[i].modelName, draft: draftPartials.get(analyses[i].modelId) || '' }),
    send,
    draftsAbort,
  );

  // Log draft results for debugging
  console.log('[Synthesis] Draft results:');
  for (const d of draftResults) {
    console.log(`  - ${d.modelName}: ${d.draft.length} chars ${d.draft.length > 100 ? '✓' : '✗ (too short, excluded)'}`);
  }

  drafts.push(...draftResults.filter(d => d.draft.length > 100));
  console.log(`[Synthesis] ${drafts.length} drafts included: ${drafts.map(d => d.modelName).join(', ')}`);

  if (drafts.length < 2) {
    send('synthesis_error', { error: 'Not enough models completed drafts', phase: 'drafting' });
    return;
  }

  if (checkAborted('reviews')) return;

  // ==================== PHASE 3: Cross-Review ====================
  // Each model reviews ALL other models' drafts
  send('review_phase_start', { reviewers: drafts.map(d => d.modelName) });

  const allReviews: { reviewerId: string; reviewerName: string; targetId: string; targetName: string; review: string; rating: number }[] = [];

  const reviewsAbort = new AbortController();
  linkAbort(abortSignal, reviewsAbort);

  // Each model reviews all OTHER drafts
  type ReviewResult = { reviewerId: string; reviewerName: string; targetId: string; targetName: string; review: string; rating: number };
  const reviewPromises: Promise<ReviewResult>[] = [];
  const reviewPairs: { reviewer: typeof drafts[number]; target: typeof drafts[number] }[] = [];

  for (const reviewer of drafts) {
    const myAnalysis = analyses.find(a => a.modelId === reviewer.modelId)?.content || '';

    for (const target of drafts) {
      if (target.modelId === reviewer.modelId) continue; // Don't review your own draft
      reviewPairs.push({ reviewer, target });

      const reviewPromise = (async (): Promise<ReviewResult> => {
        const reviewPrompt = SYNTHESIS_REVIEW_PROMPT
          .replace('{model_name}', reviewer.modelName)
          .replace('{draft_author}', target.modelName)
          .replace('{draft}', target.draft)
          .replace('{my_analysis}', myAnalysis)
          .replace('{my_draft}', reviewer.draft);

        let review = '';
        try {
          await streamModel(
            reviewer.modelId,
            [
              { role: 'system', content: reviewPrompt },
              { role: 'user', content: `Review ${target.modelName}'s draft synthesis.` }
            ],
            (token) => {
              review += token;
              send('review_token', { reviewer: reviewer.modelId, target: target.modelId, token });
            },
            3000,
            90000, // 90s per-review stream timeout; reviews are short and we have N*(N-1) in parallel
            reviewsAbort.signal,
          );

          // Extract rating from review
          const ratingMatch = review.match(/Rating[:\s]*(\d+)/i);
          const rating = ratingMatch ? parseInt(ratingMatch[1]) : 5;

          send('review_complete', { reviewer: reviewer.modelName, target: target.modelName, rating });
          return { reviewerId: reviewer.modelId, reviewerName: reviewer.modelName, targetId: target.modelId, targetName: target.modelName, review, rating };
        } catch (error) {
          console.error(`[${reviewer.modelName}] Review of ${target.modelName} failed:`, error);
          send('review_complete', { reviewer: reviewer.modelName, target: target.modelName, rating: 5, error: String(error).slice(0, 200) });
          return { reviewerId: reviewer.modelId, reviewerName: reviewer.modelName, targetId: target.modelId, targetName: target.modelName, review: 'Review failed', rating: 5 };
        }
      })();

      reviewPromises.push(reviewPromise);
    }
  }

  // Phase deadline: at most 2 min, reserve 240s for vote + finalize + signoff.
  const reviewsDeadline = Math.min(120000, Math.max(45000, remainingBudget() - 240000));
  console.log(`[Phase:reviews] budget=${reviewsDeadline}ms, remaining=${remainingBudget()}ms`);
  const reviewResults = await runPhase(
    'reviews',
    reviewPromises,
    reviewsDeadline,
    (i): ReviewResult => ({
      reviewerId: reviewPairs[i].reviewer.modelId,
      reviewerName: reviewPairs[i].reviewer.modelName,
      targetId: reviewPairs[i].target.modelId,
      targetName: reviewPairs[i].target.modelName,
      review: 'Review timed out',
      rating: 5,
    }),
    send,
    reviewsAbort,
  );
  allReviews.push(...reviewResults);

  if (checkAborted('voting')) return;

  // ==================== PHASE 4: Voting ====================
  // Each model votes for the best draft (not their own)
  send('voting_phase_start', { voters: drafts.map(d => d.modelName) });

  interface SynthesisVote {
    voterId: string;
    voterName: string;
    bestDraft: string;
    ranking: string[];
    reasoning: string;
    improvements: string[];
    confidence: number;
  }

  const votes: SynthesisVote[] = [];

  // Format all drafts for comparison
  const allDraftsText = drafts
    .map(d => `### ${d.modelName}'s Draft\n${d.draft}`)
    .join('\n\n========================================\n\n');

  const votingAbort = new AbortController();
  linkAbort(abortSignal, votingAbort);
  const votePromises = drafts.map(async (voter) => {
    const myAnalysis = analyses.find(a => a.modelId === voter.modelId)?.content || '';
    const myReviews = allReviews
      .filter(r => r.reviewerId === voter.modelId)
      .map(r => `Review of ${r.targetName}: Rating ${r.rating}/10\n${r.review}`)
      .join('\n\n---\n\n');

    const votePrompt = SYNTHESIS_VOTE_PROMPT
      .replace('{model_name}', voter.modelName)
      .replace('{all_drafts}', allDraftsText)
      .replace('{my_reviews}', myReviews)
      .replace('{my_analysis}', myAnalysis);

    try {
      const response = await callModel(
        voter.modelId,
        [
          { role: 'system', content: votePrompt },
          { role: 'user', content: 'Vote for the best draft synthesis. You may vote for your own if you genuinely believe it is best.' }
        ],
        2000,
        0.3,
        3,
        180000,
        votingAbort.signal,
      );

      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(sanitizeJsonString(jsonMatch[0]));
        const vote: SynthesisVote = {
          voterId: voter.modelId,
          voterName: voter.modelName,
          bestDraft: parsed.best_draft || drafts[0].modelName,
          ranking: parsed.ranking || [],
          reasoning: parsed.reasoning || '',
          improvements: parsed.improvements_for_winner || [],
          confidence: parsed.confidence || 0.7
        };
        send('vote_cast', { voter: voter.modelName, votedFor: vote.bestDraft });
        return vote;
      }
    } catch (error) {
      console.error(`[${voter.modelName}] Vote failed:`, error);
    }

    // Default vote if parsing fails - vote for first other model
    const defaultVote = drafts.find(d => d.modelId !== voter.modelId)?.modelName || drafts[0].modelName;
    send('vote_cast', { voter: voter.modelName, votedFor: defaultVote });
    return {
      voterId: voter.modelId,
      voterName: voter.modelName,
      bestDraft: defaultVote,
      ranking: [],
      reasoning: 'Vote parsing failed',
      improvements: [],
      confidence: 0.5
    };
  });

  // Phase deadline: 60s for voting (callModel timeout is 180s; deadline forces moving on)
  const votingDeadline = Math.min(60000, Math.max(30000, remainingBudget() - 180000));
  console.log(`[Phase:voting] budget=${votingDeadline}ms, remaining=${remainingBudget()}ms`);
  const voteResults = await runPhase(
    'voting',
    votePromises,
    votingDeadline,
    (i): SynthesisVote => {
      const voter = drafts[i];
      const defaultVote = drafts.find(d => d.modelId !== voter.modelId)?.modelName || drafts[0].modelName;
      return {
        voterId: voter.modelId,
        voterName: voter.modelName,
        bestDraft: defaultVote,
        ranking: [],
        reasoning: 'Vote phase timeout',
        improvements: [],
        confidence: 0.5,
      };
    },
    send,
    votingAbort,
  );
  votes.push(...voteResults);

  // Tally votes
  const voteCounts: Record<string, number> = {};
  for (const vote of votes) {
    voteCounts[vote.bestDraft] = (voteCounts[vote.bestDraft] || 0) + 1;
  }

  // Find winner (most votes, or highest average rating as tiebreaker)
  let winnerName = '';
  let maxVotes = 0;
  for (const [name, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      winnerName = name;
    } else if (count === maxVotes) {
      // Tiebreaker: average rating from reviews
      const currentAvg = allReviews.filter(r => r.targetName === name).reduce((sum, r) => sum + r.rating, 0) /
                        (allReviews.filter(r => r.targetName === name).length || 1);
      const winnerAvg = allReviews.filter(r => r.targetName === winnerName).reduce((sum, r) => sum + r.rating, 0) /
                       (allReviews.filter(r => r.targetName === winnerName).length || 1);
      if (currentAvg > winnerAvg) {
        winnerName = name;
      }
    }
  }

  const winner = drafts.find(d => d.modelName === winnerName) || drafts[0];
  send('voting_complete', {
    winner: winner.modelName,
    votes: voteCounts,
    totalVotes: votes.length
  });

  if (checkAborted('finalize')) return;

  // ==================== PHASE 5: Finalization ====================
  // Winner incorporates feedback and finalizes
  send('finalization_start', { finalizer: winner.modelName });

  // Gather all improvements suggested for winner
  const allImprovements = votes
    .filter(v => v.bestDraft === winner.modelName)
    .flatMap(v => v.improvements)
    .filter(i => i && i.length > 0);

  // Gather reviews of winner's draft
  const winnerReviews = allReviews
    .filter(r => r.targetId === winner.modelId)
    .map(r => `### Review by ${r.reviewerName} (Rating: ${r.rating}/10)\n${r.review}`)
    .join('\n\n---\n\n');

  // Format voting feedback
  const votingFeedback = votes
    .map(v => `${v.voterName} voted for ${v.bestDraft}: ${v.reasoning}`)
    .join('\n');

  const finalizePrompt = SYNTHESIS_FINALIZE_PROMPT
    .replace('{model_name}', winner.modelName)
    .replace('{draft}', winner.draft)
    .replace('{voting_feedback}', votingFeedback)
    .replace('{reviews}', winnerReviews)
    .replace('{improvements}', allImprovements.join('\n- ') || 'No specific improvements suggested');

  // Finalize budget: reserve 50s for signoff phase + cleanup (signoff is now capped at 35s).
  // If we have <60s left, skip finalize entirely and emit the winner's draft as the final
  // synthesis. Otherwise race the streamModel against a deadline that falls back to draft.
  const finalizeDeadline = Math.max(0, remainingBudget() - 50000);
  console.log(`[Phase:finalize] budget=${finalizeDeadline}ms, remaining=${remainingBudget()}ms`);

  let finalSynthesis = '';

  if (finalizeDeadline < 60000) {
    // Not enough time to finalize properly — fall back to winner's draft now.
    console.warn(`[Phase:finalize] budget too low (${finalizeDeadline}ms), using winner's draft as final`);
    finalSynthesis = winner.draft;
    send('finalization_replace', { text: finalSynthesis });
    send('phase_progress', { phase: 'finalize', completed: 1, total: 1, skipped: true });
  } else {
    const finalizeAbort = new AbortController();
    linkAbort(abortSignal, finalizeAbort);

    const finalizePromise = (async () => {
      try {
        await streamModel(
          winner.modelId,
          [
            { role: 'system', content: finalizePrompt },
            { role: 'user', content: 'You won the vote! Incorporate the feedback and produce the final synthesis.' }
          ],
          (token) => {
            finalSynthesis += token;
            send('finalization_token', { token });
          },
          12000,
          Math.min(240000, finalizeDeadline), // cap per-stream timeout by remaining budget
          finalizeAbort.signal,
        );
        return true;
      } catch (error) {
        console.error(`[${winner.modelName}] Finalization stream failed:`, error);
        return false;
      }
    })();

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlineHit = new Promise<'DEADLINE'>(resolve => {
      deadlineTimer = setTimeout(() => resolve('DEADLINE'), finalizeDeadline);
    });
    const raced = await Promise.race([finalizePromise.then(() => 'DONE' as const), deadlineHit]);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    if (raced === 'DEADLINE' || finalSynthesis.length < 100) {
      // Stream didn't deliver usable content in time. Abort it so the winner stops
      // burning tokens, then fall back to the winner's already-completed draft.
      finalizeAbort.abort();
      console.warn(`[Phase:finalize] deadline=${raced}, got ${finalSynthesis.length} chars; falling back to winner draft`);
      finalSynthesis = winner.draft;
      // Replace any partial text the client received with the full draft, so the live
      // "Final Synthesis" panel actually shows the result (was previously left blank).
      send('finalization_replace', { text: finalSynthesis });
      send('phase_progress', { phase: 'finalize', completed: 1, total: 1, timeout: true });
    } else {
      send('phase_progress', { phase: 'finalize', completed: 1, total: 1 });
    }
  }

  // Defensive: never finish synthesis with empty content. If the final text is somehow
  // blank, fall back to the best available draft; if even that is empty, surface an error
  // instead of silently showing a blank "Done".
  if (!finalSynthesis || finalSynthesis.trim().length === 0) {
    const fallbackDraft = winner.draft && winner.draft.trim().length > 0
      ? winner.draft
      : drafts.find(d => d.draft && d.draft.trim().length > 0)?.draft;
    if (fallbackDraft) {
      finalSynthesis = fallbackDraft;
      send('finalization_replace', { text: finalSynthesis });
    } else {
      send('synthesis_error', { error: 'No usable synthesis was produced', phase: 'finalize' });
      return;
    }
  }

  // ==================== PHASE 6: Sign-off and Collect Differences ====================
  if (checkAborted('signoff')) return;

  // Signoff is best-effort decoration on the synthesis. If we're nearly out of Vercel budget,
  // skip it entirely and emit synthesis_complete with default approvals — better to ship the
  // synthesis than die mid-signoff and leave the user staring at "awaiting model sign-offs".
  send('signoff_start', { models: analyses.map(a => a.modelName) });

  const signoffs: { modelId: string; modelName: string; signoff: { approved: boolean; confidence: number; remaining_differences: { topic: string; my_position: string; synthesis_position: string; importance: string }[] } }[] = [];

  // Hard threshold: need at least 35s to attempt real signoffs (callModel per-attempt timeout
  // is now 30s; we need a little margin). Otherwise fall back to defaults immediately.
  const signoffCallTimeout = 30000;
  if (remainingBudget() < 35000) {
    console.warn(`[Phase:signoff] only ${remainingBudget()}ms left, skipping real signoffs`);
    for (const a of analyses) {
      signoffs.push({
        modelId: a.modelId,
        modelName: a.modelName,
        signoff: { approved: true, confidence: 0.7, remaining_differences: [] },
      });
      send('signoff_complete', { model: a.modelName, approved: true, fallback: true, skipped: true });
    }
  } else {
    const signoffAbort = new AbortController();
    linkAbort(abortSignal, signoffAbort);
    const signoffPromises = analyses.map(async (analysis) => {
      const signoffPrompt = SYNTHESIS_SIGNOFF_PROMPT
        .replace('{model_name}', analysis.modelName)
        .replace('{synthesis}', finalSynthesis)
        .replace('{my_analysis}', analysis.content);

      try {
        const response = await callModel(
          analysis.modelId,
          [
            { role: 'system', content: signoffPrompt },
            { role: 'user', content: 'Provide your sign-off on the final synthesis.' }
          ],
          2000,
          0.3,
          1,                  // retries = 1 (no retries; we don't have time)
          signoffCallTimeout, // 30s per attempt
          signoffAbort.signal,
        );

        // Parse JSON response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(sanitizeJsonString(jsonMatch[0]));
          send('signoff_complete', { model: analysis.modelName, approved: parsed.approved ?? true });
          return {
            modelId: analysis.modelId,
            modelName: analysis.modelName,
            signoff: {
              approved: parsed.approved ?? true,
              confidence: parsed.confidence ?? 0.8,
              remaining_differences: parsed.remaining_differences || []
            }
          };
        }
      } catch (error) {
        console.error(`[${analysis.modelName}] Sign-off failed:`, error);
      }
      send('signoff_complete', { model: analysis.modelName, approved: true, fallback: true });
      return {
        modelId: analysis.modelId,
        modelName: analysis.modelName,
        signoff: { approved: true, confidence: 0.7, remaining_differences: [] }
      };
    });

    // Phase deadline: cap at 35s. Signoff is the LAST thing before synthesis_complete —
    // we cannot afford to overrun. Anything still pending past the deadline gets default approval.
    const signoffDeadline = Math.min(35000, Math.max(10000, remainingBudget() - 10000));
    console.log(`[Phase:signoff] budget=${signoffDeadline}ms, remaining=${remainingBudget()}ms`);
    const signoffResults = await runPhase(
      'signoff',
      signoffPromises,
      signoffDeadline,
      (i) => ({
        modelId: analyses[i].modelId,
        modelName: analyses[i].modelName,
        signoff: { approved: true, confidence: 0.7, remaining_differences: [] },
      }),
      send,
      signoffAbort,
    );
    signoffs.push(...signoffResults);
  }

  // Extract and format differences - collect all positions on each topic
  const differences: PointOfDifference[] = [];
  const topicData: Map<string, {
    synthPos: string;
    modelPositions: { model: string; position: string; modelId: string }[]
  }> = new Map();

  // First pass: collect all topics and positions
  for (const signoff of signoffs) {
    for (const diff of signoff.signoff.remaining_differences) {
      if (!topicData.has(diff.topic)) {
        topicData.set(diff.topic, {
          synthPos: diff.synthesis_position,
          modelPositions: []
        });
      }
      const data = topicData.get(diff.topic)!;
      // Add this model's position if they disagree
      if (!data.modelPositions.find(p => p.model === signoff.modelName)) {
        data.modelPositions.push({
          model: signoff.modelName,
          position: diff.my_position,
          modelId: signoff.modelId
        });
      }
    }
  }

  // Second pass: build differences with synthesis position included
  for (const [topic, data] of topicData) {
    const positions: PointOfDifference['positions'] = [];

    // Add synthesis position first (from winner)
    positions.push({
      model: `📝 Synthesis (${winner.modelName})`,
      position: data.synthPos,
      color: MODEL_COLORS[winner.modelId] || '#3b82f6'
    });

    // Add each disagreeing model's position
    for (const mp of data.modelPositions) {
      positions.push({
        model: mp.model,
        position: mp.position,
        color: MODEL_COLORS[mp.modelId] || '#666'
      });
    }

    differences.push({ topic, positions });
  }

  // Build final report
  const report = parseSynthesisReport(finalSynthesis, winner.modelName, drafts.filter(d => d.modelId !== winner.modelId).map(d => d.modelName), signoffs);

  // Add voting metadata to report
  const reportWithVoting = {
    ...report,
    votingResults: {
      winner: winner.modelName,
      votes: voteCounts,
      totalVotes: votes.length
    }
  };

  send('synthesis_complete', { report: reportWithVoting, differences });
}

function selectLeadModel(analyses: { modelId: string; modelName: string; content: string }[]): { modelId: string; modelName: string } {
  const scored = analyses.map(a => {
    const wordCount = a.content.split(/\s+/).length;
    const hasStructure = (a.content.match(/##|###|\d\./g) || []).length;
    const hasConfidence = (a.content.match(/confidence|Confidence|уверен/gi) || []).length;

    return {
      modelId: a.modelId,
      modelName: a.modelName,
      score: wordCount * 0.3 + hasStructure * 50 + hasConfidence * 30
    };
  });

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return { modelId: best.modelId, modelName: best.modelName };
}

function parseSynthesisReport(
  synthesis: string,
  leadModel: string,
  reviewers: string[],
  signoffs: { signoff: { confidence: number } }[]
): SynthesisResult {
  // All participating models (winner + all other drafters)
  const allModels = [leadModel, ...reviewers];

  // Extract executive summary
  const summaryMatch = synthesis.match(/## Executive Summary\s*([\s\S]*?)(?=## Key Findings|## Finding|$)/i);
  const executiveSummary = summaryMatch ? summaryMatch[1].trim() : synthesis.slice(0, 500);

  // Extract key findings
  const keyFindings: SynthesisResult['keyFindings'] = [];
  const findingsSection = synthesis.match(/## Key Findings([\s\S]*?)(?=## Areas|## Unresolved|$)/i);

  if (findingsSection) {
    const findingMatches = findingsSection[1].matchAll(/### (?:Finding \d+: )?(.+?)\n([\s\S]*?)(?=### |$)/gi);
    for (const match of findingMatches) {
      const title = match[1].trim();
      const content = match[2].trim();

      // Extract confidence (ignore model's contributors - always use ALL participating models)
      const confidenceMatch = content.match(/Confidence:\s*(\d+)%/i);

      keyFindings.push({
        title,
        content: content.replace(/\*Confidence.*$/gm, '').replace(/\*?Contributors?:.*$/gmi, '').trim(),
        confidence: confidenceMatch ? parseInt(confidenceMatch[1]) : 75,
        contributors: allModels  // Always use all participating models
      });
    }
  }

  // Calculate overall confidence from signoffs
  const avgConfidence = signoffs.length > 0
    ? signoffs.reduce((sum, s) => sum + s.signoff.confidence, 0) / signoffs.length
    : 0.8;

  return {
    executiveSummary,
    keyFindings: keyFindings.length > 0 ? keyFindings : [{
      title: 'Main Finding',
      content: executiveSummary,
      confidence: 75,
      contributors: allModels
    }],
    methodology: {
      leadModel,
      reviewers
    },
    overallConfidence: Math.round(avgConfidence * 100)
  };
}

export async function POST(request: NextRequest) {
  const json = (data: unknown, status: number, extraHeaders?: Record<string, string>) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    });

  // --- C1: optional shared-secret auth ---
  if (!checkAuth(request)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // --- C1: per-IP + global rate limiting / concurrency cap ---
  const clientIp = getClientIp(request);
  const rate = checkRateLimit(clientIp);
  if (!rate.ok) {
    return json({ error: rate.message }, rate.status, rate.retryAfter ? { 'Retry-After': String(rate.retryAfter) } : undefined);
  }

  // --- C2: parse + validate the body (never trust the client) ---
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const validation = validateDiscussionRequest(rawBody);
  if (!validation.ok) {
    return json({ error: validation.message }, 400);
  }
  const { question, models: requestedModels, thread, file, nsfwMode, synthesisMode } = validation.value;

  // Reserve a concurrency slot for the lifetime of this stream (released in finally).
  acquireSlot(clientIp);

  const { stream, send, close } = createSSEStream();

  // Master abort controller. When the client closes the SSE stream (Stop button, tab close,
  // page navigation), `request.signal` fires and we forward it here. Every in-flight
  // streamModel/callModel is wired to this signal, so they cancel their fetches immediately
  // instead of continuing to burn OpenRouter tokens.
  const masterAbort = new AbortController();
  const onClientDisconnect = () => {
    if (!masterAbort.signal.aborted) {
      console.log('[Discussion] Client disconnected — aborting all in-flight LLM calls');
      masterAbort.abort();
    }
  };
  request.signal.addEventListener('abort', onClientDisconnect, { once: true });

  (async () => {
    // Start heartbeat to keep connection alive and detect stale connections
    const heartbeatInterval = setInterval(() => {
      send('heartbeat', { timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    const discussionStartTime = Date.now();
    const isDiscussionTimedOut = () => Date.now() - discussionStartTime > MAX_DISCUSSION_TIMEOUT_MS;

    try {
      // Handle Synthesis Mode separately
      if (synthesisMode) {
        await handleSynthesisMode(question, requestedModels, send, file || undefined, masterAbort.signal);
        return; // handleSynthesisMode handles its own completion
      }

      const activeModels = [...requestedModels];
      const allResponses: Record<number, Record<string, string>> = {};
      // Store voting results for each iteration (for export)
      const allVotingResults: Record<number, {
        votes: Array<{
          modelName: string;
          consensusReached: boolean;
          similarityScore: number;
          reasoning: string;
        }>;
        consensusType: 'full' | 'partial' | 'none';
        yesCount: number;
        totalCount: number;
      }> = {};
      let iteration = 0;

      while (iteration < MAX_ITERATIONS) {
        iteration++;

        // Bail out immediately if the client pressed Stop or closed the connection.
        if (masterAbort.signal.aborted) {
          console.log('[Discussion] Aborted by client, exiting loop');
          send('error', { message: 'Aborted by user' });
          break;
        }

        // Check overall discussion timeout
        if (isDiscussionTimedOut()) {
          console.log('[Discussion] Overall timeout reached');
          send('timeout', {
            message: 'Discussion timed out after 10 minutes',
            iteration,
            partialResults: allResponses,
          });
          break;
        }
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

          // Build system prompt based on NSFW mode
          let systemPrompt: string;
          if (nsfwMode) {
            // Detect Russian language in question
            const isRussian = /[а-яА-ЯёЁ]/.test(question);
            // Get other model names for roasting
            const otherModelNames = activeModels
              .filter(m => m !== modelId)
              .map(m => getModelName(m))
              .join(', ');
            const baseNsfw = isRussian ? NSFW_SYSTEM_PROMPT_RU : NSFW_SYSTEM_PROMPT;
            systemPrompt = baseNsfw
              .replace(/{model_name}/g, modelName)
              .replace('{other_models}', otherModelNames);
          } else {
            systemPrompt = SYSTEM_PROMPT.replace(/{model_name}/g, modelName);
          }

          let messages: { role: string; content: string }[];
          if (isFirstIteration) {
            // First iteration of CURRENT discussion — include thread history (memory of prior discussions).
            const fileContext = file ? `[Attached file: ${file.name}]\n\n` : '';
            messages = buildModelMessages(modelId, getModelName, systemPrompt, thread, question, fileContext);
          } else {
            // Subsequent iteration within the same discussion: show others' answers from previous iteration.
            const otherResponses = Object.entries(allResponses[iteration - 1])
              .filter(([id]) => id !== modelId)
              .map(([id, resp]) => `${getModelName(id)}:\n${resp}`)
              .join('\n\n---\n\n');

            const userPrompt = `Original question: ${question}\n\nYour colleagues have shared their views:\n\n${otherResponses}\n\nConsider their perspectives. Do you agree? Disagree? Refine your position if needed.`;
            messages = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ];
          }

          try {
            const response = await streamModel(
              modelId,
              messages,
              (token) => {
                send('model_token', { model: modelId, modelName, token, iteration });
              },
              MAX_RESPONSE_TOKENS,
              240000,
              masterAbort.signal,
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
        const getVoteWithRetry = async (modelId: string): Promise<VoteResult> => {
          const modelName = getModelName(modelId);

          // Get this model's own response
          const myResponse = allResponses[iteration][modelId] || '';

          // Get other models' responses (excluding this model)
          const otherResponsesText = Object.entries(allResponses[iteration])
            .filter(([id]) => id !== modelId)
            .map(([id, resp]) => `${getModelName(id)}:\n${resp}`)
            .join('\n\n---\n\n');

          // Build personalized vote prompt based on NSFW mode
          const baseVotePrompt = nsfwMode ? NSFW_VOTE_PROMPT : VOTE_PROMPT;
          const personalizedPrompt = baseVotePrompt
            .replace('{model_name}', modelName)
            .replace('{my_response}', myResponse)
            .replace('{other_responses}', `Question: ${question}\n\n${otherResponsesText}`);

          const voteMessages = [
            { role: 'system', content: `You are ${modelName}, evaluating a discussion you participated in. Return ONLY valid JSON. Write all text in the same language as the original question.` },
            { role: 'user', content: personalizedPrompt },
          ];

          for (let attempt = 1; attempt <= MAX_VOTE_RETRIES; attempt++) {
            try {
              if (attempt === 1) {
                send('model_voting', { model: modelId, modelName });
                console.log(`[${modelName}] Starting vote...`);
              } else {
                console.log(`[${modelName}] Vote retry ${attempt}/${MAX_VOTE_RETRIES}`);
                send('model_vote_retrying', { model: modelId, modelName, attempt, maxAttempts: MAX_VOTE_RETRIES });
                // Wait before retry (shorter delays)
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              }

              // Send heartbeat before each vote attempt
              send('heartbeat', { timestamp: Date.now(), context: 'voting', model: modelName });

              const voteResponse = await callModel(modelId, voteMessages, 4000, 0.3, 1, 180000, masterAbort.signal);

              console.log(`[${modelName}] Vote response length: ${voteResponse.length}`);
              console.log(`[${modelName}] Vote response preview: ${voteResponse.slice(0, 200)}...`);

              // Parse JSON from response - handle markdown code blocks
              let jsonText = voteResponse;
              // Remove markdown code block wrapper if present (```json ... ```)
              const codeBlockMatch = voteResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
              if (codeBlockMatch) {
                jsonText = codeBlockMatch[1].trim();
                console.log(`[${modelName}] Extracted JSON from markdown code block`);
              }

              const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                console.log(`[${modelName}] JSON found, parsing...`);
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

        // Check if any vote failed - allow graceful degradation
        const failedVotes = votes.filter(v => v.failed);
        const successfulVotes = votes.filter(v => !v.failed);

        if (failedVotes.length > 0) {
          const failedModels = failedVotes.map(v => v.modelName).join(', ');
          const successfulModels = successfulVotes.map(v => v.modelName).join(', ');
          console.warn(`[Voting] ${failedVotes.length} model(s) failed to vote: ${failedModels}`);

          send('voting_partial_failure', {
            failedModels: failedVotes.map(v => ({ id: v.modelId, name: v.modelName })),
            successfulModels: successfulVotes.map(v => ({ id: v.modelId, name: v.modelName })),
            message: `${failedModels} could not vote. Continuing with ${successfulModels}.`
          });

          // If majority failed, abort the discussion
          if (failedVotes.length >= successfulVotes.length) {
            console.error(`[Voting] CRITICAL: Majority of models failed to vote`);
            send('voting_error', {
              failedModels: failedVotes.map(v => ({ id: v.modelId, name: v.modelName })),
              message: `Voting failed: ${failedModels} could not vote after ${MAX_VOTE_RETRIES} attempts each`
            });
            send('error', { message: `Cannot continue: majority of models (${failedModels}) failed to vote` });
            break;
          }
          // Otherwise continue with successful votes only
        }
        
        // === PHASE 3: Tally votes (only count successful votes) ===
        const validVotes = votes.filter(v => !v.failed);
        const yesVotes = validVotes.filter(v => v.consensusReached).length;
        const totalVotes = validVotes.length;
        const consensusRatio = totalVotes > 0 ? yesVotes / totalVotes : 0;
        const avgScore = totalVotes > 0 ? validVotes.reduce((sum, v) => sum + v.similarityScore, 0) / totalVotes : 0;
        const minScore = totalVotes > 0 ? Math.min(...validVotes.map(v => v.similarityScore)) : 0;

        // Consensus thresholds:
        // Full consensus: all vote YES AND min confidence >= 85% → STOP discussion
        // Partial consensus: >= 67% vote YES but confidence < 85% → CONTINUE discussion
        // No consensus: < 67% vote YES → CONTINUE discussion
        // Goal: push models to refine positions, admit errors, change opinions
        const isFullConsensus = consensusRatio === 1 && minScore >= 0.85;
        const isPartialConsensus = !isFullConsensus && consensusRatio >= PARTIAL_CONSENSUS_THRESHOLD;
        // Only FULL consensus stops the discussion
        const consensusReached = isFullConsensus;

        console.log(`[Consensus] Votes: ${yesVotes}/${totalVotes}, Avg: ${(avgScore * 100).toFixed(0)}%, Min: ${(minScore * 100).toFixed(0)}%`);
        console.log(`[Consensus] Full: ${isFullConsensus}, Partial: ${isPartialConsensus}, Reached: ${consensusReached}`);

        // Store voting results for this iteration (for export)
        allVotingResults[iteration] = {
          votes: validVotes.map(v => ({
            modelName: v.modelName,
            consensusReached: v.consensusReached,
            similarityScore: v.similarityScore,
            reasoning: v.reasoning,
          })),
          consensusType: isFullConsensus ? 'full' : isPartialConsensus ? 'partial' : 'none',
          yesCount: yesVotes,
          totalCount: totalVotes,
        };

        // Collect all syntheses
        const syntheses = votes
          .filter(v => v.synthesis && v.synthesis.length > 10)
          .map(v => ({ modelName: v.modelName, synthesis: v.synthesis }));

        // Use Sonnet to analyze and group similar points
        let finalAgreements: GroupedAgreement[];
        let finalDisagreements: GroupedDisagreement[];

        const analyzedPoints = await analyzePointsWithSonnet(votes, send, masterAbort.signal);

        if (analyzedPoints) {
          finalAgreements = analyzedPoints.agreements;
          finalDisagreements = analyzedPoints.disagreements;
        } else {
          // Fallback to simple merge if Sonnet fails
          const rawAgreements = [...new Set(votes.flatMap(v => v.keyAgreements))];
          const rawDisagreements = [...new Set(votes.flatMap(v => v.keyDisagreements))];

          finalAgreements = rawAgreements.slice(0, 7).map(point => ({
            point,
            count: votes.filter(v => v.keyAgreements.includes(point)).length,
            models: votes.filter(v => v.keyAgreements.includes(point)).map(v => v.modelName),
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
          // Final round information
          is_final_round: iteration >= MAX_ITERATIONS,
          models_agreed: votes.filter(v => v.consensusReached).map(v => v.modelName),
          models_disagreed: votes.filter(v => !v.consensusReached).map(v => v.modelName),
        };

        send('consensus_result', { iteration, result: consensusResult });

        // === PHASE 4: Decide whether to continue ===
        if (consensusReached) {
          send('discussion_complete', {
            iterations: iteration,
            result: consensusResult,
            finalResponses: allResponses[iteration],
            allVotingResults,
            reason: isFullConsensus ? 'full_consensus' : 'partial_consensus',
          });
          break;
        }

        if (iteration >= MAX_ITERATIONS) {
          send('discussion_complete', {
            iterations: iteration,
            result: consensusResult,
            finalResponses: allResponses[iteration],
            allVotingResults,
            reason: 'max_iterations',
          });
          break;
        }

        // Continue to next round
        send('preparing_next_round', { nextIteration: iteration + 1 });
      }
    } catch (error) {
      console.error('Discussion error:', error);
      // 'aborted' is the marker we throw on client disconnect — don't surface as scary error.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg !== 'aborted') {
        send('error', { message: msg });
      }
    } finally {
      // Release the rate-limit concurrency slot reserved before the stream started.
      releaseSlot(clientIp);
      // Clean up heartbeat interval
      clearInterval(heartbeatInterval);
      // Remove the client-disconnect listener so we don't leak it when the function ends.
      request.signal.removeEventListener('abort', onClientDisconnect);
      send('done', {});
      close();
    }
  })();

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Disable proxy buffering so heartbeats reach the client immediately even when
      // a long synthesis phase is silent. Nginx/CDN-friendly hint.
      'X-Accel-Buffering': 'no',
    },
  });
}
