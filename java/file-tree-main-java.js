#!/usr/bin/env node
/**
 * Java Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-main-java.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzeJavaRepo } = require('./file-tree-main-java'); const data = await analyzeJavaRepo(repoPath);
 */

const { Worker } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const glob = require("glob");
const os = require("os");
const { getIgnorePatterns, getIgnorePatternsWithPrefix } = require("../ignore-patterns");

// ---------- class index ----------
function buildJavaClassIndex(repoPath) {
  const index = {};
  const ignorePatterns = getIgnorePatterns(repoPath);

  const files = glob.sync("**/*.java", {
    cwd: repoPath,
    ignore: ignorePatterns
  });

  for (const file of files) {
    const fqcn = file
      .replace(/\\/g, "/")
      .replace(/^.*?src\/[^/]+\/java\//, "")
      .replace(".java", "")
      .replace(/\//g, ".");

    index[fqcn] = file;
  }

  return index;
}

// -------------------------------------------------------------
// Main export function - to be called from main.js
// -------------------------------------------------------------
function analyzeJavaRepo(repoPath, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`📂 Scanning Java repo: ${repoPath}`);
    const ignorePatterns = getIgnorePatternsWithPrefix(repoPath);

    const javaFiles = glob.sync(`${repoPath}/**/*.java`, {
      ignore: ignorePatterns
    });

    const classIndex = buildJavaClassIndex(repoPath);

    const cpuCount = Math.max(1, os.cpus().length - 1);
    const chunkSize = Math.ceil(javaFiles.length / cpuCount);

    const results = [];
    let done = 0;
    const totalChunks = Math.ceil(javaFiles.length / chunkSize);

    if (javaFiles.length === 0) {
      console.log(`\n📊 Summary:`);
      console.log(`   Java files: 0`);
      resolve([]);
      return;
    }

    for (let i = 0; i < javaFiles.length; i += chunkSize) {
      const chunk = javaFiles.slice(i, i + chunkSize);

      const worker = new Worker(
        path.join(__dirname, "worker.js"),
        {
          workerData: {
            repoPath,
            files: chunk,
            classIndex,
            captureSourceCode: !!opts.captureSourceCode
          }
        }
      );

      worker.on("message", data => {
        if (opts.onResult) {
          data.forEach(item => opts.onResult(item));
        } else {
          results.push(...data);
        }
        done++;
        if (done === totalChunks) {
          if (!opts.onResult) {
            console.log(`\n📊 Summary:`);
            console.log(`   Java files: ${results.length}`);
          }
          resolve(opts.onResult ? [] : results);
        }
      });

      worker.on("error", err => reject(err));
    }
  });
}

// Export the main function
module.exports = { analyzeJavaRepo };

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node java/file-tree-main-java.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const outputPath = path.resolve(process.argv[3]);
  const captureSourceCode = process.argv.includes("--capture-source-code");

  analyzeJavaRepo(repoPath, { captureSourceCode })
    .then(results => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
      console.log("✅ Java analysis written to", outputPath);
    })
    .catch(err => {
      console.error("❌ Java analysis failed:", err);
      process.exit(1);
    });
}
