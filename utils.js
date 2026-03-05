/**
 * Shared utilities for Breeze Code Ontology Generator
 */

const MAX_LINES = 200;
const MAX_CHARS = 10000;
const TRUNCATION_MARKER = "// ... [truncated]";

/**
 * Truncate source code to stay within limits.
 * Hard limit: 200 lines or 10,000 characters, whichever hits first.
 * @param {string} rawSource - The raw source code string
 * @returns {string} - Truncated source with marker if exceeded
 */
function truncateSourceCode(rawSource) {
  if (!rawSource) return rawSource;

  let result = rawSource;
  let truncated = false;

  // Check line limit
  const lines = result.split("\n");
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join("\n");
    truncated = true;
  }

  // Check character limit
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS);
    truncated = true;
  }

  if (truncated) {
    result += "\n" + TRUNCATION_MARKER;
  }

  return result;
}

module.exports = { truncateSourceCode };
