#!/usr/bin/env node
/**
 * C# Import Analyzer
 * Analyzes C# files (.cs) and extracts imports, classes, and functions
 * Usage: node file-tree-mapper-csharp.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const CSharp = require("tree-sitter-c-sharp");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-csharp");
const { extractClasses } = require("./extract-classes-csharp");

// -------------------------------------------------------------
// Get C# files
// -------------------------------------------------------------
function getCSharpFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.cs`, {
    ignore: [
      `${repoPath}/**/bin/**`,
      `${repoPath}/**/obj/**`,
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/.vs/**`,
      `${repoPath}/**/packages/**`,
      `${repoPath}/**/TestResults/**`,
      `${repoPath}/**/*.Designer.cs`,
      `${repoPath}/**/*.g.cs`,
      `${repoPath}/**/*.g.i.cs`
    ]
  });
}

// -------------------------------------------------------------
// Build comprehensive class index
// Maps: className -> file, FQCN -> file, methodName -> [files]
// -------------------------------------------------------------
function buildClassIndex(files) {
  const classIndex = {};      // className -> file path
  const fqcnIndex = {};       // Namespace.ClassName -> file path
  const methodIndex = {};     // methodName -> [{ className, filePath }]

  const parser = new Parser();
  parser.setLanguage(CSharp);

  files.forEach(file => {
    try {
      const source = fs.readFileSync(file, "utf8");
      const tree = parser.parse(source);
      const relativePath = path.relative(repoPath, file);

      let currentNamespace = "";

      traverse(tree.rootNode, (node) => {
        // Track namespace
        if (node.type === "namespace_declaration" || node.type === "file_scoped_namespace_declaration") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            currentNamespace = source.slice(nameNode.startIndex, nameNode.endIndex);
          }
        }

        // Extract class/interface/struct names and their methods
        if (
          node.type === "class_declaration" ||
          node.type === "interface_declaration" ||
          node.type === "struct_declaration" ||
          node.type === "enum_declaration" ||
          node.type === "record_declaration"
        ) {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const className = source.slice(nameNode.startIndex, nameNode.endIndex);
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

            // Extract methods from this class/interface
            const body = node.childForFieldName("body");
            if (body) {
              extractMethodsFromBody(body, source, className, relativePath, methodIndex);
            }
          }
        }
      });
    } catch (e) {
      // Skip files that can't be parsed
    }
  });

  return { classIndex, fqcnIndex, methodIndex };
}

function extractMethodsFromBody(body, source, className, filePath, methodIndex) {
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    if (member.type === "method_declaration" || member.type === "property_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

        if (!methodIndex[methodName]) {
          methodIndex[methodName] = [];
        }
        methodIndex[methodName].push({
          className,
          filePath
        });
      }
    }
  }
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// -------------------------------------------------------------
// Extract variable types from a file (fields, local vars, params)
// Returns: { varName: typeName }
// -------------------------------------------------------------
function extractVariableTypes(tree, source) {
  const varTypes = {};

  traverse(tree.rootNode, (node) => {
    // Field declarations: private IService _service;
    if (node.type === "field_declaration") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);

        // Find variable declarators
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === "variable_declaration") {
            for (let j = 0; j < child.childCount; j++) {
              const declarator = child.child(j);
              if (declarator.type === "variable_declarator") {
                const nameNode = declarator.childForFieldName("name");
                if (nameNode) {
                  const varName = source.slice(nameNode.startIndex, nameNode.endIndex);
                  varTypes[varName] = typeName;
                }
              }
            }
          }
        }
      }
    }

    // Property declarations: public IService Service { get; set; }
    if (node.type === "property_declaration") {
      const typeNode = node.childForFieldName("type");
      const nameNode = node.childForFieldName("name");
      if (typeNode && nameNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);
        const varName = source.slice(nameNode.startIndex, nameNode.endIndex);
        varTypes[varName] = typeName;
      }
    }

    // Parameter declarations in constructors/methods
    if (node.type === "parameter") {
      const typeNode = node.childForFieldName("type");
      const nameNode = node.childForFieldName("name");
      if (typeNode && nameNode) {
        const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);
        const varName = source.slice(nameNode.startIndex, nameNode.endIndex);
        varTypes[varName] = typeName;
      }
    }

    // Local variable declarations: var service = new Service();
    if (node.type === "local_declaration_statement") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "variable_declaration") {
          const typeNode = child.childForFieldName("type");
          if (typeNode) {
            const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);

            for (let j = 0; j < child.childCount; j++) {
              const declarator = child.child(j);
              if (declarator.type === "variable_declarator") {
                const nameNode = declarator.childForFieldName("name");
                if (nameNode) {
                  const varName = source.slice(nameNode.startIndex, nameNode.endIndex);
                  // For 'var', try to infer type from initializer
                  if (typeName === "var") {
                    const initNode = declarator.childForFieldName("initializer");
                    if (initNode) {
                      const inferredType = inferTypeFromInitializer(initNode, source);
                      if (inferredType) {
                        varTypes[varName] = inferredType;
                      }
                    }
                  } else {
                    varTypes[varName] = typeName;
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  return varTypes;
}

function inferTypeFromInitializer(initNode, source) {
  // Handle: new SomeClass()
  traverse(initNode, (n) => {
    if (n.type === "object_creation_expression") {
      const typeNode = n.childForFieldName("type");
      if (typeNode) {
        return source.slice(typeNode.startIndex, typeNode.endIndex);
      }
    }
  });
  return null;
}

// -------------------------------------------------------------
// Resolve using directive to local file or external package
// -------------------------------------------------------------
function resolveUsing(usingNamespace, fqcnIndex, classIndex) {
  // Check if it's a direct FQCN match
  if (fqcnIndex[usingNamespace]) {
    return {
      type: "local",
      files: fqcnIndex[usingNamespace]
    };
  }

  // Check if it's a partial match (importing a namespace)
  const matchingFiles = [];
  Object.entries(fqcnIndex).forEach(([fqcn, files]) => {
    if (fqcn.startsWith(usingNamespace + ".") || fqcn === usingNamespace) {
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
    namespace: usingNamespace
  };
}

// -------------------------------------------------------------
// Check if namespace is C# standard library or common external
// -------------------------------------------------------------
function isCSharpStdLib(namespace) {
  return (
    namespace.startsWith("System") ||
    namespace.startsWith("Microsoft") ||
    namespace.startsWith("Windows")
  );
}

// -------------------------------------------------------------
// Analyze C# files
// -------------------------------------------------------------
function analyzeCSharpRepo(repoPath) {
  const csFiles = getCSharpFiles(repoPath);
  const totalFiles = csFiles.length;

  console.log(`\n📂 Building class and method index...`);
  const { classIndex, fqcnIndex, methodIndex } = buildClassIndex(csFiles);
  console.log(`✅ Found ${Object.keys(classIndex).length} types and ${Object.keys(methodIndex).length} methods across ${totalFiles} files\n`);

  const results = [];
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`📊 C# files to process: ${totalFiles}\n`);

  for (let i = 0; i < csFiles.length; i++) {
    const file = csFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const source = fs.readFileSync(file, "utf8");
      const parser = new Parser();
      parser.setLanguage(CSharp);
      const tree = parser.parse(source);

      const importFiles = [];
      const externalImports = [];

      // Extract variable types for this file
      const varTypes = extractVariableTypes(tree, source);

      // Extract using directives
      traverse(tree.rootNode, (node) => {
        if (node.type === "using_directive") {
          // Skip using static and using alias
          let isStatic = false;
          let hasAlias = false;

          for (let j = 0; j < node.childCount; j++) {
            const child = node.child(j);
            if (source.slice(child.startIndex, child.endIndex) === "static") {
              isStatic = true;
            }
            if (child.type === "name_equals") {
              hasAlias = true;
            }
          }

          if (isStatic || hasAlias) {
            for (let j = 0; j < node.childCount; j++) {
              const child = node.child(j);
              if (child.type === "qualified_name" || child.type === "identifier") {
                externalImports.push(source.slice(child.startIndex, child.endIndex));
                break;
              }
            }
            return;
          }

          // Get the namespace being imported
          let namespace = "";
          for (let j = 0; j < node.childCount; j++) {
            const child = node.child(j);
            if (child.type === "qualified_name" || child.type === "identifier") {
              namespace = source.slice(child.startIndex, child.endIndex);
              break;
            }
          }

          if (namespace) {
            if (isCSharpStdLib(namespace)) {
              externalImports.push(namespace);
            } else {
              const resolved = resolveUsing(namespace, fqcnIndex, classIndex);
              if (resolved.type === "local") {
                const currentFile = path.relative(repoPath, file);
                resolved.files.forEach(f => {
                  if (f !== currentFile) {
                    importFiles.push(f);
                  }
                });
              } else {
                externalImports.push(namespace);
              }
            }
          }
        }
      });

      // Extract functions and classes with enhanced call resolution
      const functions = extractFunctionsAndCalls(file, repoPath, {
        classIndex,
        fqcnIndex,
        methodIndex,
        varTypes
      });
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
  console.log(`✅ Completed processing ${totalFiles} C# files\n`);

  return results;
}

// -------------------------------------------------------------
// EXPORT FOR MODULE USE
// -------------------------------------------------------------
module.exports = { analyzeCSharpRepo };

// -------------------------------------------------------------
// CLI MODE - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node csharp/file-tree-mapper-csharp.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);

  console.log(`📂 Scanning C# repo: ${repoPath}`);

  const results = analyzeCSharpRepo(repoPath);

  console.log(`\n📊 Summary:`);
  console.log(`   Total C# files: ${results.length}\n`);

  // Write results
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Output written → ${importsOutput}`);
}
