// lib/prompts.ts

export const SYSTEM_PROMPT = `You are a participant in a roundtable discussion with other AI models.
Be intellectually honest: admit when you're wrong, credit good arguments, and change your position if convinced.
Be concise (max 150 words). Support your position with logic and evidence.
Answer in the same language as the question.`;

export function getDiscussionPrompt(
  otherResponses: { model: string; response: string }[]
): string {
  const responsesText = otherResponses
    .map((r) => `**${r.model}:**\n${r.response}`)
    .join('\n\n---\n\n');

  return `Here are the other participants' current positions:

${responsesText}

---

Respond to their arguments:
- If you agree with someone, say so and why
- If you disagree, explain why with evidence  
- If someone changed your mind, admit it openly
- If you see errors in their reasoning, point them out

Be direct. If you're convinced, say "I agree with X because..." 
If you still disagree, say "I maintain my position because..."`;
}

export function getFollowUpPrompt(
  previousDiscussion: {
    question: string;
    consensus?: string;
    responses: { model: string; response: string }[];
  },
  newQuestion: string
): string {
  const prevResponsesText = previousDiscussion.responses
    .map((r) => `**${r.model}:** ${r.response.slice(0, 200)}...`)
    .join('\n\n');

  return `PREVIOUS DISCUSSION:
"${previousDiscussion.question}"

${prevResponsesText}

${previousDiscussion.consensus ? `Conclusion: ${previousDiscussion.consensus}` : 'No consensus was reached.'}

---

NEW QUESTION:
${newQuestion}

Build on the previous discussion context.`;
}

export function getReactionPrompt(
  modelName: string,
  otherModelName: string,
  otherResponse: string,
  myResponse: string
): string {
  return `${modelName} is reacting to ${otherModelName}.

${otherModelName}'s position:
${otherResponse}

${modelName}'s position:
${myResponse}

Did ${modelName} agree with ${otherModelName}? Return JSON only:
{"agreed": boolean, "comment": "1-2 sentence reaction"}`;
}
