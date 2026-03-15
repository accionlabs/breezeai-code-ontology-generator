const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php").php;
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(PHP);

const STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "if_statement", "for_statement", "foreach_statement", "switch_statement", "return_statement", "enum_declaration"];

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_definition" ||
      node.type === "method_declaration"
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
      return "method";
    case "function_definition":
      return "function";
    default:
      return "function";
  }
}

function getFunctionModifiers(node, source) {
  let visibility = "public"; // PHP default for functions
  let kind = "function";

  // Check if it's a method (inside a class, trait, or interface)
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "class_declaration" ||
      parent.type === "trait_declaration" ||
      parent.type === "interface_declaration"
    ) {
      kind = "method";
      break;
    }
    parent = parent.parent;
  }

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    // Check for visibility_modifier node
    if (child.type === "visibility_modifier") {
      const modText = source.slice(child.startIndex, child.endIndex).toLowerCase();
      if (modText === "public") {
        visibility = "public";
      } else if (modText === "private") {
        visibility = "private";
      } else if (modText === "protected") {
        visibility = "protected";
      }
    }

    // Check for static modifier
    if (child.type === "static_modifier") {
      kind = "static";
    }

    // Also check raw text for modifiers
    const modText = source.slice(child.startIndex, child.endIndex).toLowerCase();
    if (modText === "public") {
      visibility = "public";
    } else if (modText === "private") {
      visibility = "private";
    } else if (modText === "protected") {
      visibility = "protected";
    } else if (modText === "static") {
      kind = "static";
    } else if (modText === "abstract") {
      kind = "abstract";
    }
  }

  return { visibility, kind };
}

function extractFunctionParams(node, source) {
  // Look for formal_parameters or parameters node
  let paramsNode = node.childForFieldName("parameters");

  if (!paramsNode) {
    // Try to find formal_parameters by traversing children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === "formal_parameters") {
        paramsNode = child;
        break;
      }
    }
  }

  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    // Handle simple_parameter, property_promotion_parameter, variadic_parameter
    if (
      child.type === "simple_parameter" ||
      child.type === "property_promotion_parameter" ||
      child.type === "variadic_parameter"
    ) {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        let paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        // Remove $ prefix for cleaner output
        if (paramName.startsWith("$")) {
          paramName = paramName.substring(1);
        }
        // Mark variadic params
        if (child.type === "variadic_parameter") {
          params.push("..." + paramName);
        } else {
          params.push(paramName);
        }
      } else {
        // Try to find variable_name directly
        traverse(child, (n) => {
          if (n.type === "variable_name" && n.parent === child) {
            let paramName = source.slice(n.startIndex, n.endIndex);
            if (paramName.startsWith("$")) {
              paramName = paramName.substring(1);
            }
            if (child.type === "variadic_parameter") {
              params.push("..." + paramName);
            } else {
              params.push(paramName);
            }
          }
        });
      }
    }
  }

  return params;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  // Try to find name by looking for identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "name") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  return null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    // Function calls: function_call_expression
    if (node.type === "function_call_expression") {
      const callInfo = extractCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }

    // Method calls: member_call_expression
    if (node.type === "member_call_expression") {
      const callInfo = extractMemberCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }

    // Static method calls: scoped_call_expression
    if (node.type === "scoped_call_expression") {
      const callInfo = extractScopedCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

function extractCallInfo(node, source) {
  // Get the function being called
  const functionNode = node.childForFieldName("function");
  if (!functionNode) {
    // Try first child
    const firstChild = node.child(0);
    if (firstChild && (firstChild.type === "name" || firstChild.type === "qualified_name")) {
      return {
        name: source.slice(firstChild.startIndex, firstChild.endIndex),
        objectName: null,
        path: null
      };
    }
    return null;
  }

  // Simple function call: foo()
  if (functionNode.type === "name" || functionNode.type === "qualified_name") {
    return {
      name: source.slice(functionNode.startIndex, functionNode.endIndex),
      objectName: null,
      path: null
    };
  }

  return null;
}

function extractMemberCallInfo(node, source) {
  // $object->method()
  const nameNode = node.childForFieldName("name");
  const objectNode = node.childForFieldName("object");

  let methodName = null;
  if (nameNode) {
    methodName = source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  let objectName = null;
  if (objectNode) {
    // Get the root object (unwrap chains)
    let currentObj = objectNode;
    while (currentObj.type === "member_call_expression" || currentObj.type === "member_access_expression") {
      const innerObj = currentObj.childForFieldName("object");
      if (!innerObj) break;
      currentObj = innerObj;
    }

    if (currentObj.type === "variable_name") {
      objectName = source.slice(currentObj.startIndex, currentObj.endIndex);
      if (objectName.startsWith("$")) {
        objectName = objectName.substring(1);
      }
    } else {
      objectName = source.slice(currentObj.startIndex, currentObj.endIndex);
    }
  }

  return {
    name: methodName,
    objectName: objectName,
    path: null
  };
}

function extractScopedCallInfo(node, source) {
  // ClassName::method() or self::method() or static::method() or parent::method()
  const nameNode = node.childForFieldName("name");
  const scopeNode = node.childForFieldName("scope");

  let methodName = null;
  if (nameNode) {
    methodName = source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  let className = null;
  if (scopeNode) {
    className = source.slice(scopeNode.startIndex, scopeNode.endIndex);
  }

  return {
    name: methodName,
    objectName: className,
    path: null
  };
}

function isQueryStatement(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const nameNode = declarator.childForFieldName("name");
    if (nameNode) {
      const name = nameNode.text || "";
      if (/query/i.test(name)) return true;
    }
  }
  return false;
}

function isStringOrTemplateAssignment(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const value = declarator.childForFieldName("value") || declarator.childForFieldName("init");
    if (!value) continue;
    const vtype = value.type;
    if (vtype === "string" || vtype === "encapsed_string" || vtype === "heredoc" || vtype === "nowdoc") return true;
  }
  return false;
}

function isCallAssignment(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const value = declarator.childForFieldName("value") || declarator.childForFieldName("init");
    if (!value) continue;
    const vtype = value.type;
    if (vtype === "function_call_expression" || vtype === "member_call_expression" || vtype === "scoped_call_expression" || vtype === "anonymous_function_creation_expression" || vtype === "arrow_function") return true;
  }
  return false;
}

function extractStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    if ((child.type === "lexical_declaration" || child.type === "variable_declaration") && (isCallAssignment(child) || isQueryStatement(child) || isStringOrTemplateAssignment(child))) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract use statements and require/include from a file
function extractImports(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const imports = {
    useStatements: [],
    requires: []
  };

  traverse(tree.rootNode, (node) => {
    // use statements: use Namespace\Class;
    if (node.type === "namespace_use_declaration") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "namespace_use_clause") {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            imports.useStatements.push({
              source: source.slice(nameNode.startIndex, nameNode.endIndex),
              alias: getUseAlias(child, source)
            });
          } else {
            // Try to get qualified_name directly - only look at direct children
            for (let j = 0; j < child.childCount; j++) {
              const subChild = child.child(j);
              if (subChild.type === "qualified_name" || subChild.type === "name") {
                imports.useStatements.push({
                  source: source.slice(subChild.startIndex, subChild.endIndex),
                  alias: getUseAlias(child, source)
                });
                break; // Only add the first (full) qualified name
              }
            }
          }
        }

        // Handle namespace_use_group for grouped imports: use Namespace\{Class1, Class2}
        if (child.type === "namespace_use_group") {
          const prefix = getGroupPrefix(node, source);
          for (let j = 0; j < child.childCount; j++) {
            const groupChild = child.child(j);
            if (groupChild.type === "namespace_use_group_clause") {
              const clauseNameNode = groupChild.childForFieldName("name");
              if (clauseNameNode) {
                const name = source.slice(clauseNameNode.startIndex, clauseNameNode.endIndex);
                imports.useStatements.push({
                  source: prefix ? `${prefix}\\${name}` : name,
                  alias: getUseAlias(groupChild, source)
                });
              } else {
                // Look for name in direct children
                for (let k = 0; k < groupChild.childCount; k++) {
                  const nameChild = groupChild.child(k);
                  if (nameChild.type === "name" || nameChild.type === "qualified_name") {
                    const name = source.slice(nameChild.startIndex, nameChild.endIndex);
                    imports.useStatements.push({
                      source: prefix ? `${prefix}\\${name}` : name,
                      alias: getUseAlias(groupChild, source)
                    });
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    // require/include statements
    if (
      node.type === "include_expression" ||
      node.type === "include_once_expression" ||
      node.type === "require_expression" ||
      node.type === "require_once_expression"
    ) {
      // Get the path being required
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "string" || child.type === "encapsed_string") {
          let reqPath = source.slice(child.startIndex, child.endIndex);
          // Remove quotes
          reqPath = reqPath.replace(/^['"]|['"]$/g, "");
          imports.requires.push({
            source: reqPath,
            type: node.type.replace("_expression", "")
          });
        }
      }
    }
  });

  return imports;
}

function getUseAlias(clauseNode, source) {
  const aliasNode = clauseNode.childForFieldName("alias");
  if (aliasNode) {
    return source.slice(aliasNode.startIndex, aliasNode.endIndex);
  }
  return null;
}

function getGroupPrefix(useDeclaration, source) {
  for (let i = 0; i < useDeclaration.childCount; i++) {
    const child = useDeclaration.child(i);
    if (child.type === "namespace_name" || child.type === "qualified_name") {
      return source.slice(child.startIndex, child.endIndex);
    }
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
    // Skip PHP special keywords
    if (["this", "self", "static", "parent"].includes(call.objectName)) {
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

    // Try to resolve objectName as a class name (static method call)
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
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    if ((child.type === "lexical_declaration" || child.type === "variable_declaration") && (isCallAssignment(child) || isQueryStatement(child) || isStringOrTemplateAssignment(child))) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  return statements;
}

module.exports = { extractFunctionsAndCalls, extractImports, extractFileStatements };
