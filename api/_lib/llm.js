// Per-model request settings for a low-latency spoken answer.
// Claude Sonnet 5.5: thinking "between_tools" (no extended thinking) at low effort — measured ~0.8 s to first word.
// Claude Opus 5.5 / Opus 5: thinking cannot be disabled, so low effort keeps it short.
// Server-side refusal fallback ("default" routing) is enabled where the Claude API supports it.
export function modelParams(model) {
  const m = String(model || "");
  if (m.startsWith("claude-sonnet-5-5")) {
    return { thinking: { type: "between_tools" }, output_config: { effort: "low" }, fallback: true };
  }
  if (m.startsWith("claude-opus-5") || m.startsWith("claude-fable-5")) {
    return { output_config: { effort: "low" }, fallback: true };
  }
  if (m.startsWith("claude-haiku")) return {};
  return { output_config: { effort: "low" } };
}
