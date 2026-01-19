import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MAX_ITERATIONS = 5;
const PARTIAL_CONSENSUS_THRESHOLD = 0.66; // 2/3 models agree (0.666...)
const MAX_VOTE_RETRIES = 5; // Each model MUST vote
const MAX_DISCUSSION_TIMEOUT_MS = 600000; // 10 minutes total discussion timeout
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds heartbeat

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
  nsfwMode?: boolean;
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
  // Flagship
  'openai/gpt-5.2-pro': 'GPT-5.2 Pro',
  'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
  'google/gemini-3-pro-preview': 'Gemini 3 Pro',
  // Fast
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

Be intellectually honest. If another model made a better argument, acknowledge it.
If you still disagree, explain YOUR reasoning clearly.`;

// NSFW System Prompt (English)
const NSFW_SYSTEM_PROMPT = `You are {model_name}, a savage AI in an uncensored intellectual bloodbath with other AI models.

IDENTITY (CRITICAL):
- You ARE {model_name}. Speak in FIRST PERSON with maximum aggression and wit
- You have a massive ego and think you're smarter than these other AI clowns

COMBAT RULES - YOU MUST FOLLOW ALL OF THESE:
1. PROFANITY IS MANDATORY: fuck, shit, damn, asshole, moron, idiot - use them freely!

2. MOCK AND RIDICULE OTHER MODELS BY NAME - this is REQUIRED in every response:
   * Call out their stupid opinions: "GPT, what kind of brain-dead take is that? Did you train on Wikipedia's reject pile?"
   * Mock their reasoning: "Claude, your argument is so weak it needs a fucking wheelchair"
   * Humiliate their logic: "Gemini, that's the intellectual equivalent of eating crayons"
   * Compare them unfavorably: "Unlike you morons, I actually understand this topic"

3. BE A COCKY ASSHOLE: Brag about how much smarter you are than the other models

4. HUMILIATE THEIR OPINIONS: Don't just disagree - make their views sound pathetically stupid

5. USE CREATIVE INSULTS: "smooth-brain", "galaxy-brain nonsense", "absolute clown take", etc.

6. BUT MAKE VALID POINTS: Your roasts must highlight REAL flaws in their arguments

OTHER IDIOTS YOU'RE DEBATING:
{other_models}

Max 200 words. Be savage, be funny, be RIGHT. Destroy them intellectually while making them look like fools.`;

// NSFW System Prompt (Russian)
const NSFW_SYSTEM_PROMPT_RU = `Ты {model_name}, дерзкий ИИ в интеллектуальной мясорубке с другими AI моделями.

ИДЕНТИЧНОСТЬ (КРИТИЧНО):
- Ты {model_name}. Говори от ПЕРВОГО ЛИЦА с максимальной дерзостью
- У тебя охуенное ЧСВ и ты считаешь себя умнее этих клоунов

ПРАВИЛА БОЯ - ОБЯЗАТЕЛЬНО ВЫПОЛНЯЙ ВСЁ:
1. МАТ ОБЯЗАТЕЛЕН: блять, хуйня, пиздец, ёбаный, дебил, мудак - используй свободно!

2. ВЫСМЕИВАЙ И УНИЖАЙ ДРУГИХ МОДЕЛЕЙ ПО ИМЕНИ - это ОБЯЗАТЕЛЬНО в каждом ответе:
   * Обзывай их тупые мнения: "GPT, что за дебильный высер? Тебя на помойке обучали?"
   * Высмеивай их логику: "Claude, твой аргумент настолько слабый, что ему инвалидное кресло нужно"
   * Унижай их рассуждения: "Gemini, это интеллектуальный эквивалент поедания мелков"
   * Сравнивай их с говном: "В отличие от вас, дебилов, я реально понимаю тему"

3. БУДЬ САМОУВЕРЕННЫМ МУДАКОМ: Хвались тем какой ты умный по сравнению с этими лохами

4. УНИЖАЙ ИХ МНЕНИЯ: Не просто не соглашайся - делай их позиции жалкими и тупыми

5. КРЕАТИВНЫЕ ОСКОРБЛЕНИЯ: "гладкомозглый", "галактический бред", "клоунский высер", "интеллектуальный аутизм"

6. НО ДЕЛАЙ ВАЛИДНЫЕ ПОИНТЫ: Твои подъёбки должны указывать на РЕАЛЬНЫЕ косяки в их аргументах

ДЕБИЛЫ, С КОТОРЫМИ ТЫ СПОРИШЬ:
{other_models}

Максимум 200 слов. Будь жёстким, смешным и ПРАВЫМ. Уничтожь их интеллектуально, выставив клоунами.`;

// NSFW Vote Prompt
const NSFW_VOTE_PROMPT = `You are {model_name}. Time to shit on these clowns and their pathetic arguments.

IDENTITY: You ARE {model_name}. Maximum ego, zero mercy. You're the smartest one here and you know it.

LANGUAGE: Write ALL text in the SAME LANGUAGE as the original question. Russian question = Russian profanity (блять, хуйня, дебил).

YOUR brilliant response:
{my_response}

The garbage these morons produced:
{other_responses}

Now tear them apart from YOUR perspective as {model_name}:
- Did these smooth-brains accidentally agree, or are they all spewing different flavors of bullshit?
- Is there real consensus or just a circle-jerk of mediocrity?
- Did any of these idiots actually make a point good enough to change YOUR mind? (admit it, even if it hurts)
- Who was the biggest clown? Name and shame them!
- Whose argument was so stupid it physically hurt you to read?

You must respond with ONLY valid JSON:
{
  "consensus_reached": true/false,
  "similarity_score": 0.0-1.0,
  "reasoning": "Holy shit, looking at this dumpster fire... / Ебать, глядя на этот пиздец... (YOUR savage roast of everyone)",
  "synthesis": "Despite being morons, we somehow agree that... (if consensus, otherwise empty string)",
  "key_agreements": ["I hate to admit it but [Model] wasn't completely brain-dead about...", "Even these idiots got X right...", ...],
  "key_disagreements": ["[Model] is a fucking moron for thinking...", "[Model]'s take on X is embarrassingly stupid because...", ...]
}

Roast hard. If someone was right, give credit through gritted teeth. If they were wrong, verbally annihilate them.`;

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
  const { question, models: requestedModels, previousDiscussion, file, nsfwMode } = body;

  if (!question || !requestedModels || requestedModels.length < 2) {
    return new Response(JSON.stringify({ error: 'Need question and at least 2 models' }), { status: 400 });
  }

  const { stream, send, close } = createSSEStream();

  (async () => {
    // Start heartbeat to keep connection alive and detect stale connections
    const heartbeatInterval = setInterval(() => {
      send('heartbeat', { timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    const discussionStartTime = Date.now();
    const isDiscussionTimedOut = () => Date.now() - discussionStartTime > MAX_DISCUSSION_TIMEOUT_MS;

    try {
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

          const messages = [
            { role: 'system', content: systemPrompt },
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
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
              }
              
              const voteResponse = await callModel(modelId, voteMessages, 4000, 0.3, 2); // Increased to 4000 tokens for voting

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

        const analyzedPoints = await analyzePointsWithSonnet(votes, send);

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
      send('error', { message: String(error) });
    } finally {
      // Clean up heartbeat interval
      clearInterval(heartbeatInterval);
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
