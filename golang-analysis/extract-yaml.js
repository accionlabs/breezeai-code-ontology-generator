/**
 * YAML File Parser (OpenAPI/Swagger specs, configs)
 * Extracts API definitions, endpoints, schemas
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Extract YAML file information
 */
function extractYamlFile(filePath, repoPath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(repoPath, filePath);
  
  try {
    const data = yaml.load(content);
    
    // Determine YAML type
    const yamlType = detectYamlType(data, relativePath);
    
    const result = {
      path: relativePath,
      type: yamlType,
      content: extractRelevantContent(data, yamlType)
    };
    
    return result;
  } catch (error) {
    return {
      path: relativePath,
      type: 'yaml',
      error: error.message,
      content: null
    };
  }
}

function detectYamlType(data, filepath) {
  if (data.openapi || data.swagger) {
    return 'openapi';
  } else if (data.paths || filepath.includes('swagger')) {
    return 'openapi_component';
  } else if (data.indexes || filepath.includes('index.yaml')) {
    return 'index';
  }
  return 'yaml_config';
}

function extractRelevantContent(data, yamlType) {
  if (yamlType === 'openapi' || yamlType === 'openapi_component') {
    return extractOpenAPIInfo(data);
  } else if (yamlType === 'index') {
    return extractIndexInfo(data);
  }
  return {
    raw: JSON.parse(JSON.stringify(data).substring(0, 500)) // First 500 chars
  };
}

function extractOpenAPIInfo(data) {
  const info = {
    version: data.openapi || data.swagger,
    title: data.info?.title || null,
    version: data.info?.version || null,
    paths: {},
    components: {}
  };
  
  // Extract paths/endpoints
  if (data.paths) {
    for (const [pathName, pathData] of Object.entries(data.paths)) {
      info.paths[pathName] = {};
      for (const [method, methodData] of Object.entries(pathData)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
          info.paths[pathName][method] = {
            summary: methodData.summary || null,
            operationId: methodData.operationId || null,
            tags: methodData.tags || []
          };
        }
      }
    }
  }
  
  // Extract components/schemas
  if (data.components) {
    if (data.components.schemas) {
      info.components.schemas = Object.keys(data.components.schemas);
    }
    if (data.components.parameters) {
      info.components.parameters = Object.keys(data.components.parameters);
    }
  }
  
  // Extract schemas (Swagger 2.0)
  if (data.definitions) {
    info.components.schemas = Object.keys(data.definitions);
  }
  
  return info;
}

function extractIndexInfo(data) {
  return {
    indexes: data.indexes || [],
    kind: data.kind || null
  };
}

module.exports = {
  extractYamlFile
};
