/**
 * SQL dialect auto-detection.
 *
 * Scores a DDL text against signatures for each supported dialect and returns
 * the highest-scoring one. Falls back to 'postgresql' (most permissive in
 * node-sql-parser) when no signal is found.
 *
 * Supported dialect ids match node-sql-parser's `database` option:
 *   oracle | postgresql | mysql | mariadb | transactsql | sqlite | bigquery | snowflake
 */

'use strict';

const path = require('path');

// Each entry: { id, patterns: [[regex, weight], ...] }
const SIGNATURES = [
  {
    id: 'oracle',
    patterns: [
      [/\bVARCHAR2\s*\(/i, 5],
      [/\bNUMBER\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\)/i, 3],
      [/\bNVARCHAR2\s*\(/i, 4],
      [/\bSYSDATE\b/i, 2],
      [/\bDUAL\b/i, 2],
      [/\bTABLESPACE\s+\w+/i, 2],
      [/\bSTORAGE\s*\(/i, 2],
      [/\bPLS_INTEGER\b/i, 4],
      [/\bBEGIN\b[\s\S]+?\bEND\s*;[\s\S]*?^\s*\/\s*$/im, 4],
      [/\bENABLE\s+VALIDATE\b/i, 3],
      [/\bGLOBAL\s+TEMPORARY\s+TABLE\b/i, 3],
      [/\bBITMAP\s+INDEX\b/i, 3],
      [/\bCREATE\s+OR\s+REPLACE\s+(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b/i, 3],
    ],
  },
  {
    id: 'postgresql',
    patterns: [
      [/\bpg_catalog\b/i, 5],
      [/\bbytea\b/i, 4],
      [/\b(?:big)?serial\b/i, 4],
      [/::\s*[a-z_][a-z0-9_]*/i, 2],
      [/\bRETURNING\b/i, 2],
      [/\bOWNER\s+TO\b/i, 3],
      [/\bCREATE\s+EXTENSION\b/i, 4],
      [/\$\$[\s\S]*?\$\$/, 4],
      [/\bLANGUAGE\s+plpgsql\b/i, 5],
      [/\bWITH\s+TIME\s+ZONE\b/i, 1],
      [/\bpgAdmin\b/i, 3],
      [/\bCOLLATE\s+pg_catalog/i, 5],
    ],
  },
  {
    id: 'mysql',
    patterns: [
      [/`[^`]+`/, 3],
      [/\bAUTO_INCREMENT\b/i, 5],
      [/\bENGINE\s*=\s*\w+/i, 5],
      [/\bDEFAULT\s+CHARSET\s*=/i, 4],
      [/\bUNSIGNED\b/i, 3],
      [/\bTINYINT\b/i, 3],
      [/\bMEDIUMINT\b/i, 3],
      [/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i, 3],
      [/\bCOLLATE\s+utf8/i, 3],
    ],
  },
  {
    id: 'transactsql',
    patterns: [
      [/\[[A-Za-z_][A-Za-z0-9_]*\]\.\[/i, 4],
      [/\bNVARCHAR\s*\(\s*MAX\s*\)/i, 5],
      [/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, 5],
      [/^\s*GO\s*$/im, 3],
      [/\bdbo\./i, 3],
      [/\bDATETIME2\b/i, 3],
      [/\bUNIQUEIDENTIFIER\b/i, 3],
    ],
  },
  {
    id: 'sqlite',
    patterns: [
      [/\bAUTOINCREMENT\b/i, 5], // one word; MySQL is AUTO_INCREMENT
      [/\bWITHOUT\s+ROWID\b/i, 5],
      [/\bPRAGMA\b/i, 4],
    ],
  },
];

// Filename hints, e.g. schema.pg.sql, dump.mysql.sql
const FILENAME_HINTS = {
  pg: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  oracle: 'oracle',
  ora: 'oracle',
  mssql: 'transactsql',
  tsql: 'transactsql',
  sqlserver: 'transactsql',
  sqlite: 'sqlite',
};

/**
 * Look at the filename for an explicit dialect hint like `foo.pg.sql`.
 * Returns null if no hint is present.
 */
function detectFromFilename(filePath) {
  if (!filePath) return null;
  const base = path.basename(filePath).toLowerCase();
  // strip .sql
  const stem = base.endsWith('.sql') ? base.slice(0, -4) : base;
  const parts = stem.split('.');
  for (const p of parts) {
    if (FILENAME_HINTS[p]) return FILENAME_HINTS[p];
  }
  return null;
}

/**
 * Score the text against every dialect signature and return the winner.
 *
 * @param {string} text - SQL DDL content
 * @param {object} [opts]
 * @param {string} [opts.filePath] - Path to the file (for filename hint)
 * @param {string} [opts.fallback] - Fallback dialect if scores are all 0 (default 'postgresql')
 * @returns {{dialect: string, scores: Record<string, number>, source: 'filename'|'content'|'fallback'}}
 */
function detectDialect(text, opts = {}) {
  const fromName = detectFromFilename(opts.filePath);
  if (fromName) {
    return { dialect: fromName, scores: {}, source: 'filename' };
  }

  const scores = {};
  for (const sig of SIGNATURES) {
    let score = 0;
    for (const [re, weight] of sig.patterns) {
      if (re.test(text)) score += weight;
    }
    scores[sig.id] = score;
  }

  let best = null;
  let bestScore = 0;
  for (const [id, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }

  if (!best) {
    return {
      dialect: opts.fallback || 'postgresql',
      scores,
      source: 'fallback',
    };
  }
  return { dialect: best, scores, source: 'content' };
}

module.exports = { detectDialect, detectFromFilename };
