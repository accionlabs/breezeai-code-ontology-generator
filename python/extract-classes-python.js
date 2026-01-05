const Parser = require("tree-sitter");
const Python = require("tree-sitter-python");
const fs = require("fs");

function extractClasses(filePath, repoPath) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const parser = new Parser();
    parser.setLanguage(Python);
    const tree = parser.parse(source);

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

  // Extract methods
  const methods = [];
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    traverse(bodyNode, (child) => {
      if (child.type === "function_definition" && child.parent === bodyNode) {
        const methodInfo = extractMethodInfo(child, source);
        if (methodInfo.name) {
          methods.push(methodInfo);
        }
      }
    });
  }

  // Extract class variables
  const classVariables = [];
  if (bodyNode) {
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (child.type === "expression_statement") {
        const assignment = child.namedChild(0);
        if (assignment && assignment.type === "assignment") {
          const left = assignment.childForFieldName("left");
          if (left && left.type === "identifier") {
            classVariables.push(source.slice(left.startIndex, left.endIndex));
          }
        }
      }
    }
  }

  return {
    name,
    type: "class",
    visibility: "public",
    superclasses,
    startLine,
    endLine,
    methods,
    classVariables
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

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

module.exports = { extractClasses };

