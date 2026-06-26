// A swappable token counter. The default is a chars/4 heuristic — approximate
// but dependency-free. Swapping to a real tokenizer later means replacing only
// this module; both the ContextBuilder (budgeting) and the messages repository
// (cached token_estimate) consume the same instance so the math stays aligned.
export interface TokenCounter {
  count(text: string): number
}

export const heuristicTokenCounter: TokenCounter = {
  count: (text) => Math.ceil((text?.length ?? 0) / 4),
}

// The default counter used across the app today.
export const defaultTokenCounter = heuristicTokenCounter
