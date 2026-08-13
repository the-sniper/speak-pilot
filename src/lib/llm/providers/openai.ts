import { unwrapArrayTransportResponse, wrapArraySchemaForTransport } from "../transport"
import type { Provider, ProviderCall } from "./types"

// $ per 1M tokens. Deliberately left empty: this project has not verified
// OpenAI's current published pricing against an authoritative source. Populate
// a model here only once its rate is confirmed against OpenAI's pricing page,
// with the source noted alongside the entry.
export const OPENAI_MODEL_RATES: Record<string, { input: number; output: number }> = {}

// `null` means "a real call happened but we don't know what it cost" — not
// the same as `0` ("we know it cost nothing"). A bare $0.00 next to real
// Anthropic-priced rows in the Evals tab would read as a measurement, which
// it isn't; a fabricated non-zero number would be worse. `null` is the only
// honest value here until OPENAI_MODEL_RATES has a verified entry.
function costFor(model: string, promptTokens: number, completionTokens: number): number | null {
  const rate = OPENAI_MODEL_RATES[model]
  if (!rate) return null
  return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output
}

// Chat Completions with a forced function tool — the schema is passed as the
// function's `parameters` with `strict: true`, which requires
// additionalProperties:false and every key listed in `required` (handled by
// adapter.ts's toStrictJsonSchema before this ever sees the schema).
export const openaiProvider: Provider = {
  name: "openai",
  async call({ system, prompt, toolName, jsonSchema, model }: ProviderCall) {
    const apiKey = process.env.LLM_API_KEY
    if (!apiKey) {
      throw new Error("LLM_API_KEY is not set — cannot call the OpenAI provider. Use LLM_PROVIDER=mock or REPLAY=1.")
    }

    // OpenAI's function-calling `parameters` must describe a JSON object —
    // see src/lib/llm/transport.ts for why groundedPlacementsSchema (array-
    // rooted) needs wrapping here and nowhere else.
    const { schema: parameters, wrapped } = wrapArraySchemaForTransport(jsonSchema)

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: toolName,
              description: `Return output conforming exactly to the ${toolName} schema.`,
              parameters,
              strict: true,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: toolName } },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${body}`)
    }

    const body = await res.json()
    const toolCall = body?.choices?.[0]?.message?.tool_calls?.[0]
    if (!toolCall) throw new Error("OpenAI response contained no tool call")

    const parsedArgs: unknown = JSON.parse(toolCall.function.arguments)
    const raw = unwrapArrayTransportResponse(parsedArgs, wrapped)
    const usage = body?.usage ?? {}
    const cost = costFor(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
    return { raw, cost }
  },
}
