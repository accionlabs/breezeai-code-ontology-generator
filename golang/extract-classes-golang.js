const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const fs = require("fs");
const path = require("path");

function extractClasses(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(Go);

  const tree = parser.parse(source);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "type_declaration") {
      // Check if it's a struct or interface type
      const typeSpec = node.childForFieldName("spec");
      if (typeSpec && typeSpec.type === "type_spec") {
        const classInfo = extractClassInfo(typeSpec, filePath, repoPath, source);
        if (classInfo?.name) {
          classes.push(classInfo);
        }
      }

      // Handle multiple type declarations in one block: type ( ... )
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "type_spec_list") {
          for (let j = 0; j < child.childCount; j++) {
            const spec = child.child(j);
            if (spec.type === "type_spec") {
              const classInfo = extractClassInfo(spec, filePath, repoPath, source);
              if (classInfo?.name) {
                classes.push(classInfo);
              }
            }
          }
        }
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

function extractClassInfo(typeSpec, filePath, repoPath = null, source) {
  const startLine = typeSpec.startPosition.row + 1;
  const endLine = typeSpec.endPosition.row + 1;

  const name = getTypeName(typeSpec, source);
  const typeNode = typeSpec.childForFieldName("type");

  if (!typeNode) return null;

  let type = "struct";
  let methods = [];
  let constructorParams = [];
  let interfaces = [];
  let visibility = "public";

  // Determine visibility based on name (Go convention)
  if (name && name[0] === name[0].toLowerCase()) {
    visibility = "private";
  }

  // Check if it's a struct or interface
  if (typeNode.type === "struct_type") {
    type = "struct";
    // Extract struct fields as constructor params
    constructorParams = extractStructFields(typeNode, source);
  } else if (typeNode.type === "interface_type") {
    type = "interface";
    // Extract interface methods
    methods = extractInterfaceMethods(typeNode, source);
  } else {
    // Could be a type alias, skip for now
    return null;
  }

  return {
    name,
    type,
    visibility,
    isAbstract: false, // Go doesn't have abstract types
    extends: null, // Go doesn't have inheritance
    implements: interfaces,
    constructorParams,
    methods,
    startLine,
    endLine
  };
}

function getTypeName(typeSpec, source) {
  const nameNode = typeSpec.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractStructFields(structNode, source) {
  const fields = [];

  for (let i = 0; i < structNode.childCount; i++) {
    const child = structNode.child(i);

    if (child.type === "field_declaration_list") {
      for (let j = 0; j < child.childCount; j++) {
        const field = child.child(j);

        if (field.type === "field_declaration") {
          const fieldNames = [];
          const nameNode = field.childForFieldName("name");

          if (nameNode) {
            // Single field name
            if (nameNode.type === "field_identifier") {
              fieldNames.push(source.slice(nameNode.startIndex, nameNode.endIndex));
            }
          } else {
            // Multiple field names in one declaration or embedded field
            for (let k = 0; k < field.childCount; k++) {
              const fn = field.child(k);
              if (fn.type === "field_identifier") {
                fieldNames.push(source.slice(fn.startIndex, fn.endIndex));
              }
            }
          }

          // If we found field names, add them
          if (fieldNames.length > 0) {
            fields.push(...fieldNames);
          } else {
            // Embedded field (anonymous field)
            const typeNode = field.childForFieldName("type");
            if (typeNode) {
              const typeName = source.slice(typeNode.startIndex, typeNode.endIndex);
              fields.push(`_embedded_${typeName.replace(/\*/g, '')}`);
            }
          }
        }
      }
    }
  }

  return fields;
}

function extractInterfaceMethods(interfaceNode, source) {
  const methods = [];

  for (let i = 0; i < interfaceNode.childCount; i++) {
    const child = interfaceNode.child(i);

    if (child.type === "method_spec_list") {
      for (let j = 0; j < child.childCount; j++) {
        const method = child.child(j);

        if (method.type === "method_spec") {
          const nameNode = method.childForFieldName("name");
          if (nameNode) {
            methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
          }
        } else if (method.type === "type_identifier") {
          // Embedded interface
          methods.push(`_embedded_${source.slice(method.startIndex, method.endIndex)}`);
        }
      }
    }
  }

  return methods;
}

module.exports = { extractClasses };
