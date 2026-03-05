#!/usr/bin/env node
/**
 * VB.NET Import Analyzer
 * Analyzes VB.NET files (.vb) and extracts imports, classes, and functions
 * Usage: node file-tree-mapper-vbnet.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const VBNet = require("tree-sitter-vb-dotnet");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-vbnet");
const { extractClasses } = require("./extract-classes-vbnet");

// -------------------------------------------------------------
// Get VB.NET files
// -------------------------------------------------------------
function getVBNetFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.vb`, {
    ignore: [
      `${repoPath}/**/bin/**`,              // Build output
      `${repoPath}/**/obj/**`,              // Intermediate files
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/.vs/**`,              // Visual Studio cache
      `${repoPath}/**/packages/**`,         // NuGet packages
      `${repoPath}/**/.git/**`,
      `${repoPath}/**/My Project/**`,       // Auto-generated files
      `${repoPath}/**/Reference.vb`,        // Service references
      `${repoPath}/**/*.designer.vb`,       // Designer files
      `${repoPath}/**/AssemblyInfo.vb`      // Assembly info
    ]
  });
}

// -------------------------------------------------------------
// Build comprehensive class index
// Maps: className -> file, FQCN -> file, methodName -> [files]
// -------------------------------------------------------------
function buildClassIndex(files, repoPath) {
  const classIndex = {};      // className -> [file paths]
  const fqcnIndex = {};       // Namespace.ClassName -> [file paths]
  const methodIndex = {};     // methodName -> [{ className, filePath }]
  const functionIndex = {};   // functionName -> [file paths]

  const parser = new Parser();
  parser.setLanguage(VBNet);

  files.forEach(file => {
    try {
      const source = fs.readFileSync(file, "utf8");
      const tree = parser.parse(source);
      const relativePath = path.relative(repoPath, file);

      let currentNamespace = "";

      traverse(tree.rootNode, (node) => {
        // Track namespace
        if (node.type === "namespace_statement") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            currentNamespace = source.slice(nameNode.startIndex, nameNode.endIndex);
          } else {
            // Try to find identifier or qualified_name
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child.type === "identifier" || child.type === "qualified_name") {
                currentNamespace = source.slice(child.startIndex, child.endIndex);
                break;
              }
            }
          }
        }

        // Extract class/interface/structure/module/enum names and their methods
        if (
          node.type === "class_statement" ||
          node.type === "interface_statement" ||
          node.type === "structure_statement" ||
          node.type === "module_statement" ||
          node.type === "enum_statement"
        ) {
          let className = null;
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            className = source.slice(nameNode.startIndex, nameNode.endIndex);
          } else {
            // Try to find identifier child
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child.type === "identifier") {
                className = source.slice(child.startIndex, child.endIndex);
                break;
              }
            }
          }

          if (className) {
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

            // Extract methods from this class/interface/structure/module
            extractMethodsFromNode(node, source, className, relativePath, methodIndex);
          }
        }

        // Extract standalone functions (Module-level)
        if (node.type === "function_statement" || node.type === "sub_statement") {
          // Make sure it's inside a module but not nested in a class
          let isModuleLevel = false;
          let parent = node.parent;
          while (parent) {
            if (parent.type === "module_statement") {
              isModuleLevel = true;
              break;
            }
            if (
              parent.type === "class_statement" ||
              parent.type === "structure_statement"
            ) {
              isModuleLevel = false;
              break;
            }
            parent = parent.parent;
          }

          if (isModuleLevel) {
            let funcName = null;
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
              funcName = source.slice(nameNode.startIndex, nameNode.endIndex);
            } else {
              for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child.type === "identifier") {
                  funcName = source.slice(child.startIndex, child.endIndex);
                  break;
                }
              }
            }

            if (funcName) {
              if (!functionIndex[funcName]) {
                functionIndex[funcName] = [];
              }
              functionIndex[funcName].push(relativePath);

              // Also add to methodIndex for resolution
              if (!methodIndex[funcName]) {
                methodIndex[funcName] = [];
              }
              methodIndex[funcName].push({
                className: null,
                filePath: relativePath
              });
            }
          }
        }
      });
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex, functionIndex };
}

function extractMethodsFromNode(classNode, source, className, filePath, methodIndex) {
  // Find all methods within this type
  traverse(classNode, (member) => {
    if (member === classNode) return;

    // Skip nested types
    if (
      member.type === "class_statement" ||
      member.type === "structure_statement" ||
      member.type === "module_statement"
    ) {
      return;
    }

    if (
      member.type === "function_statement" ||
      member.type === "sub_statement" ||
      member.type === "property_statement"
    ) {
      // Make sure this is a direct child of our class
      let parent = member.parent;
      let isDirectChild = false;
      while (parent) {
        if (parent === classNode) {
          isDirectChild = true;
          break;
        }
        if (
          parent.type === "class_statement" ||
          parent.type === "structure_statement" ||
          parent.type === "module_statement"
        ) {
          break;
        }
        parent = parent.parent;
      }

      if (!isDirectChild) return;

      let methodName = null;
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methodName = source.slice(nameNode.startIndex, nameNode.endIndex);
      } else {
        for (let j = 0; j < member.childCount; j++) {
          const child = member.child(j);
          if (child.type === "identifier") {
            methodName = source.slice(child.startIndex, child.endIndex);
            break;
          }
        }
      }

      if (methodName) {
        if (!methodIndex[methodName]) {
          methodIndex[methodName] = [];
        }
        methodIndex[methodName].push({
          className,
          filePath
        });
      }
    }
  });
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// -------------------------------------------------------------
// Extract variable types from a file
// -------------------------------------------------------------
function extractVariableTypes(tree, source) {
  const varTypes = {};

  traverse(tree.rootNode, (node) => {
    // Variable declarations with As clause
    if (node.type === "variable_declaration" || node.type === "local_declaration_statement") {
      // Look for variable_declarator with as_clause
      traverse(node, (n) => {
        if (n.type === "variable_declarator") {
          let varName = null;
          let typeName = null;

          for (let i = 0; i < n.childCount; i++) {
            const child = n.child(i);
            if (child.type === "identifier") {
              varName = source.slice(child.startIndex, child.endIndex);
            }
            if (child.type === "as_clause") {
              // Get the type from as_clause
              for (let j = 0; j < child.childCount; j++) {
                const typeChild = child.child(j);
                if (typeChild.type === "identifier" || typeChild.type === "qualified_name" || typeChild.type === "predefined_type") {
                  typeName = source.slice(typeChild.startIndex, typeChild.endIndex);
                }
              }
            }
          }

          if (varName && typeName) {
            varTypes[varName] = typeName;
          }
        }
      });
    }

    // Parameters with type hints
    if (node.type === "parameter") {
      let paramName = null;
      let typeName = null;

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "identifier") {
          paramName = source.slice(child.startIndex, child.endIndex);
        }
        if (child.type === "as_clause") {
          for (let j = 0; j < child.childCount; j++) {
            const typeChild = child.child(j);
            if (typeChild.type === "identifier" || typeChild.type === "qualified_name" || typeChild.type === "predefined_type") {
              typeName = source.slice(typeChild.startIndex, typeChild.endIndex);
            }
          }
        }
      }

      if (paramName && typeName) {
        varTypes[paramName] = typeName;
      }
    }
  });

  return varTypes;
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
// Analyze VB.NET files
// -------------------------------------------------------------
function analyzeVBNetRepo(repoPath, opts = {}) {
  const vbnetFiles = getVBNetFiles(repoPath);
  const totalFiles = vbnetFiles.length;

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex, functionIndex } = buildClassIndex(vbnetFiles, repoPath);
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

      const source = fs.readFileSync(file, "utf8");
      const parser = new Parser();
      parser.setLanguage(VBNet);
      const tree = parser.parse(source);

      const importFiles = [];
      const externalImports = [];

      // Extract variable types for this file
      const varTypes = extractVariableTypes(tree, source);

      // Extract imports (Imports statements)
      const imports = extractImports(file);

      // Process Imports statements
      imports.importsStatements.forEach(importStmt => {
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

      // Extract functions and classes with enhanced call resolution
      const functions = extractFunctionsAndCalls(file, repoPath, {
        classIndex,
        fqcnIndex,
        methodIndex,
        varTypes
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
