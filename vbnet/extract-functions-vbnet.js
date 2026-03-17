const Parser = require("tree-sitter");
const VBNet = require("tree-sitter-vb-dotnet");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource, containsDbQuery, isDbCallMethod } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(VBNet);

const STATEMENT_TYPES = ["dim_statement", "const_declaration", "field_declaration", "enum_block", "enum_member", "attribute_block"];

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    // VB.NET function/sub declarations
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration" ||
      node.type === "property_declaration" ||
      node.type === "delegate_declaration"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode, captureStatements);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source, captureSourceCode = false, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind } = getFunctionModifiers(node, source);

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: getFunctionType(node),
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

function getFunctionType(node) {
  switch (node.type) {
    case "method_declaration":
      return "function";
    case "constructor_declaration":
      return "constructor";
    case "property_declaration":
      return "property";
    case "delegate_declaration":
      return "delegate";
    default:
      return "function";
  }
}

function getFunctionModifiers(node, source) {
  let visibility = "public"; // VB.NET default
  let kind = "method";

  // Check if it's inside a class/module/structure
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "class_block" ||
      parent.type === "module_block" ||
      parent.type === "structure_block" ||
      parent.type === "interface_block"
    ) {
      kind = "method";
      break;
    }
    parent = parent.parent;
  }

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childText = source.slice(child.startIndex, child.endIndex).toLowerCase();

    // VB.NET access modifiers
    if (childText === "public") {
      visibility = "public";
    } else if (childText === "private") {
      visibility = "private";
    } else if (childText === "protected") {
      visibility = "protected";
    } else if (childText === "friend") {
      visibility = "internal";
    } else if (childText === "protected friend") {
      visibility = "protected internal";
    }

    // VB.NET method modifiers
    if (childText === "shared") {
      kind = "static";
    } else if (childText === "overridable") {
      kind = "virtual";
    } else if (childText === "mustoverride") {
      kind = "abstract";
    } else if (childText === "overrides") {
      kind = "override";
    } else if (childText === "notoverridable") {
      kind = "sealed";
    }
  }

  return { visibility, kind };
}

function extractFunctionParams(node, source) {
  const params = [];

  // Look for parameter_list node
  traverse(node, (n) => {
    if (n.type === "parameter_list" && n.parent === node) {
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);

        if (!child.isNamed) continue;

        if (child.type === "parameter") {
          const nameNode = getParameterName(child, source);
          if (nameNode) {
            params.push(nameNode);
          }
        }
      }
    }
  });

  return params;
}

function getParameterName(paramNode, source) {
  // Look for identifier in the parameter
  for (let i = 0; i < paramNode.childCount; i++) {
    const child = paramNode.child(i);
    if (child.type === "identifier") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  // Try childForFieldName
  const nameNode = paramNode.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  return null;
}

function getFunctionName(node, source) {
  // Try to find identifier child directly
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "identifier") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  // Try childForFieldName
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  return null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    // Method invocation: object.Method() or Method()
    if (node.type === "invocation_expression") {
      const callInfo = extractInvocationInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }

    // Member access expression can also be a call
    if (node.type === "member_access_expression") {
      // Check if this is part of an invocation
      if (node.parent && node.parent.type === "invocation_expression") {
        // Already handled by invocation_expression
        return;
      }
    }
  });

  return calls;
}

function extractInvocationInfo(node, source) {
  let methodName = null;
  let objectName = null;

  // Get the expression being invoked
  const expr = node.child(0);
  if (!expr) return null;

  if (expr.type === "identifier") {
    // Simple function call: FunctionName()
    methodName = source.slice(expr.startIndex, expr.endIndex);
  } else if (expr.type === "member_access_expression") {
    // Member call: object.Method()
    const memberName = getMemberAccessName(expr, source);
    if (memberName) {
      methodName = memberName.name;
      objectName = memberName.object;
    }
  } else if (expr.type === "qualified_name") {
    // Qualified call: Namespace.Class.Method()
    methodName = source.slice(expr.startIndex, expr.endIndex);
  }

  if (!methodName) return null;

  return {
    name: methodName,
    objectName: objectName,
    path: null
  };
}

function getMemberAccessName(node, source) {
  // VB.NET member access: object.member
  let memberName = null;
  let objectName = null;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === "identifier") {
      if (memberName === null) {
        // First identifier is the object
        objectName = source.slice(child.startIndex, child.endIndex);
      } else {
        // Second identifier is the member
        memberName = source.slice(child.startIndex, child.endIndex);
      }
    }
  }

  // If we have member access like obj.member, the last one is the method name
  if (node.childCount > 0) {
    const lastChild = node.child(node.childCount - 1);
    if (lastChild && lastChild.type === "identifier") {
      memberName = source.slice(lastChild.startIndex, lastChild.endIndex);
    }

    // Get the object (everything before the last dot)
    const firstChild = node.child(0);
    if (firstChild) {
      if (firstChild.type === "identifier") {
        objectName = source.slice(firstChild.startIndex, firstChild.endIndex);
      } else if (firstChild.type === "member_access_expression") {
        // Nested member access
        objectName = source.slice(firstChild.startIndex, firstChild.endIndex);
      }
    }
  }

  return { name: memberName, object: objectName };
}

function extractStatements(node, source) {
  // VB.NET method_declaration has statements as direct children (no body field)
  const statements = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    // statement node wraps actual statements in VB.NET grammar
    if (child.type === "statement") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const stmt = child.namedChild(j);
        if (!STATEMENT_TYPES.includes(stmt.type)) continue;
        statements.push({
          type: stmt.type,
          text: source.slice(stmt.startIndex, stmt.endIndex).slice(0, 200),
          startLine: stmt.startPosition.row + 1,
          endLine: stmt.endPosition.row + 1,
        });
      }
    }
    // Also check direct children matching statement types
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  collectQueryStatements(node, source, statements);
  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract Imports statements from a file
function extractImports(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const imports = {
    importsStatements: [],
    references: []
  };

  traverse(tree.rootNode, (node) => {
    // Imports statements: Imports System.Collections.Generic
    if (node.type === "imports_statement") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "imports_clause") {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            imports.importsStatements.push({
              source: source.slice(nameNode.startIndex, nameNode.endIndex),
              alias: getImportAlias(child, source)
            });
          } else {
            // Try to get qualified_name or identifier directly
            for (let j = 0; j < child.childCount; j++) {
              const subChild = child.child(j);
              if (subChild.type === "qualified_name" || subChild.type === "identifier") {
                imports.importsStatements.push({
                  source: source.slice(subChild.startIndex, subChild.endIndex),
                  alias: getImportAlias(child, source)
                });
                break;
              }
            }
          }
        }

        // Direct qualified_name under imports_statement
        if (child.type === "qualified_name" || child.type === "identifier") {
          imports.importsStatements.push({
            source: source.slice(child.startIndex, child.endIndex),
            alias: null
          });
        }
      }
    }
  });

  return imports;
}

function getImportAlias(clauseNode, source) {
  const aliasNode = clauseNode.childForFieldName("alias");
  if (aliasNode) {
    return source.slice(aliasNode.startIndex, aliasNode.endIndex);
  }
  return null;
}

/**
 * Resolve call path using comprehensive index
 */
function resolveCallPath(call, index, currentFilePath) {
  const { classIndex, fqcnIndex, methodIndex, varTypes } = index;

  // If we have an object name, try to resolve its type
  if (call.objectName) {
    // Skip VB.NET special keywords
    if (["Me", "MyBase", "MyClass"].includes(call.objectName)) {
      return null;
    }

    // Check if objectName is a known variable with a type
    const objectType = varTypes[call.objectName];

    if (objectType) {
      // Look up the type in classIndex
      if (classIndex[objectType] && classIndex[objectType].length > 0) {
        // Find the file that has this method
        if (Object.hasOwn(methodIndex, call.name)) {
          const methodEntry = methodIndex[call.name].find(m => m.className === objectType);
          if (methodEntry) {
            return methodEntry.filePath;
          }
          return classIndex[objectType][0];
        }
        return classIndex[objectType][0];
      }
    }

    // Try to resolve objectName as a class name (static/shared method call)
    if (classIndex[call.objectName] && classIndex[call.objectName].length > 0) {
      if (Object.hasOwn(methodIndex, call.name)) {
        const methodEntry = methodIndex[call.name].find(m => m.className === call.objectName);
        if (methodEntry) {
          return methodEntry.filePath;
        }
      }
      return classIndex[call.objectName][0];
    }
  }

  // Try to resolve by method/function name alone
  if (call.name && Object.hasOwn(methodIndex, call.name)) {
    const methodEntries = methodIndex[call.name];

    if (methodEntries.length === 1) {
      return methodEntries[0].filePath;
    }

    const otherFileEntry = methodEntries.find(m => m.filePath !== currentFilePath);
    if (otherFileEntry) {
      return otherFileEntry.filePath;
    }

    return methodEntries[0].filePath;
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath, index = {}, captureSourceCode = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode);
    const currentFilePath = path.relative(repoPath, filePath);

    const { classIndex = {}, fqcnIndex = {}, methodIndex = {}, varTypes = {} } = index;

    // Build local function map
    const localFunctionMap = new Map();
    functions.forEach(func => {
      localFunctionMap.set(func.name, currentFilePath);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        if (localFunctionMap.has(call.name) && !call.objectName) {
          call.path = currentFilePath;
        } else {
          const resolvedPath = resolveCallPath(call, { classIndex, fqcnIndex, methodIndex, varTypes }, currentFilePath);
          if (resolvedPath) {
            call.path = resolvedPath;
          }
        }

        // Clean up temporary fields
        delete call.objectName;
        delete call.objectType;
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

  function collectStatements(node) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (STATEMENT_TYPES.includes(child.type)) {
        statements.push({
          type: child.type,
          text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
      // Traverse into type_declaration, class_block, module_block, etc. to find nested statements
      if (
        child.type === "type_declaration" ||
        child.type === "class_block" ||
        child.type === "module_block" ||
        child.type === "structure_block" ||
        child.type === "namespace_block" ||
        child.type === "enum_block"
      ) {
        collectStatements(child);
      }
    }
  }

  collectStatements(tree.rootNode);
  collectQueryStatements(tree.rootNode, source, statements);
  return statements;
}

function collectQueryStatements(node, source, statements) {
  const seen = new Set(statements.map(s => `${s.startLine}:${s.endLine}`));
  traverse(node, (n) => {
    if (n.type === "invocation_expression" || n.type === "invocation") {
      const expr = n.child(0);
      if (!expr) return;
      let methodName = null;
      let objectName = null;
      if (expr.type === "identifier") {
        methodName = source.slice(expr.startIndex, expr.endIndex);
      } else if (expr.type === "member_access_expression" || expr.type === "member_access") {
        const lastChild = expr.child(expr.childCount - 1);
        const firstChild = expr.child(0);
        methodName = lastChild && lastChild.type === "identifier" ? source.slice(lastChild.startIndex, lastChild.endIndex) : null;
        objectName = firstChild ? source.slice(firstChild.startIndex, firstChild.endIndex) : null;
      }
      if (methodName && isDbCallMethod(methodName)) {
        const key = `${n.startPosition.row + 1}:${n.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement", method: methodName, object: objectName,
            text: source.slice(n.startIndex, n.endIndex).slice(0, 500),
            startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
          });
        }
        return;
      }
    }
    if (n.type === "string_literal") {
      const text = source.slice(n.startIndex, n.endIndex);
      if (containsDbQuery(text)) {
        let parent = n.parent;
        while (parent && parent !== node && parent.type !== "dim_statement" && parent.type !== "assignment_statement") {
          parent = parent.parent;
        }
        const contextNode = (parent && parent !== node) ? parent : n;
        const key = `${contextNode.startPosition.row + 1}:${contextNode.endPosition.row + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          statements.push({
            type: "query_statement",
            text: source.slice(contextNode.startIndex, contextNode.endIndex).slice(0, 500),
            startLine: contextNode.startPosition.row + 1, endLine: contextNode.endPosition.row + 1,
          });
        }
      }
    }
  });
}

module.exports = { extractFunctionsAndCalls, extractImports, extractFileStatements, collectQueryStatements };
