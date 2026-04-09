/**
 * Multi-dialect SQL DDL parser dispatcher.
 *
 * Auto-detects the SQL dialect of the file (or honors an explicit hint) and
 * routes to the appropriate parser:
 *   - Oracle  → hand-rolled parser in extract-ddl-oracle.js (richer Oracle support)
 *   - others  → generic node-sql-parser-based extractor in extract-ddl-generic.js
 *
 * Both parsers return the same record shape:
 *   { tables, views, procedures, indexes, allIndexes }
 */

'use strict';

const { parseOracleDDL } = require('./extract-ddl-oracle');
const { parseGenericDDL } = require('./extract-ddl-generic');
const { detectDialect } = require('./detect-dialect');

/**
 * @param {string} ddlText
 * @param {object} [opts]
 * @param {string} [opts.dialect]  - Force a specific dialect, skipping detection
 * @param {string} [opts.filePath] - Optional file path used for filename-hint detection
 * @returns {{dialect, detection, tables, views, procedures, indexes, allIndexes, parseStats?}}
 */
function parseDDL(ddlText, opts = {}) {
  let dialect = opts.dialect;
  let detection = null;

  if (!dialect) {
    detection = detectDialect(ddlText, { filePath: opts.filePath });
    dialect = detection.dialect;
  } else {
    detection = { dialect, scores: {}, source: 'override' };
  }

  let parsed;
  if (dialect === 'oracle') {
    parsed = parseOracleDDL(ddlText);
  } else {
    parsed = parseGenericDDL(ddlText, dialect);
  }

  return { dialect, detection, ...parsed };
}

module.exports = { parseDDL };
