// lib/security.ts
//
// Server-side hardening for the public /api/discuss endpoint:
//   - optional shared-secret auth   (C1)
//   - per-IP + global rate limiting  (C1)
//   - strict request-body validation (C2)
//
// NOTE on rate limiting: the counters below live in module memory, which on a
// serverless platform (Vercel) means *per warm instance*. This stops casual
// abuse and accidental loops effectively, but for hard multi-instance limits
// back it with an external store (Upstash/Redis). Tunables are env-overridable.

import { AVAILABLE_MODELS } from './openrouter';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000; // 1 min
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 8; // requests / window / IP
const MAX_CONCURRENT_PER_IP = Number(process.env.RATE_LIMIT_CONCURRENCY) || 2;
const GLOBAL_MAX_CONCURRENT = Number(process.env.GLOBAL_MAX_CONCURRENCY) || 12;

// Hard caps on request shape — every one of these directly bounds token spend.
export const LIMITS = {
  QUESTION_MAX_CHARS: 16_000,
  MODELS_MIN: 2,
  MODELS_MAX: 5,
  THREAD_MAX_ENTRIES: 20,
  THREAD_ENTRY_MAX_CHARS: 40_000,
  FILE_MAX_BYTES: 10 * 1024 * 1024, // 10 MB decoded
  FILE_NAME_MAX_CHARS: 256,
} as const;

const ALLOWED_MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));
const ALLOWED_FILE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Auth (optional shared secret)
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time-ish comparison to avoid leaking length/prefix via timing.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Returns true if the request is authorized. Auth is *disabled* when APP_SECRET is unset. */
export function checkAuth(request: Request): boolean {
  const secret = process.env.APP_SECRET;
  if (!secret) return true; // opt-in: app works out of the box with no secret
  const provided = request.headers.get('x-app-secret') || '';
  return timingSafeEqual(provided, secret);
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per instance)
// ---------------------------------------------------------------------------

const hits = new Map<string, number[]>(); // ip -> request timestamps within window
const inflight = new Map<string, number>(); // ip -> concurrent in-flight discussions
let globalInflight = 0;

export type RateResult =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfter?: number };

export function checkRateLimit(ip: string): RateResult {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000));
    return { ok: false, status: 429, message: 'Rate limit exceeded — slow down.', retryAfter };
  }
  if ((inflight.get(ip) || 0) >= MAX_CONCURRENT_PER_IP) {
    return { ok: false, status: 429, message: 'Too many concurrent discussions from your IP.', retryAfter: 10 };
  }
  if (globalInflight >= GLOBAL_MAX_CONCURRENT) {
    return { ok: false, status: 503, message: 'Server at capacity — try again shortly.', retryAfter: 15 };
  }

  recent.push(now);
  hits.set(ip, recent);
  return { ok: true };
}

/** Reserve a concurrency slot for an accepted request. Pair with releaseSlot() in finally. */
export function acquireSlot(ip: string): void {
  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  globalInflight++;
}

export function releaseSlot(ip: string): void {
  const n = (inflight.get(ip) || 1) - 1;
  if (n <= 0) inflight.delete(ip);
  else inflight.set(ip, n);
  globalInflight = Math.max(0, globalInflight - 1);

  // Opportunistic cleanup so the hits map can't grow without bound.
  if (hits.size > 5_000) {
    const now = Date.now();
    for (const [k, v] of hits) {
      const f = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (f.length === 0) hits.delete(k);
      else hits.set(k, f);
    }
  }
}

// ---------------------------------------------------------------------------
// Body validation (never trust the client)
// ---------------------------------------------------------------------------

type ThreadEntryLike = { question: string; finalResponses: Record<string, string>; consensus?: string };
type FileLike = { type: 'image' | 'pdf'; data: string; mimeType: string; name: string };

export type ValidatedRequest = {
  question: string;
  models: string[];
  thread?: ThreadEntryLike[];
  file?: FileLike;
  nsfwMode: boolean;
  synthesisMode: boolean;
};

export type ValidationResult =
  | { ok: true; value: ValidatedRequest }
  | { ok: false; message: string };

export function validateDiscussionRequest(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const b = raw as Record<string, unknown>;

  // question
  if (typeof b.question !== 'string' || b.question.trim().length === 0) {
    return { ok: false, message: 'A non-empty "question" is required.' };
  }
  if (b.question.length > LIMITS.QUESTION_MAX_CHARS) {
    return { ok: false, message: `"question" exceeds ${LIMITS.QUESTION_MAX_CHARS} characters.` };
  }

  // models
  if (!Array.isArray(b.models)) {
    return { ok: false, message: '"models" must be an array.' };
  }
  if (b.models.length < LIMITS.MODELS_MIN || b.models.length > LIMITS.MODELS_MAX) {
    return { ok: false, message: `"models" must contain ${LIMITS.MODELS_MIN}–${LIMITS.MODELS_MAX} entries.` };
  }
  const models: string[] = [];
  for (const m of b.models) {
    if (typeof m !== 'string' || !ALLOWED_MODEL_IDS.has(m)) {
      return { ok: false, message: `Unknown or unsupported model: ${String(m).slice(0, 80)}` };
    }
    models.push(m);
  }
  if (new Set(models).size !== models.length) {
    return { ok: false, message: 'Duplicate models are not allowed.' };
  }

  // thread (optional)
  let thread: ThreadEntryLike[] | undefined;
  if (b.thread !== undefined && b.thread !== null) {
    if (!Array.isArray(b.thread)) {
      return { ok: false, message: '"thread" must be an array.' };
    }
    if (b.thread.length > LIMITS.THREAD_MAX_ENTRIES) {
      return { ok: false, message: `"thread" exceeds ${LIMITS.THREAD_MAX_ENTRIES} entries.` };
    }
    thread = [];
    for (const e of b.thread) {
      if (typeof e !== 'object' || e === null) {
        return { ok: false, message: 'Invalid thread entry.' };
      }
      const te = e as Record<string, unknown>;
      if (typeof te.question !== 'string') {
        return { ok: false, message: 'Thread entry is missing a "question".' };
      }
      if (typeof te.finalResponses !== 'object' || te.finalResponses === null) {
        return { ok: false, message: 'Thread entry is missing "finalResponses".' };
      }
      const finalResponses: Record<string, string> = {};
      let size = te.question.length;
      for (const [k, v] of Object.entries(te.finalResponses as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return { ok: false, message: 'Thread responses must be strings.' };
        }
        size += v.length;
        finalResponses[k] = v;
      }
      if (size > LIMITS.THREAD_ENTRY_MAX_CHARS) {
        return { ok: false, message: 'A thread entry is too large.' };
      }
      const entry: ThreadEntryLike = { question: te.question, finalResponses };
      if (typeof te.consensus === 'string') entry.consensus = te.consensus;
      thread.push(entry);
    }
  }

  // file (optional)
  let file: FileLike | undefined;
  if (b.file !== undefined && b.file !== null) {
    if (typeof b.file !== 'object') {
      return { ok: false, message: '"file" must be an object.' };
    }
    const f = b.file as Record<string, unknown>;
    if (f.type !== 'image' && f.type !== 'pdf') {
      return { ok: false, message: '"file.type" must be "image" or "pdf".' };
    }
    if (typeof f.data !== 'string') {
      return { ok: false, message: '"file.data" must be a base64 string.' };
    }
    if (typeof f.mimeType !== 'string' || !ALLOWED_FILE_MIME.has(f.mimeType)) {
      return { ok: false, message: 'Unsupported "file.mimeType".' };
    }
    if (typeof f.name !== 'string' || f.name.length === 0 || f.name.length > LIMITS.FILE_NAME_MAX_CHARS) {
      return { ok: false, message: 'Invalid "file.name".' };
    }
    // base64 decodes to ~3/4 of its string length.
    const approxBytes = Math.floor((f.data.length * 3) / 4);
    if (approxBytes > LIMITS.FILE_MAX_BYTES) {
      return { ok: false, message: `"file" exceeds ${Math.round(LIMITS.FILE_MAX_BYTES / 1024 / 1024)}MB.` };
    }
    file = { type: f.type, data: f.data, mimeType: f.mimeType, name: f.name };
  }

  return {
    ok: true,
    value: {
      question: b.question,
      models,
      thread,
      file,
      nsfwMode: b.nsfwMode === true,
      synthesisMode: b.synthesisMode === true,
    },
  };
}
