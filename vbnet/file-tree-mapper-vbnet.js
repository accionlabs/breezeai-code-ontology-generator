#!/usr/bin/env node
/**
 * VB.NET Import Analyzer
 * Analyzes VB.NET files (.vb) and extracts imports, classes, and functions
 * Usage: node file-tree-mapper-vbnet.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-vbnet");
const { extractClasses } = require("./extract-classes-vbnet");

// -------------------------------------------------------------
// Get VB.NET files
// -------------------------------------------------------------
function getVBNetFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.vb`, {
    ignore: [
      `${repoPath}/**/bin/**`,
      `${repoPath}/**/obj/**`,
      `${repoPath}/**/.vs/**`,
      `${repoPath}/**/packages/**`,
      `${repoPath}/**/My Project/**`,         // VB.NET auto-generated files
      `${repoPath}/**/*.Designer.vb`,          // Designer files
      `${repoPath}/**/*.g.vb`,                 // Generated files
      `${repoPath}/**/Reference.vb`,           // Service references
      `${repoPath}/**/AssemblyInfo.vb`         // Assembly info
    ]
  });
}

// -------------------------------------------------------------
// Build comprehensive class index
// Maps: className -> file, namespace.className -> file, methodName -> [files]
// Case-insensitive for VB.NET
// -------------------------------------------------------------
function buildClassIndex(files, repoPath) {
  const classIndex = {};      // className -> [file paths]
  const fqcnIndex = {};       // Namespace.ClassName -> [file paths]
  const methodIndex = {};     // methodName -> [{ className, filePath }]

  files.forEach(file => {
    try {
      const source = fs.readFileSync(file, "utf8");
      const lines = source.split(/\r?\n/);
      const relativePath = path.relative(repoPath, file);

      let currentNamespace = "";
      let currentClassName = "";
      let inClass = false;

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip comments
        if (trimmedLine.startsWith("'")) continue;

        // Track namespace
        const namespaceMatch = trimmedLine.match(/^Namespace\s+(.+)/i);
        if (namespaceMatch) {
          currentNamespace = namespaceMatch[1].trim();
          continue;
        }

        // Track End Namespace
        if (trimmedLine.match(/^End\s+Namespace/i)) {
          currentNamespace = "";
          continue;
        }

        // Track Class/Module/Structure/Interface
        const classMatch = trimmedLine.match(
          /^(?:Partial\s+)?(?:Public|Private|Protected|Friend|Protected\s+Friend)?\s*(?:MustInherit|NotInheritable)?\s*(Class|Module|Structure|Interface)\s+(\w+)/i
        );

        if (classMatch) {
          currentClassName = classMatch[2];
          inClass = true;
          const fqcn = currentNamespace ? `${currentNamespace}.${currentClassName}` : currentClassName;

          // Map class name to file (case-insensitive key)
          const classKey = currentClassName.toLowerCase();
          if (!classIndex[classKey]) {
            classIndex[classKey] = [];
          }
          classIndex[classKey].push(relativePath);

          // Map FQCN to file
          const fqcnKey = fqcn.toLowerCase();
          if (!fqcnIndex[fqcnKey]) {
            fqcnIndex[fqcnKey] = [];
          }
          fqcnIndex[fqcnKey].push(relativePath);
          continue;
        }

        // Track End Class/Module/Structure/Interface
        if (trimmedLine.match(/^End\s+(Class|Module|Structure|Interface)/i)) {
          inClass = false;
          currentClassName = "";
          continue;
        }

        // Track methods inside classes
        if (inClass) {
          // Match Sub declarations
          const subMatch = trimmedLine.match(
            /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|Overloads|Shadows)?\s*Sub\s+(\w+)/i
          );
          if (subMatch && subMatch[1].toLowerCase() !== "new") {
            const methodName = subMatch[1].toLowerCase();
            if (!methodIndex[methodName]) {
              methodIndex[methodName] = [];
            }
            methodIndex[methodName].push({
              className: currentClassName,
              filePath: relativePath
            });
          }

          // Match Function declarations
          const funcMatch = trimmedLine.match(
            /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|Overloads|Shadows)?\s*Function\s+(\w+)/i
          );
          if (funcMatch) {
            const methodName = funcMatch[1].toLowerCase();
            if (!methodIndex[methodName]) {
              methodIndex[methodName] = [];
            }
            methodIndex[methodName].push({
              className: currentClassName,
              filePath: relativePath
            });
          }

          // Match Property declarations
          const propMatch = trimmedLine.match(
            /^(?:Public|Private|Protected|Friend|Overridable|MustOverride|Overrides|Shared|ReadOnly|WriteOnly)?\s*Property\s+(\w+)/i
          );
          if (propMatch) {
            const methodName = propMatch[1].toLowerCase();
            if (!methodIndex[methodName]) {
              methodIndex[methodName] = [];
            }
            methodIndex[methodName].push({
              className: currentClassName,
              filePath: relativePath
            });
          }
        }
      }
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex };
}

// -------------------------------------------------------------
// Resolve Imports directive to local file or external package
// -------------------------------------------------------------
function resolveImportsDirective(importNamespace, fqcnIndex, classIndex) {
  const importLower = importNamespace.toLowerCase();

  // Check if it's a direct FQCN match
  if (fqcnIndex[importLower]) {
    return {
      type: "local",
      files: fqcnIndex[importLower]
    };
  }

  // Check if it's a partial match
  const matchingFiles = [];
  Object.entries(fqcnIndex).forEach(([fqcn, files]) => {
    if (fqcn.startsWith(importLower + ".") || fqcn === importLower) {
      matchingFiles.push(...files);
    }
  });

  if (matchingFiles.length > 0) {
    return {
      type: "local",
      files: [...new Set(matchingFiles)]
    };
  }

  return {
    type: "external",
    namespace: importNamespace
  };
}

// -------------------------------------------------------------
// Check if namespace is .NET Framework/Standard library
// -------------------------------------------------------------
function isVBNetStdLib(namespace) {
  const externalPrefixes = [
    "System",
    "Microsoft",
    "Windows",
    "Newtonsoft",
    "NUnit",
    "Xunit",
    "Moq",
    "AutoMapper",
    "Dapper",
    "EntityFramework",
    "NLog",
    "Serilog",
    "FluentValidation"
  ];

  const lower = namespace.toLowerCase();
  return externalPrefixes.some(prefix =>
    lower.startsWith(prefix.toLowerCase() + ".") || lower === prefix.toLowerCase()
  );
}

// -------------------------------------------------------------
// Analyze VB.NET files
// -------------------------------------------------------------
function analyzeVBNetRepo(repoPath, opts = {}) {
  const vbFiles = getVBNetFiles(repoPath);
  const totalFiles = vbFiles.length;

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex } = buildClassIndex(vbFiles, repoPath);
  console.log(`✅ Found ${Object.keys(classIndex).length} types and ${Object.keys(methodIndex).length} methods across ${totalFiles} files\n`);

  const results = [];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`📊 VB.NET files to process: ${totalFiles}\n`);

  for (let i = 0; i < vbFiles.length; i++) {
    const file = vbFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const source = fs.readFileSync(file, "utf8");
      const lines = source.split(/\r?\n/);

      const importFiles = [];
      const externalImports = [];

      // Extract Imports statements
      for (const line of lines) {
        const trimmedLine = line.trim();

        // Match Imports statements
        const importMatch = trimmedLine.match(/^Imports\s+(?:\w+\s*=\s*)?(.+)/i);
        if (importMatch) {
          const importNamespace = importMatch[1].trim();

          if (isVBNetStdLib(importNamespace)) {
            externalImports.push(importNamespace);
          } else {
            const resolved = resolveImportsDirective(importNamespace, fqcnIndex, classIndex);
            if (resolved.type === "local") {
              const currentFile = path.relative(repoPath, file);
              resolved.files.forEach(f => {
                if (f !== currentFile) {
                  importFiles.push(f);
                }
              });
            } else {
              externalImports.push(importNamespace);
            }
          }
        }
      }

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath, {
        classIndex,
        methodIndex
      }, opts.captureSourceCode);
      const classes = extractClasses(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes
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
