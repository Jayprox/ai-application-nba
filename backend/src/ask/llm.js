// Anthropic Messages API, no SDK (one fetch). Used only to turn a question
// into a structured plan via a forced tool call — never to produce numbers.
export const ASK_MODEL = process.env.ASK_MODEL ?? 'claude-haiku-4-5';

export function createLlm({ key = process.env.ANTHROPIC_API_KEY, model = ASK_MODEL, timeoutMs = 20000 } = {}) {
  return {
    configured: Boolean(key),
    model,
    /** One forced tool call; returns the tool input object. */
    async plan({ system, tool, question }) {
      if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { status: 503 });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model, max_tokens: 600, temperature: 0,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools: [tool], tool_choice: { type: 'tool', name: tool.name },
          messages: [{ role: 'user', content: question }],
        }),
      });
      if (!res.ok) throw Object.assign(new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: 502 });
      const j = await res.json();
      const use = j.content?.find((c) => c.type === 'tool_use');
      if (!use) throw Object.assign(new Error('the model did not return a plan'), { status: 502 });
      return { input: use.input, usage: j.usage };
    },
  };
}
