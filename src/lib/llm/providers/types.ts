// Every provider (mock, openai, anthropic) implements this one interface. The
// adapter (adapter.ts) only ever talks to `Provider` — swapping the deployed
// provider is a one-line change in `resolveProvider()` there, nothing else in
// the app needs to know which provider is behind it.
export type ProviderCall = {
  system: string
  prompt: string
  toolName: string
  jsonSchema: object
  model: string
}

// `cost` is nullable: `0` means genuinely free (mock — no API call happens
// at all), `null` means a real call was made on a model whose $/token rate
// this codebase hasn't verified. See adapter.ts's RunRow doc comment for why
// that distinction matters to the Evals tab.
export type Provider = {
  name: string
  call(args: ProviderCall): Promise<{ raw: unknown; cost: number | null }>
}
