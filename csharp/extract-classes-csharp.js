const Parser = require("tree-sitter");
const CSharp = require("tree-sitter-c-sharp");
const fs = require("fs");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(CSharp);

function extractClasses(filePath, repoPath = null, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "record_declaration" ||
      node.type === "enum_declaration"
    ) {
      const classInfo = extractClassInfo(node, filePath, repoPath, source, captureStatements);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

const CLASS_STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "enum_declaration"];

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
  const { superClass, interfaces } = getInheritanceInfo(node, source);
  const typeKind = getTypeKind(node);

  const {
    constructorParams,
    methods
  } = extractClassMembers(node, source, typeKind);

  const { visibility, isAbstract } = getClassModifiers(node, source);

  const statements = captureStatements ? extractClassStatements(node, source) : [];

  return {
    name,
    type: typeKind,
    visibility,
    isAbstract,
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    statements,
    startLine,
    endLine
  };
}

function getTypeKind(node) {
  switch (node.type) {
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "struct_declaration":
      return "struct";
    case "record_declaration":
      return "record";
    case "enum_declaration":
      return "enum";
    default:
      return "class";
  }
}

function getClassName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function getInheritanceInfo(node, source) {
  let superClass = null;
  const interfaces = [];

  // In C#, base_list contains both base class and interfaces
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "base_list") {
      let isFirstType = true;

      traverse(child, (n) => {
        if (n.type === "identifier" || n.type === "generic_name" || n.type === "qualified_name") {
          const typeName = source.slice(n.startIndex, n.endIndex);

          // Skip if we're inside a type argument list (generics)
          let parent = n.parent;
          while (parent && parent !== child) {
            if (parent.type === "type_argument_list") {
              return;
            }
            parent = parent.parent;
          }

          // In C#, the first type in base_list could be either a class or interface
          // For simplicity, we check if it looks like an interface (starts with I and uppercase)
          if (node.type === "class_declaration" && isFirstType && !typeName.match(/^I[A-Z]/)) {
            superClass = typeName;
          } else {
            interfaces.push(typeName);
          }
          isFirstType = false;
        }
      });
    }
  }

  return { superClass, interfaces };
}

function getClassModifiers(node, source) {
  let visibility = "internal"; // C# default
  let isAbstract = false;

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childText = source.slice(child.startIndex, child.endIndex);

    if (child.type === "modifier" || childText.match(/^(public|private|protected|internal|abstract)$/)) {
      if (childText === "public") {
        visibility = "public";
      } else if (childText === "private") {
        visibility = "private";
      } else if (childText === "protected") {
        visibility = "protected";
      } else if (childText === "internal") {
        visibility = "internal";
      } else if (childText === "abstract") {
        isAbstract = true;
      }
    }
  }

  return { visibility, isAbstract };
}

function extractClassMembers(classNode, source, typeKind) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methods: [] };
  }

  const methods = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // Constructor
    if (member.type === "constructor_declaration") {
      const paramsNode = member.childForFieldName("parameters");
      if (paramsNode) {
        constructorParams = extractParameterNames(paramsNode, source);
      }
      continue;
    }

    // Methods - just extract names
    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  }

  return { constructorParams, methods };
}

function extractParameterNames(paramsNode, source) {
  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (child.type === "parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        params.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  }

  return params;
}

function extractPropertyInfo(node, source) {
  // Get modifiers
  let visibility = "private";
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
    } else if (text === "internal") {
      visibility = "internal";
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
  const propType = typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : "object";

  // Check if has initializer
  let hasDefault = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "equals_value_clause") {
      hasDefault = true;
      break;
    }
  }

  return {
    name,
    type: propType,
    visibility,
    isStatic,
    isFinal: isReadonly,
    hasDefault,
    isProperty: true
  };
}

function extractFieldInfo(node, source) {
  const fields = [];

  // Get modifiers for all fields in this declaration
  let visibility = "private"; // C# default for fields
  let isStatic = false;
  let isReadonly = false;
  let isConst = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const text = source.slice(child.startIndex, child.endIndex);

    if (text === "public") {
      visibility = "public";
    } else if (text === "private") {
      visibility = "private";
    } else if (text === "protected") {
      visibility = "protected";
    } else if (text === "internal") {
      visibility = "internal";
    } else if (text === "static") {
      isStatic = true;
    } else if (text === "readonly") {
      isReadonly = true;
    } else if (text === "const") {
      isConst = true;
      isStatic = true; // const implies static in C#
    }
  }

  // Get type
  const typeNode = node.childForFieldName("type");
  const fieldType = typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : "object";

  // Get variable declarations
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "variable_declaration") {
      for (let j = 0; j < child.childCount; j++) {
        const declarator = child.child(j);
        if (declarator.type === "variable_declarator") {
          const nameNode = declarator.childForFieldName("name");
          if (!nameNode) continue;

          const name = source.slice(nameNode.startIndex, nameNode.endIndex);

          // Check if has default value
          let hasDefault = false;
          for (let k = 0; k < declarator.childCount; k++) {
            if (declarator.child(k).type === "equals_value_clause") {
              hasDefault = true;
              break;
            }
          }

          fields.push({
            name,
            type: fieldType,
            visibility,
            isStatic,
            isFinal: isReadonly || isConst,
            hasDefault,
            isProperty: false
          });
        }
      }
    }
  }

  return fields;
}

module.exports = { extractClasses };
