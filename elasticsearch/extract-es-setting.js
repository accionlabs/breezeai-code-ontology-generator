/**
 * Parse an Elasticsearch settings JSON file.
 *
 * Observed shape varies by dump tool:
 *   1. Plain JSON:    { "<indexName>": { "settings": { "index": { ... } } } }
 *   2. JSON-encoded:  "\"{\\\"<indexName>\\\": ...}\""   (a JSON string whose
 *      payload is itself the JSON object above)
 *
 * Only a small subset of settings is captured intentionally:
 *   - number_of_shards
 *   - number_of_replicas
 *   - analysis.analyzer.default (if defined)
 *
 * Operational/perf settings (slowlog thresholds, blocks) are ignored to keep
 * the graph clean — they don't describe schema.
 */

'use strict';

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return { __error: err.message };
  }
}

/**
 * Handle the double-encoding case: outermost parse yields a string,
 * which itself must be parsed as JSON.
 */
function parseSettingsText(rawText, filePath) {
  const trimmed = rawText.trim();
  const first = tryParse(trimmed);
  if (first && first.__error) {
    throw new Error(`[es/setting] failed to parse ${filePath}: ${first.__error}`);
  }
  if (typeof first === 'string') {
    const second = tryParse(first);
    if (second && second.__error) {
      throw new Error(
        `[es/setting] ${filePath}: outer string was JSON-encoded but inner payload failed to parse: ${second.__error}`,
      );
    }
    return second;
  }
  return first;
}

function pickIndexSettings(indexBlock) {
  if (!indexBlock || typeof indexBlock !== 'object') return null;
  const settings = indexBlock.settings && indexBlock.settings.index
    ? indexBlock.settings.index
    : (indexBlock.index || null);
  if (!settings || typeof settings !== 'object') return null;

  const analysis = settings.analysis && settings.analysis.analyzer ? settings.analysis.analyzer : null;
  const defaultAnalyzer = analysis && analysis.default && analysis.default.type ? analysis.default.type : null;

  return {
    shards: settings.number_of_shards || null,
    replicas: settings.number_of_replicas || null,
    defaultAnalyzer,
  };
}

/**
 * @param {string} rawText
 * @param {string} filePath
 * @returns {Map<string, {shards, replicas, defaultAnalyzer}>}
 */
function parseESSettingFile(rawText, filePath) {
  const json = parseSettingsText(rawText, filePath);
  const out = new Map();

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return out;
  }

  for (const [indexName, body] of Object.entries(json)) {
    const picked = pickIndexSettings(body);
    if (picked) out.set(indexName, picked);
  }

  return out;
}

module.exports = { parseESSettingFile, parseSettingsText };
