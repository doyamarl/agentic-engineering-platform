// The models a tenant admin may choose for chat replies (#43). All run on the instance's Anthropic
// key (ADR-007 covers per-tenant and personal keys). The worker's AEP_CHAT_MODEL is the default
// for tenants that chose none, and the worker ignores a stored choice that is no longer listed.
export const CHAT_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export const isChatModel = (value: string): value is ChatModel =>
  (CHAT_MODELS as readonly string[]).includes(value);
