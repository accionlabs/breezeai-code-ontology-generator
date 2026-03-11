const Parser = require("tree-sitter");
const Python = require("tree-sitter-python");
const fs = require("fs");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Python);

function extractClasses(filePath, repoPath) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);

    const classes = [];

    traverse(tree.rootNode, (node) => {
      if (node.type === "class_definition") {
        const classInfo = extractClassInfo(node, source);
        if (classInfo.name) {
          classes.push(classInfo);
        }
      }
    });

    return classes;
  } catch (error) {
    console.error(`Error extracting classes from ${filePath}:`, error);
    return [];
  }
}

function extractClassInfo(node, source) {
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;

  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // Extract superclasses
  const superclasses = [];
  const superclassNode = node.childForFieldName("superclasses");
  if (superclassNode) {
    traverse(superclassNode, (child) => {
      if (child.type === "identifier" && child.parent.type === "argument_list") {
        superclasses.push(source.slice(child.startIndex, child.endIndex));
      } else if (child.type === "attribute") {
        superclasses.push(source.slice(child.startIndex, child.endIndex));
      }
    });
  }

  // Extract methods (names only, matching TypeScript format)
  const methods = [];
  let constructorParams = [];
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    traverse(bodyNode, (child) => {
      if (child.type === "function_definition" && child.parent === bodyNode) {
        const methodNameNode = child.childForFieldName("name");
        const methodName = methodNameNode ? source.slice(methodNameNode.startIndex, methodNameNode.endIndex) : null;
        if (methodName) {
          methods.push(methodName);
          
          // Extract constructor params from __init__ method
          if (methodName === "__init__") {
            const paramsNode = child.childForFieldName("parameters");
            if (paramsNode) {
              traverse(paramsNode, (paramChild) => {
                if (paramChild.type === "identifier" && paramChild.parent.type === "parameters") {
                  const paramName = source.slice(paramChild.startIndex, paramChild.endIndex);
                  if (paramName !== "self" && paramName !== "cls") {
                    constructorParams.push(paramName);
                  }
                } else if (paramChild.type === "default_parameter") {
                  const pNameNode = paramChild.childForFieldName("name");
                  if (pNameNode) {
                    const paramName = source.slice(pNameNode.startIndex, pNameNode.endIndex);
                    if (paramName !== "self" && paramName !== "cls") {
                      constructorParams.push(paramName);
                    }
                  }
                } else if (paramChild.type === "typed_parameter" || paramChild.type === "typed_default_parameter") {
                  const pNameNode = paramChild.childForFieldName("name");
                  if (pNameNode) {
                    const paramName = source.slice(pNameNode.startIndex, pNameNode.endIndex);
                    if (paramName !== "self" && paramName !== "cls") {
                      constructorParams.push(paramName);
                    }
                  }
                }
              });
            }
          }
        }
      }
    });
  }

  const statements = extractClassStatements(node, source);

  // Match TypeScript format
  return {
    name,
    type: "class",
    visibility: "public",
    isAbstract: false, // Python ABC checking would be complex, defaulting to false
    extends: superclasses.length > 0 ? superclasses[0] : null, // Python supports multiple inheritance, take first
    implements: [], // Python doesn't have interfaces like TypeScript
    constructorParams,
    methods, // Now array of strings instead of objects
    statements,
    startLine,
    endLine
  };
}

function extractMethodInfo(node, source) {
  const nameNode = node.childForFieldName("name");
  const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;

  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // Determine visibility and kind
  let visibility = "public";
  let kind = "instance";

  if (name) {
    if (name.startsWith("_") && !name.startsWith("__")) {
      visibility = "protected";
    } else if (name.startsWith("__") && !name.endsWith("__")) {
      visibility = "private";
    }
  }

  // Check for decorators to determine kind
  let parent = node.parent;
  if (parent && parent.type === "decorated_definition") {
    const decorators = [];
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (child.type === "decorator") {
        const decoratorName = extractDecoratorName(child, source);
        decorators.push(decoratorName);
        
        if (decoratorName === "staticmethod") {
          kind = "static";
        } else if (decoratorName === "classmethod") {
          kind = "class";
        }
      }
    }
  }

  // Extract parameters
  const params = [];
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode) {
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
  }

  return {
    name,
    type: "method",
    visibility,
    kind,
    params,
    startLine,
    endLine
  };
}

function extractDecoratorName(decoratorNode, source) {
  for (let i = 0; i < decoratorNode.childCount; i++) {
    const child = decoratorNode.child(i);
    if (child.type === "identifier") {
      return source.slice(child.startIndex, child.endIndex);
    } else if (child.type === "attribute") {
      const attrNode = child.childForFieldName("attribute");
      if (attrNode) {
        return source.slice(attrNode.startIndex, attrNode.endIndex);
      }
    } else if (child.type === "call") {
      const funcNode = child.childForFieldName("function");
      if (funcNode && funcNode.type === "identifier") {
        return source.slice(funcNode.startIndex, funcNode.endIndex);
      }
    }
  }
  return "unknown";
}

function extractClassStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    const nameNode = child.childForFieldName("name");
    statements.push({
      type: child.type,
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
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

module.exports = { extractClasses };

