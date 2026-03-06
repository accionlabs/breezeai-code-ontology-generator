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

// -----------------------------------------------------------
// Source cache: avoids reading + parsing the same file multiple
// times when extractImports, extractFunctions, and extractClasses
// are called sequentially for the same file.
// -----------------------------------------------------------
const fs = require("fs");

let _cachedPath = null;
let _cachedSource = null;
let _cachedTree = null;

/**
 * Read file contents with single-entry cache.
 * Consecutive calls for the same filePath return the cached string.
 */
function readSource(filePath) {
  if (_cachedPath === filePath && _cachedSource !== null) return _cachedSource;
  _cachedPath = filePath;
  _cachedSource = fs.readFileSync(filePath, "utf8");
  _cachedTree = null; // invalidate tree when file changes
  return _cachedSource;
}

/**
 * Parse file with tree-sitter, caching both source and tree.
 * If the same filePath was already parsed (by any parser using the
 * same grammar), the cached tree is returned directly.
 */
function parseSource(filePath, parser) {
  const source = readSource(filePath);
  if (_cachedTree) return { source, tree: _cachedTree };
  _cachedTree = parser.parse(source);
  return { source, tree: _cachedTree };
}

module.exports = { truncateSourceCode, readSource, parseSource };
