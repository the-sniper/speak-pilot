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

export type Provider = {
  name: string
  call(args: ProviderCall): Promise<{ raw: unknown; cost: number }>
}
