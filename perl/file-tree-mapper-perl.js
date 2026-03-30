#!/usr/bin/env node
/**
 * Perl Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-mapper-perl.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzePerlRepo } = require('./file-tree-mapper-perl'); const data = analyzePerlRepo(repoPath);
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { getIgnorePatternsWithPrefix } = require("../ignore-patterns");

let parser = null;
let Perl = null;

async function initParser() {
  if (!parser) {
    const Parser = require("tree-sitter");
    Perl = await import("tree-sitter-perl");
    parser = new Parser();
    parser.setLanguage(Perl.default);
  }
  return parser;
}

async function buildPackageMapper(repoPath, perlFiles) {
  await initParser();
  const mapper = {};

  for (const file of perlFiles) {
    try {
      const code = fs.readFileSync(file, "utf8").replace(/\0/g, "");
      if (!code?.trim()) continue;

      const tree = parser.parse(code);
      traverse(tree.rootNode, (node) => {
        if (node.type === "package_statement") {
          const pkgNode =
            node.childForFieldName("namespace") ||
            node.namedChildren.find((n) => n.type === "package_name") ||
            node.namedChildren.find((n) => n.type === "identifier");
          if (pkgNode) {
            const pkgName = code
              .slice(pkgNode.startIndex, pkgNode.endIndex)
              .trim();
            if (pkgName && !pkgName.startsWith("version")) {
              mapper[pkgName] = path.relative(repoPath, file);
            }
          }
        }
      });
    } catch (err) {
      // Skip files that fail to parse
    }
  }

  return mapper;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), cb);
  }
}

// -------------------------------------------------------------
// Get Perl files
// -------------------------------------------------------------
function getPerlFiles(repoPath, ignorePatterns = null) {
  const patterns =
    ignorePatterns ||
    getIgnorePatternsWithPrefix(repoPath, { language: "perl" });
  return glob.sync(`${repoPath}/**/*.{pm,pl}`, {
    ignore: patterns,
  });
}

// -------------------------------------------------------------
// Resolve Perl import paths
// -------------------------------------------------------------
function resolveImportPath(importSource, currentFilePath, repoPath) {
  if (!importSource) return null;

  if (importSource.startsWith(".")) {
    return null;
  }

  const currentDir = path.dirname(currentFilePath);
  const modulePath = importSource.replace(/::/g, "/");

  const possiblePaths = [
    path.resolve(currentDir, modulePath + ".pm"),
    path.resolve(currentDir, modulePath, "__init__.pm"),
    path.resolve(repoPath, "lib", modulePath + ".pm"),
    path.resolve(repoPath, "lib", modulePath, "__init__.pm"),
  ];

  for (const resolvedPath of possiblePaths) {
    if (fs.existsSync(resolvedPath)) {
      return path.relative(repoPath, resolvedPath);
    }
  }

  return null;
}

// -------------------------------------------------------------
// Analyze files with functions and packages
// -------------------------------------------------------------
async function analyzeFiles(repoPath, opts = {}) {
  const perlFiles = getPerlFiles(repoPath);
  const results = opts.onResult ? null : [];
  const totalFiles = perlFiles.length;

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  const {
    extractFunctionsAndCalls,
    extractImports,
    extractFileStatements,
    initParser: initExtParser,
  } = require("./extract-functions-perl");
  const {
    extractPackages,
    initParser: initClassParser,
  } = require("./extract-classes-perl");

  await Promise.all([initExtParser(), initClassParser()]);

  const packageMapper = await buildPackageMapper(repoPath, perlFiles);

  for (let i = 0; i < perlFiles.length; i++) {
    const file = perlFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(
        `\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, " ")}`,
      );
      spinnerIndex++;

      const imports = await extractImports(file);
      const importFiles = [];
      const externalImports = [];
      const libPaths = [];

      imports.forEach((imp) => {
        if (imp.isLib) {
          libPaths.push(imp.source);
        } else if (imp.source) {
          if (packageMapper[imp.source]) {
            importFiles.push(packageMapper[imp.source]);
          } else {
            const resolved = resolveImportPath(imp.source, file, repoPath);
            if (resolved) {
              importFiles.push(resolved);
            } else {
              externalImports.push(imp.source);
            }
          }
        }
      });

      const functions = await extractFunctionsAndCalls(
        file,
        repoPath,
        packageMapper,
        opts.captureSourceCode,
        opts.captureStatements,
      );
      const packages = await extractPackages(
        file,
        repoPath,
        opts.captureStatements,
      );
      const statements = opts.captureStatements
        ? await extractFileStatements(file)
        : [];

      const fileResult = {
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        libPaths: [...new Set(libPaths)],
        functions,
        classes: packages,
        statements,
      };

      if (opts.onResult) {
        opts.onResult(fileResult);
      } else {
        results.push(fileResult);
      }
    } catch (e) {
      process.stdout.write("\n");
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write("\r" + " ".repeat(150) + "\r");
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results || [];
}

// -------------------------------------------------------------
// Main export function - to be called from main.js
// -------------------------------------------------------------
async function analyzePerlRepo(repoPath, opts = {}) {
  console.log(`📂 Scanning Perl repo: ${repoPath}`);

  const analysis = await analyzeFiles(repoPath, opts);

  if (!opts.onResult) {
    console.log(`\n📊 Summary:`);
    console.log(`   Perl files: ${analysis.length}`);
  }

  return analysis;
}

// Export the main function
module.exports = { analyzePerlRepo };

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node perl/file-tree-mapper-perl.js <repoPath> <importsOutput.json>",
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);
  const captureSourceCode = process.argv.includes("--capture-source-code");
  const captureStatements = process.argv.includes("--capture-statements");

  analyzePerlRepo(repoPath, { captureSourceCode, captureStatements })
    .then((results) => {
      fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
      console.log(`✅ Final output written → ${importsOutput}`);
    })
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
