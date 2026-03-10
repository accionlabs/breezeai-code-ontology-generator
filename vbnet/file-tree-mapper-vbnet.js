#!/usr/bin/env node
/**
 * VB.NET Import Analyzer
 * Analyzes VB.NET files (.vb) and extracts imports, classes, and functions
 * Uses tree-sitter when available, falls back to regex-based parsing
 * Usage: node file-tree-mapper-vbnet.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { analyzeVBNetFileWithRegex } = require("./regex-parser-vbnet");
const { getIgnorePatternsWithPrefix } = require("../ignore-patterns");

// Try to load tree-sitter, but don't fail if it doesn't work
let Parser, VBNet, treeSitterAvailable = false;
try {
  Parser = require("tree-sitter");
  VBNet = require("tree-sitter-vb-dotnet");
  // Test if tree-sitter actually works
  const testParser = new Parser();
  testParser.setLanguage(VBNet);
  testParser.parse("Public Class Test\nEnd Class");
  treeSitterAvailable = true;
} catch (e) {
  console.log("⚠️  Tree-sitter VB.NET bindings not available, using regex parser fallback");
  treeSitterAvailable = false;
}

// -------------------------------------------------------------
// Get VB.NET files
// -------------------------------------------------------------
function getVBNetFiles(repoPath, ignorePatterns = null) {
  const patterns = ignorePatterns || getIgnorePatternsWithPrefix(repoPath, { language: 'vbnet' });
  return glob.sync(`${repoPath}/**/*.vb`, {
    ignore: patterns,
    nocase: true  // Case-insensitive matching for file patterns
  });
}

// -------------------------------------------------------------
// Build comprehensive class index using regex parser
// Maps: className -> file, FQCN -> file, methodName -> [files]
// -------------------------------------------------------------
function buildClassIndexWithRegex(files, repoPath) {
  const classIndex = {};      // className -> [file paths]
  const fqcnIndex = {};       // Namespace.ClassName -> [file paths]
  const methodIndex = {};     // methodName -> [{ className, filePath }]
  const functionIndex = {};   // functionName -> [file paths]

  files.forEach(file => {
    try {
      const source = fs.readFileSync(file, "utf8");
      const relativePath = path.relative(repoPath, file);

      // Extract namespace
      let currentNamespace = "";
      const namespaceMatch = source.match(/^\s*Namespace\s+(\S+)/mi);
      if (namespaceMatch) {
        currentNamespace = namespaceMatch[1];
      }

      // Use regex parser to extract classes and functions
      const result = analyzeVBNetFileWithRegex(file, repoPath);

      // Index classes
      result.classes.forEach(cls => {
        const className = cls.name;
        const fqcn = currentNamespace ? `${currentNamespace}.${className}` : className;

        // Map class name to file
        if (!classIndex[className]) {
          classIndex[className] = [];
        }
        classIndex[className].push(relativePath);

        // Map FQCN to file
        if (!fqcnIndex[fqcn]) {
          fqcnIndex[fqcn] = [];
        }
        fqcnIndex[fqcn].push(relativePath);

        // Index methods
        cls.methods.forEach(methodName => {
          if (!methodIndex[methodName]) {
            methodIndex[methodName] = [];
          }
          methodIndex[methodName].push({
            className,
            filePath: relativePath
          });
        });
      });

      // Index standalone functions (module-level)
      result.functions.forEach(func => {
        if (!functionIndex[func.name]) {
          functionIndex[func.name] = [];
        }
        functionIndex[func.name].push(relativePath);

        // Also add to methodIndex for resolution
        if (!methodIndex[func.name]) {
          methodIndex[func.name] = [];
        }
        methodIndex[func.name].push({
          className: null,
          filePath: relativePath
        });
      });
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex, functionIndex };
}

// -------------------------------------------------------------
// Check if namespace is .NET standard library or common external
// -------------------------------------------------------------
function isVBNetBuiltinOrExternal(namespace) {
  const normalizedNamespace = namespace.replace(/\//g, ".");
  const topLevel = normalizedNamespace.split(".")[0].toLowerCase();

  // .NET built-in namespaces
  const dotNetBuiltins = [
    "system",
    "microsoft",
    "windows",
    "mscorlib",
    "netstandard"
  ];

  // Common .NET namespaces
  const systemNamespaces = [
    "system.collections",
    "system.collections.generic",
    "system.io",
    "system.linq",
    "system.text",
    "system.threading",
    "system.threading.tasks",
    "system.net",
    "system.net.http",
    "system.data",
    "system.xml",
    "system.web",
    "system.windows",
    "system.diagnostics",
    "system.reflection",
    "system.runtime"
  ];

  // Common external packages (NuGet packages)
  const commonExternal = [
    "newtonsoft",        // Newtonsoft.Json
    "entityframework",   // Entity Framework
    "automapper",        // AutoMapper
    "serilog",           // Serilog logging
    "nlog",              // NLog logging
    "log4net",           // Log4Net logging
    "dapper",            // Dapper ORM
    "npgsql",            // PostgreSQL
    "mysql",             // MySQL
    "moq",               // Mocking
    "xunit",             // Testing
    "nunit",             // Testing
    "fluentvalidation",  // Validation
    "mediatr",           // MediatR
    "polly",             // Resilience
    "restsharp",         // REST client
    "hangfire",          // Background jobs
    "quartz",            // Job scheduling
    "aspnetcore",        // ASP.NET Core
    "identitymodel"      // Identity
  ];

  const normalizedLower = normalizedNamespace.toLowerCase();

  return dotNetBuiltins.includes(topLevel) ||
         systemNamespaces.some(ns => normalizedLower.startsWith(ns)) ||
         commonExternal.includes(topLevel);
}

// -------------------------------------------------------------
// Resolve Imports statement to local file or external namespace
// -------------------------------------------------------------
function resolveImportsStatement(importsNamespace, fqcnIndex, classIndex) {
  // Normalize namespace separators
  const normalizedNamespace = importsNamespace.replace(/\//g, ".");

  // Check if it's a direct FQCN match
  if (fqcnIndex[normalizedNamespace]) {
    return {
      type: "local",
      files: fqcnIndex[normalizedNamespace]
    };
  }

  // Check if it's a partial match (importing a namespace that contains our classes)
  const matchingFiles = [];
  Object.entries(fqcnIndex).forEach(([fqcn, files]) => {
    if (fqcn.startsWith(normalizedNamespace + ".") || fqcn === normalizedNamespace) {
      matchingFiles.push(...files);
    }
  });

  if (matchingFiles.length > 0) {
    return {
      type: "local",
      files: [...new Set(matchingFiles)]
    };
  }

  // Check by class name only (last part of namespace)
  const lastPart = normalizedNamespace.split(".").pop();
  if (classIndex[lastPart]) {
    return {
      type: "local",
      files: classIndex[lastPart]
    };
  }

  return {
    type: "external",
    namespace: normalizedNamespace
  };
}

// -------------------------------------------------------------
// Analyze VB.NET files
// -------------------------------------------------------------
function analyzeVBNetRepo(repoPath, opts = {}) {
  const vbnetFiles = getVBNetFiles(repoPath);
  const totalFiles = vbnetFiles.length;

  if (totalFiles === 0) {
    console.log(`\n⚠️  No VB.NET files found in ${repoPath}`);
    return [];
  }

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex, functionIndex } = buildClassIndexWithRegex(vbnetFiles, repoPath);
  console.log(`✅ Found ${Object.keys(classIndex).length} types and ${Object.keys(methodIndex).length} methods across ${totalFiles} files\n`);

  const results = [];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`📊 VB.NET files to process: ${totalFiles}\n`);

  for (let i = 0; i < vbnetFiles.length; i++) {
    const file = vbnetFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      // Use regex parser (fallback mode)
      const analysis = analyzeVBNetFileWithRegex(file, repoPath, opts.captureSourceCode);

      const importFiles = [];
      const externalImports = [];

      // Process Imports statements
      analysis.imports.importsStatements.forEach(importStmt => {
        const resolved = resolveImportsStatement(importStmt.source, fqcnIndex, classIndex);
        if (resolved.type === "local") {
          const currentFile = path.relative(repoPath, file);
          resolved.files.forEach(f => {
            if (f !== currentFile) {
              importFiles.push(f);
            }
          });
        } else {
          // Check if it's truly external or just unresolved local
          if (isVBNetBuiltinOrExternal(importStmt.source)) {
            externalImports.push(importStmt.source);
          } else {
            // Might be a local namespace that wasn't indexed
            externalImports.push(importStmt.source);
          }
        }
      });

      // Resolve call paths for functions
      const currentFilePath = path.relative(repoPath, file);
      const localFunctionMap = new Map();
      analysis.functions.forEach(func => {
        localFunctionMap.set(func.name, currentFilePath);
      });

      // Resolve calls
      analysis.functions.forEach(func => {
        func.calls.forEach(call => {
          if (localFunctionMap.has(call.name)) {
            call.path = currentFilePath;
          } else if (methodIndex[call.name]) {
            const methodEntries = methodIndex[call.name];
            if (methodEntries.length === 1) {
              call.path = methodEntries[0].filePath;
            } else {
              const otherFileEntry = methodEntries.find(m => m.filePath !== currentFilePath);
              if (otherFileEntry) {
                call.path = otherFileEntry.filePath;
              }
            }
          }
        });
      });

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions: analysis.functions,
        classes: analysis.classes
      });
    } catch (e) {
      process.stdout.write('\n');
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} VB.NET files\n`);

  return results;
}

// -------------------------------------------------------------
// EXPORT FOR MODULE USE
// -------------------------------------------------------------
module.exports = { analyzeVBNetRepo };

// -------------------------------------------------------------
// CLI MODE - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node vbnet/file-tree-mapper-vbnet.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);
  const captureSourceCode = process.argv.includes("--capture-source-code");

  console.log(`📂 Scanning VB.NET repo: ${repoPath}`);

  const results = analyzeVBNetRepo(repoPath, { captureSourceCode });

  console.log(`\n📊 Summary:`);
  console.log(`   Total VB.NET files: ${results.length}\n`);

  // Write results
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Output written → ${importsOutput}`);
}
