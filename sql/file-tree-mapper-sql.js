/**
 * SQL/DDL File Analyzer
 * Discovers .sql files in a repository and parses Oracle DDL into structured schema records.
 *
 * Module Usage:
 *   const { analyzeSQLRepo } = require('./sql/file-tree-mapper-sql');
 *   analyzeSQLRepo(repoPath, { onResult });
 *
 * Each result is an ndjson record with __type: "ddl" containing parsed tables, views,
 * procedures, and indexes from the .sql file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { getIgnorePatternsWithPrefix } = require('../ignore-patterns');
const { parseDDL } = require('./extract-ddl');

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Get all .sql files in the repo, respecting ignore patterns.
 */
function getSqlFiles(repoPath) {
  const ignorePatterns = getIgnorePatternsWithPrefix(repoPath, { language: 'sql' });
  return glob.sync(`${repoPath}/**/*.sql`, { ignore: ignorePatterns, nodir: true });
}

/**
 * Analyze all .sql files in a repository and emit DDL records via onResult.
 *
 * @param {string} repoPath - Absolute path to the repository root
 * @param {object} opts
 * @param {function} [opts.onResult] - Streaming callback; called once per .sql file
 * @returns {Array|null} - Array of records if no onResult, else null
 */
function analyzeSQLRepo(repoPath, opts = {}) {
  const sqlFiles = getSqlFiles(repoPath);
  const totalFiles = sqlFiles.length;

  if (totalFiles === 0) {
    console.log('   No .sql files found.');
    return opts.onResult ? null : [];
  }

  console.log(`\n📊 Total SQL files to process: ${totalFiles}\n`);

  const results = opts.onResult ? null : [];
  let spinnerIndex = 0;

  for (let i = 0; i < sqlFiles.length; i++) {
    const filePath = sqlFiles[i];
    const relPath = path.relative(repoPath, filePath);

    const percentage = ((i / totalFiles) * 100).toFixed(1);
    const spinner = spinnerFrames[spinnerIndex++ % spinnerFrames.length];
    process.stdout.write(
      `\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${relPath.substring(0, 60).padEnd(60, ' ')}`
    );

    try {
      const ddlText = fs.readFileSync(filePath, 'utf8');
      const parsed = parseDDL(ddlText, { dialect: opts.dialect, filePath });

      // Only emit a record if there's something meaningful
      const sequences = parsed.sequences || [];
      if (
        parsed.tables.length === 0 &&
        parsed.views.length === 0 &&
        parsed.procedures.length === 0 &&
        parsed.allIndexes.length === 0 &&
        sequences.length === 0
      ) {
        if (ddlText.trim().length > 0) {
          process.stdout.write('\n');
          console.warn(
            `⚠️  ${relPath}: detected dialect=${parsed.dialect} but extracted no DDL objects` +
              (parsed.parseStats ? ` (parsed ${parsed.parseStats.ok}, failed ${parsed.parseStats.failed})` : '') +
              (parsed.parseReport ? ` (parsed ${parsed.parseReport.parsed}/${parsed.parseReport.totalStatements}, skipped ${parsed.parseReport.skipped})` : '')
          );
        }
        continue;
      }

      const record = {
        __type: 'ddl',
        path: relPath,
        language: 'sql',
        dialect: parsed.dialect,
        tables: parsed.tables,
        views: parsed.views,
        procedures: parsed.procedures,
        indexes: parsed.allIndexes,
        sequences,
      };
      if (parsed.parseReport) record.parseReport = parsed.parseReport;

      if (opts.onResult) {
        opts.onResult(record);
      } else {
        results.push(record);
      }
    } catch (err) {
      console.error(`\n⚠️  Error parsing ${relPath}: ${err.message}`);
    }
  }

  process.stdout.write('\n');
  return opts.onResult ? null : results;
}

module.exports = { analyzeSQLRepo };
