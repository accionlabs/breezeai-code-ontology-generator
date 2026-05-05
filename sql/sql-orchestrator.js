/**
 * SQL/DDL repository orchestrator.
 *
 * Mirrors `autoDetectAndProcess` in main.js but only for .sql files. Streams DDL
 * records to `<repo>-sql-analysis.ndjson.gz` and prepends a `sqlMetaData` summary.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { analyzeSQLRepo } = require('./file-tree-mapper-sql');
const { readSource } = require('../utils');

function countLinesOfCode(filePath) {
  try {
    const content = readSource(filePath);
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function processSqlRepo(repoPath, outputDir) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Breeze Code Ontology Generator - SQL/DDL Mode           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n📂 Repository: ${repoPath}`);
  console.log(`📁 Output directory: ${outputDir}`);

  const ndjsonPath = path.join(
    outputDir,
    `${path.basename(repoPath)}-sql-analysis.ndjson`,
  );
  if (fs.existsSync(ndjsonPath)) fs.unlinkSync(ndjsonPath);

  const ndjsonFd = fs.openSync(ndjsonPath, 'a');

  let totalFiles = 0;
  let totalLinesOfCode = 0;
  let totalTables = 0;
  let totalViews = 0;
  let totalProcedures = 0;
  let totalIndexes = 0;
  let totalSequences = 0;
  const dialectCounts = {};

  const onResult = (record) => {
    const filePath = path.join(repoPath, record.path);
    const loc = countLinesOfCode(filePath);
    record.loc = loc;
    totalLinesOfCode += loc;

    fs.writeSync(ndjsonFd, JSON.stringify(record) + '\n');
    totalFiles++;
    totalTables += (record.tables || []).length;
    totalViews += (record.views || []).length;
    totalProcedures += (record.procedures || []).length;
    totalIndexes += (record.indexes || []).length;
    totalSequences += (record.sequences || []).length;
    if (record.dialect) {
      dialectCounts[record.dialect] = (dialectCounts[record.dialect] || 0) + 1;
    }
  };

  try {
    await Promise.resolve(analyzeSQLRepo(repoPath, { onResult }));
  } catch (err) {
    fs.closeSync(ndjsonFd);
    console.error('\n❌ SQL analysis failed:', err.message);
    return { success: false, error: err.message };
  }

  fs.closeSync(ndjsonFd);

  if (totalFiles === 0) {
    fs.unlinkSync(ndjsonPath);
    console.log('\n⚠️  No SQL files produced any DDL records.');
    return { success: true, totalFiles: 0 };
  }

  const sqlMetaData = {
    __type: 'sqlMetaData',
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
    totalFiles,
    totalLinesOfCode,
    totalTables,
    totalViews,
    totalProcedures,
    totalIndexes,
    totalSequences,
    dialects: dialectCounts,
    generatedAt: new Date().toISOString(),
    toolVersion: '1.0.0',
  };

  console.log(`\n✅ SQL processing complete!`);
  console.log(`   - Total SQL files: ${totalFiles}`);
  console.log(`   - Tables: ${totalTables}`);
  console.log(`   - Views: ${totalViews}`);
  console.log(`   - Procedures: ${totalProcedures}`);
  console.log(`   - Indexes: ${totalIndexes}`);
  console.log(`   - Sequences: ${totalSequences}`);
  console.log(`   - Dialects: ${Object.entries(dialectCounts)
    .map(([d, c]) => `${d}=${c}`)
    .join(', ') || 'none'}`);

  // Prepend metadata
  const tmpPath = ndjsonPath + '.tmp';
  const metaLine = JSON.stringify(sqlMetaData) + '\n';
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpPath);
    ws.write(metaLine);
    const rs = fs.createReadStream(ndjsonPath);
    rs.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    rs.on('error', reject);
  });
  fs.renameSync(tmpPath, ndjsonPath);

  // Gzip
  const gzipPath = ndjsonPath + '.gz';
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(ndjsonPath);
    const gzip = zlib.createGzip();
    const output = fs.createWriteStream(gzipPath);
    input.pipe(gzip).pipe(output);
    output.on('finish', resolve);
    output.on('error', reject);
  });

  fs.unlinkSync(ndjsonPath);
  console.log(`\n📦 Compressed NDJSON output: ${gzipPath}`);

  return { success: true, outputPath: gzipPath, totalFiles };
}

module.exports = { processSqlRepo };
