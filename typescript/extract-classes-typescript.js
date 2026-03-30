const Parser = require("tree-sitter");
const TS = require("tree-sitter-typescript").typescript;
const fs = require("fs");
const path = require("path");
const { parseSource } = require("../utils");
const { collectQueryStatements } = require("./extract-functions-typescript");

const sharedParser = new Parser();
sharedParser.setLanguage(TS);

function extractClasses(filePath, repoPath = null, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "interface_declaration") {
      const classInfo = extractClassInfo(node, filePath, repoPath, source, captureStatements);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

const CLASS_STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "enum_declaration", "decorator"];

function extractClassStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!CLASS_STATEMENT_TYPES.includes(child.type)) continue;
    const nameNode = child.childForFieldName("name");
    statements.push({
      type: child.type,
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  // NOTE: query_statement and api_call are NOT collected here.
  // They are already captured inside each method's own statements.
  // Collecting them here would cause duplicates.

  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassInfo(node, filePath, repoPath = null, source, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node, source);
  const superClass = getSuperClassName(node, source);
  const interfaces = getImplementedInterfaces(node, source);
  const isInterface = node.type === "interface_declaration";
  const generics = extractClassGenerics(node, source);

  const {
    constructorParams,
    methods,
  } = extractClassMembers(node, source, isInterface);

  const statements = captureStatements ? extractClassStatements(node, source) : [];
  const { visibility, isAbstract } = getClassModifiers(node, source);

  return {
    name,
    type: isInterface ? "interface" : "class",
    visibility,
    isAbstract,
    generics,
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    statements,
    startLine,
    endLine
  };
}

function extractClassGenerics(node, source) {
  const typeParams = node.childForFieldName("type_parameters");
  if (typeParams) {
    return source.slice(typeParams.startIndex, typeParams.endIndex);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "type_parameters") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }
  return null;
}

function getClassName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function findHeritageNode(node) {
  // class_heritage is not a named field, find it as a child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "class_heritage") return child;
  }
  return null;
}

function getSuperClassName(node, source) {
  // For classes: look inside class_heritage for extends_clause
  const heritageNode = findHeritageNode(node);
  if (heritageNode) {
    for (let i = 0; i < heritageNode.childCount; i++) {
      const child = heritageNode.child(i);
      if (child.type === "extends_clause") {
        const typeNode = child.namedChild(0);
        if (typeNode) {
          return source.slice(typeNode.startIndex, typeNode.endIndex);
        }
      }
    }
  }

  // For interfaces: extends_type_clause is a direct child (not inside class_heritage)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "extends_type_clause") {
      const typeNode = child.namedChild(0);
      if (typeNode) {
        return source.slice(typeNode.startIndex, typeNode.endIndex);
      }
    }
  }

  return null;
}

function getImplementedInterfaces(node, source) {
  const heritageNode = findHeritageNode(node);
  if (!heritageNode) return [];

  const interfaces = [];

  for (let i = 0; i < heritageNode.childCount; i++) {
    const child = heritageNode.child(i);
    if (child.type === "implements_clause") {
      traverse(child, (n) => {
        if (n.type === "type_identifier") {
          interfaces.push(source.slice(n.startIndex, n.endIndex));
        }
      });
    }
  }

  return interfaces;
}

function getClassModifiers(node, source) {
  let visibility = "public"; // TypeScript default
  let isAbstract = node.type === "abstract_class_declaration";

  // Check for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const text = source.slice(child.startIndex, child.endIndex);

    if (text === "export") {
      visibility = "public";
    } else if (text === "abstract") {
      isAbstract = true;
    }
  }

  return { visibility, isAbstract };
}

function extractClassMembers(classNode, source, isInterface) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methods: [], properties: [] };
  }

  const methods = [];
  // const properties = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // Constructor
    if (member.type === "method_definition") {
      const nameNode = member.childForFieldName("name");
      if (nameNode && source.slice(nameNode.startIndex, nameNode.endIndex) === "constructor") {
        const fnNode = member.childForFieldName("value");
        if (fnNode) {
          constructorParams = extractParameterNames(fnNode, source);
        }
        continue;
      }

      // Regular method - just extract name
      if (nameNode) {
        methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }

    // Method signature (interface)
    if (member.type === "method_signature") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }

    // Properties/fields
    // if (member.type === "public_field_definition" || member.type === "property_signature") {
    //   const fieldInfo = extractFieldInfo(member, source);
    //   if (fieldInfo) {
    //     properties.push(fieldInfo);
    //   }
    // }
  }

  return { constructorParams, methods };
}

function extractParameterNames(node, source) {
  let paramsNode = node.childForFieldName("parameters");

  if (!paramsNode) {
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

    if (child.type === "required_parameter" || child.type === "optional_parameter") {
      const nameNode = child.childForFieldName("pattern");
      if (nameNode) {
        if (nameNode.type === "identifier") {
          params.push(source.slice(nameNode.startIndex, nameNode.endIndex));
        } else if (nameNode.type === "object_pattern") {
          params.push("{...}");
        } else if (nameNode.type === "array_pattern") {
          params.push("[...]");
        }
      }
    } else if (child.type === "rest_pattern") {
      const nameNode = child.childForFieldName("pattern") || child.child(1);
      if (nameNode) {
        if (nameNode.type === "identifier") {
          params.push("..." + source.slice(nameNode.startIndex, nameNode.endIndex));
        } else {
          params.push("...args");
        }
      }
    }
  }

  return params;
}

function extractFieldInfo(node, source) {
  // Get modifiers
  let visibility = "public";
  let isStatic = false;
  let isReadonly = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const text = source.slice(child.startIndex, child.endIndex);

    if (text === "private") {
      visibility = "private";
    } else if (text === "protected") {
      visibility = "protected";
    } else if (text === "public") {
      visibility = "public";
    } else if (text === "static") {
      isStatic = true;
    } else if (text === "readonly") {
      isReadonly = true;
    }
  }

  // Get name
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const name = source.slice(nameNode.startIndex, nameNode.endIndex);

  // Get type
  const typeNode = node.childForFieldName("type");
  const fieldType = typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : "any";

  // Check if has default value
  const valueNode = node.childForFieldName("value");
  const hasDefault = valueNode !== null;

  return {
    name,
    type: fieldType,
    visibility,
    isStatic,
    isFinal: isReadonly,
    hasDefault
  };
}

module.exports = { extractClasses };
