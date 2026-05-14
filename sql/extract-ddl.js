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
  const fileTag = opts.filePath ? ` [${opts.filePath}]` : '';
  let dialect = opts.dialect;
  let detection = null;

  if (!dialect) {
    detection = detectDialect(ddlText, { filePath: opts.filePath });
    dialect = detection.dialect;
    console.log(`📜 [sql/parseDDL]${fileTag} detected dialect=${dialect} (source=${detection.source || 'auto'})`);
  } else {
    detection = { dialect, scores: {}, source: 'override' };
    console.log(`📜 [sql/parseDDL]${fileTag} using forced dialect=${dialect}`);
  }

  const parserStart = Date.now();
  let parsed;
  if (dialect === 'oracle') {
    parsed = parseOracleDDL(ddlText);
  } else {
    parsed = parseGenericDDL(ddlText, dialect);
  }
  console.log(
    `📜 [sql/parseDDL]${fileTag} ${dialect === 'oracle' ? 'oracle' : 'generic'} parser finished in ${Date.now() - parserStart}ms — ` +
    `tables=${parsed.tables?.length ?? 0}, views=${parsed.views?.length ?? 0}, ` +
    `procedures=${parsed.procedures?.length ?? 0}, indexes=${parsed.allIndexes?.length ?? 0}, ` +
    `sequences=${parsed.sequences?.length ?? 0}`,
  );

  return { dialect, detection, ...parsed };
}

module.exports = { parseDDL };
