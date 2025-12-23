const Parser = require("tree-sitter");
const TS = require("tree-sitter-typescript").typescript;
const fs = require("fs");
const path = require("path");

function extractClasses(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(TS);

  const tree = parser.parse(source);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "class_declaration" || node.type === "interface_declaration") {
      const classInfo = extractClassInfo(node, filePath, repoPath, source);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node, source);
  const superClass = getSuperClassName(node, source);
  const interfaces = getImplementedInterfaces(node, source);
  const isInterface = node.type === "interface_declaration";

  const {
    constructorParams,
    methods,
    properties
  } = extractClassMembers(node, source, isInterface);

  const { visibility, isAbstract } = getClassModifiers(node, source);

  return {
    name,
    type: isInterface ? "interface" : "class",
    visibility,
    isAbstract,
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    properties,
    startLine,
    endLine
  };
}

function getClassName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function getSuperClassName(node, source) {
  const heritageNode = node.childForFieldName("heritage");
  if (!heritageNode) return null;

  // Look for extends clause
  for (let i = 0; i < heritageNode.childCount; i++) {
    const child = heritageNode.child(i);
    if (child.type === "extends_clause") {
      const typeNode = child.namedChild(0);
      if (typeNode) {
        return source.slice(typeNode.startIndex, typeNode.endIndex);
      }
    }
  }

  return null;
}

function getImplementedInterfaces(node, source) {
  const heritageNode = node.childForFieldName("heritage");
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
  let isAbstract = false;

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
  const properties = [];
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
    if (member.type === "public_field_definition" || member.type === "property_signature") {
      const fieldInfo = extractFieldInfo(member, source);
      if (fieldInfo) {
        properties.push(fieldInfo);
      }
    }
  }

  return { constructorParams, methods, properties };
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
