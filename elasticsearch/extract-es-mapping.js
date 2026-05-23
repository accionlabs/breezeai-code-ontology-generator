/**
 * Parse an Elasticsearch mapping JSON file into a flat list of fields per index.
 *
 * Mapping file shape (one or more indices keyed at the top level):
 *   {
 *     "<indexName1>": { "mappings": { "properties": {...} }, "aliases": {...} },
 *     "<indexName2>": { ... }
 *   }
 *
 * Field tree is flattened to dotted paths. Multi-fields (text + fields.keyword)
 * become children of their parent via isMultiField=true. Nested/object types
 * keep their child properties as ESField rows whose parentPath points back.
 */

'use strict';

/**
 * Walk a `properties` block recursively and append rows to `out`.
 *
 * @param {object} properties - The ES "properties" object to walk
 * @param {string|null} parentPath - Dotted path to the parent field, or null at the root
 * @param {Array} out - Accumulator for emitted field rows
 */
function flattenProperties(properties, parentPath, out) {
  if (!properties || typeof properties !== 'object') return;

  for (const [name, def] of Object.entries(properties)) {
    if (!def || typeof def !== 'object') continue;

    const fullPath = parentPath ? `${parentPath}.${name}` : name;
    const type = def.type || (def.properties ? 'object' : null);
    const isNested = type === 'nested';
    const isObject = type === 'object' || (!def.type && !!def.properties);

    out.push({
      name,
      fullPath,
      parentPath: parentPath || null,
      type: type || 'unknown',
      analyzer: def.analyzer || null,
      searchAnalyzer: def.search_analyzer || null,
      format: def.format || null,
      copyTo: normalizeCopyTo(def.copy_to),
      index: def.index !== false,
      docValues: def.doc_values !== false,
      isNested,
      isObject: isObject && !isNested,
      isMultiField: false,
    });

    if (def.properties) {
      flattenProperties(def.properties, fullPath, out);
    }

    if (def.fields && typeof def.fields === 'object') {
      for (const [subName, subDef] of Object.entries(def.fields)) {
        if (!subDef || typeof subDef !== 'object') continue;
        const subPath = `${fullPath}.${subName}`;
        out.push({
          name: subName,
          fullPath: subPath,
          parentPath: fullPath,
          type: subDef.type || 'unknown',
          analyzer: subDef.analyzer || null,
          searchAnalyzer: subDef.search_analyzer || null,
          format: subDef.format || null,
          copyTo: normalizeCopyTo(subDef.copy_to),
          index: subDef.index !== false,
          docValues: subDef.doc_values !== false,
          isNested: false,
          isObject: false,
          isMultiField: true,
          ignoreAbove: typeof subDef.ignore_above === 'number' ? subDef.ignore_above : null,
        });
      }
    }
  }
}

function normalizeCopyTo(copyTo) {
  if (!copyTo) return [];
  if (Array.isArray(copyTo)) return copyTo;
  return [copyTo];
}

function extractAliases(body) {
  if (!body || !body.aliases || typeof body.aliases !== 'object') return [];
  return Object.entries(body.aliases).map(([name, def]) => ({
    name,
    filter: def && def.filter ? JSON.stringify(def.filter) : null,
    isWriteIndex: !!(def && def.is_write_index),
  }));
}

/**
 * @param {string} rawText - Raw file contents
 * @param {string} filePath - Source file path (for diagnostics)
 * @returns {Array<{indexName, fields, aliases}>}
 */
function parseESMappingFile(rawText, filePath) {
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`[es/mapping] failed to parse ${filePath}: ${err.message}`);
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`[es/mapping] ${filePath}: expected an object keyed by index name`);
  }

  const indices = [];
  for (const [indexName, body] of Object.entries(json)) {
    if (!body || typeof body !== 'object') continue;

    const props = body.mappings && body.mappings.properties
      ? body.mappings.properties
      : body.properties;

    const fields = [];
    if (props) {
      flattenProperties(props, null, fields);
    }

    indices.push({
      indexName,
      fields,
      aliases: extractAliases(body),
    });
  }

  return indices;
}

module.exports = { parseESMappingFile };
