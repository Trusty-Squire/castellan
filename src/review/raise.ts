/**
 * Spec-delta helpers for the rebuild/outer loops. The domain-keyed "delta committee"
 * (reviewOuterDeltaCandidate/Batch, planOuterDelta) and its tarot/zodiac/casino/arb
 * keyword regexes were deleted — they were overfit to the demo corpus, recognizing
 * our test products instead of generalizing. The rebuild loop now folds the visual
 * review's blocking fixes directly (no keyword filter), so all that survives here is
 * the one general, domain-agnostic guard the refold uses.
 */

/** A coverage-only delta ("add a test for X") raises no product floor — the rebuild
 *  loop drops it so a blocking-fix refold doesn't degrade into test-padding. */
const TEST_ONLY = /\b(add|write|create).{0,96}\b(coverage|test|tests|spec|assertion)\b/i;
export function isTestOnlyDelta(text: string): boolean {
  return TEST_ONLY.test(text);
}
