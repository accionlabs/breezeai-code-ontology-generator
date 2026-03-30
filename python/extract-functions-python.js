const Parser = require("tree-sitter");
const Python = require("tree-sitter-python");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource, containsDbQuery, getDbFromMethod } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Python);

const STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "return_statement"];

function extractFunctionsWithCalls(filePath, repoPath, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "function_definition") {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode, captureStatements);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode = false, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  // Check if it's a method (inside a class)
  let visibility = "public";
  let kind = "function";
  
  if (name && name.startsWith("_") && !name.startsWith("__")) {
    visibility = "protected";
  } else if (name && name.startsWith("__") && !name.endsWith("__")) {
    visibility = "private";
  }

  // Check if inside a class
  let parent = node.parent;
  while (parent) {
    if (parent.type === "class_definition") {
      kind = "method";
      break;
    }
    parent = parent.parent;
  }

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: node.type,
    visibility,
    kind,
    params,
    startLine,
    endLine,
    calls,
    statements
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];
  
  traverse(paramsNode, (child) => {
    if (child.type === "identifier" && child.parent.type === "parameters") {
      const paramName = source.slice(child.startIndex, child.endIndex);
      if (paramName !== "self" && paramName !== "cls") {
        params.push(paramName);
      }
    } else if (child.type === "default_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (paramName !== "self" && paramName !== "cls") {
          params.push(paramName);
        }
      }
    } else if (child.type === "typed_parameter" || child.type === "typed_default_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (paramName !== "self" && paramName !== "cls") {
          params.push(paramName);
        }
      }
    } else if (child.type === "list_splat_pattern") {
      const nameNode = child.namedChild(0);
      if (nameNode) {
        params.push("*" + source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    } else if (child.type === "dictionary_splat_pattern") {
      const nameNode = child.namedChild(0);
      if (nameNode) {
        params.push("**" + source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  });

  return params;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (!fn) return;

      if (fn.type === "identifier") {
        calls.push({
          name: source.slice(fn.startIndex, fn.endIndex),
          path: null
        });
      } else if (fn.type === "attribute") {
        const object = fn.childForFieldName("object");
        const attr = fn.childForFieldName("attribute");
        
        let objectName = null;
        if (object) {
          // Get the root object name
          let currentObj = object;
          while (currentObj.type === "attribute") {
            currentObj = currentObj.childForFieldName("object");
          }
          if (currentObj && currentObj.type === "identifier") {
            objectName = source.slice(currentObj.startIndex, currentObj.endIndex);
          }
        }
        
        calls.push({
          name: attr ? source.slice(attr.startIndex, attr.endIndex) : null,
          objectName: objectName,
          path: null
        });
      }
    }
  });

  return calls;
}

function extractImports(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const imports = [];

  traverse(tree.rootNode, (node) => {
    // import module
    if (node.type === "import_statement") {
      traverse(node, (n) => {
        if (n.type === "dotted_name" && n.parent.type === "import_statement") {
          const moduleName = source.slice(n.startIndex, n.endIndex);
          imports.push({
            source: moduleName,
            imported: []
          });
        } else if (n.type === "aliased_import") {
          const nameNode = n.childForFieldName("name");
          if (nameNode) {
            const moduleName = source.slice(nameNode.startIndex, nameNode.endIndex);
            const aliasNode = n.childForFieldName("alias");
            const alias = aliasNode ? source.slice(aliasNode.startIndex, aliasNode.endIndex) : null;
            imports.push({
              source: moduleName,
              imported: alias ? [alias] : []
            });
          }
        }
      });
    }

    // from module import name
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      let moduleName = "";
      
      if (moduleNode) {
        if (moduleNode.type === "dotted_name") {
          moduleName = source.slice(moduleNode.startIndex, moduleNode.endIndex);
        } else if (moduleNode.type === "relative_import") {
          moduleName = source.slice(moduleNode.startIndex, moduleNode.endIndex);
        }
      } else {
        // Check for relative imports without module name
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === "relative_import") {
            moduleName = source.slice(child.startIndex, child.endIndex);
            break;
          }
        }
      }
      
      const importedNames = [];
      traverse(node, (n) => {
        if (n.type === "dotted_name" && n.parent.parent && n.parent.parent.type === "import_from_statement") {
          importedNames.push(source.slice(n.startIndex, n.endIndex));
        } else if (n.type === "aliased_import") {
          const nameNode = n.childForFieldName("name");
          const aliasNode = n.childForFieldName("alias");
          if (nameNode) {
            importedNames.push(
              aliasNode ? source.slice(aliasNode.startIndex, aliasNode.endIndex) : source.slice(nameNode.startIndex, nameNode.endIndex)
            );
          }
        }
      });

      if (moduleName || importedNames.length > 0) {
        imports.push({
          source: moduleName,
          imported: importedNames
        });
      }
    }
  });

  return imports;
}

function extractStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (STATEMENT_TYPES.includes(child.type)) {
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    }
  }

  // Collect return statements from nested blocks (if/else, loops, try/except, etc.)
  collectReturnStatements(body, source, statements, body);

  collectQueryStatements(node, source, statements);

  return statements;
}

function collectReturnStatements(node, source, statements, functionBody) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === "return_statement") {
      if (child.parent === functionBody) continue;
      statements.push({
        type: child.type,
        text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    } else {
      collectReturnStatements(child, source, statements, functionBody);
    }
  }
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractFunctionsAndCalls(filePath, repoPath, imports = null, captureSourceCode = false, captureStatements = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode, captureStatements);
    if (!imports) imports = extractImports(filePath);

    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.forEach(imp => {
      imp.imported?.forEach(imported => {
        // For Python, we'll store the module path as-is
        functionMap.set(imported, imp.source);
      });
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

        delete call.objectName;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

function extractFileStatements(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);
  const statements = [];
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  // NOTE: query_statement and api_call are NOT collected here.
  // They are already captured inside each function's own statements.
  // Collecting them here would cause duplicates.

  return statements;
}

function collectQueryStatements(node, source, statements) {
  const seen = new Set(statements.map(s => `${s.startLine}:${s.endLine}`));
  const matchedRanges = [];

  traverse(node, (n) => {
    if (n.type === "call") {
      const fn = n.childForFieldName("function");
      if (!fn) return;

      let methodName = null;
      if (fn.type === "identifier") {
        methodName = source.slice(fn.startIndex, fn.endIndex);
      } else if (fn.type === "attribute") {
        const attr = fn.childForFieldName("attribute");
        methodName = attr ? source.slice(attr.startIndex, attr.endIndex) : null;
      }

      const db = getDbFromMethod(methodName);
      if (db) {
        const isNested = matchedRanges.some(
          r => n.startIndex >= r.start && n.endIndex <= r.end
        );
        if (isNested) return;

        const key = `${n.startPosition.row + 1}:${n.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          matchedRanges.push({ start: n.startIndex, end: n.endIndex });
          statements.push({
            type: "query_statement", db,
            text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
            startLine: n.startPosition.row + 1,
            endLine: n.endPosition.row + 1,
          });
        }
        return;
      }
    }

    if (n.type === "string" || n.type === "concatenated_string") {
      const text = source.slice(n.startIndex, n.endIndex);
      if (containsDbQuery(text)) {
        let parent = n.parent;
        while (parent && parent !== node && parent.type !== "assignment" && parent.type !== "expression_statement") {
          parent = parent.parent;
        }
        const contextNode = (parent && parent !== node) ? parent : n;
        const key = `${contextNode.startPosition.row + 1}:${contextNode.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement",
            text: source.slice(contextNode.startIndex, contextNode.endIndex).slice(0, 500),
            startLine: contextNode.startPosition.row + 1,
            endLine: contextNode.endPosition.row + 1,
          });
        }
      }
    }
  });
}

module.exports = { extractFunctionsAndCalls, extractImports, extractFileStatements, collectQueryStatements };

