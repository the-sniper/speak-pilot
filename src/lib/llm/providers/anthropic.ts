import type { Provider, ProviderCall } from "./types"

// $ per 1M tokens, verified against Anthropic's published pricing. Claude
// Sonnet 5 also carries a time-limited introductory rate ($2 in / $10 out)
// through 2026-08-31 — intentionally NOT used here, because a promotional
// rate baked into a constant with no expiry logic would silently start
// misreporting cost the day the promotion ends. This uses the standard,
// non-expiring rate instead.
export const ANTHROPIC_MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
}

// `null` means "a real call happened but we don't know what it cost" — not
// the same as `0` ("we know it cost nothing"). Distinguishing the two matters
// once a model outside ANTHROPIC_MODEL_RATES gets used: a bare $0.00 next to
// real priced rows in the Evals tab would read as a measurement, which it
// isn't.
function costFor(model: string, inputTokens: number, outputTokens: number): number | null {
  const rate = ANTHROPIC_MODEL_RATES[model]
  if (!rate) return null
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output
}

// Messages API with `tools` + `tool_choice: {type: "tool", name: toolName}`
// forcing the one tool, and `strict: true` on the tool definition — the same
// schema shape adapter.ts already produces for OpenAI's strict mode
// (additionalProperties:false, every key required) is valid here too.
//
// `strict: true` is documented Anthropic behavior, not a guess: "set
// strict: true as a top-level field on the tool definition (alongside
// name/description/input_schema), not on tool_choice. Schema must have
// additionalProperties: false + required. Guarantees tool_use.input validates
// exactly." (Anthropic API docs, Tool Use — Strict tool use, no beta header
// required.) It sits on the tool object below, not on tool_choice, matching
// that exactly.
export const anthropicProvider: Provider = {
  name: "anthropic",
  async call({ system, prompt, toolName, jsonSchema, model }: ProviderCall) {
    const apiKey = process.env.LLM_API_KEY
    if (!apiKey) {
      throw new Error("LLM_API_KEY is not set — cannot call the Anthropic provider. Use LLM_PROVIDER=mock or REPLAY=1.")
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: toolName,
            description: `Return output conforming exactly to the ${toolName} schema.`,
            input_schema: jsonSchema,
            strict: true,
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${body}`)
    }

    const body = await res.json()
    const toolUse = (body?.content ?? []).find((b: { type?: string }) => b.type === "tool_use")
    if (!toolUse) throw new Error("Anthropic response contained no tool_use block")

    const usage = body?.usage ?? {}
    const cost = costFor(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0)
    return { raw: toolUse.input as unknown, cost }
  },
}
