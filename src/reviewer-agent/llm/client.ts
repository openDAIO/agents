export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  responseFormatJson?: boolean;
}

export interface ChatResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL;
  const model = options.model ?? process.env.LLM_MODEL ?? "gpt-oss-120b";
  if (!baseUrl) throw new Error("LLM_BASE_URL not configured");
  const timeoutMs = options.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  const maxTokens = options.maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 2_048);
  const envTemperature =
    process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== ""
      ? Number(process.env.LLM_TEMPERATURE)
      : undefined;
  const temperature =
    options.temperature ?? (Number.isFinite(envTemperature) ? (envTemperature as number) : 0);

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (options.responseFormatJson !== false) {
    body.response_format = { type: "json_object" };
  }
  // gpt-oss models emit reasoning_content before content; "low" effort keeps the
  // CoT short so the JSON output fits within max_tokens.
  const reasoningEffort = process.env.LLM_REASONING_EFFORT ?? "low";
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm chat http ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`llm chat returned empty content: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return {
    content,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    totalTokens: json.usage?.total_tokens,
  };
}

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // strip ```json fences if model added them despite json_object mode
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  return JSON.parse(candidate!);
}
