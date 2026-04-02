/**
 * Oracle DDL Parser
 * Parses Oracle SQL DDL files and extracts structured schema information.
 *
 * Supports:
 *   - CREATE TABLE (columns, inline + table-level constraints)
 *   - CREATE OR REPLACE VIEW
 *   - CREATE OR REPLACE PROCEDURE / FUNCTION
 *   - CREATE [UNIQUE|BITMAP] INDEX
 *   - COMMENT ON TABLE / COLUMN
 *   - ALTER TABLE … ADD CONSTRAINT (FK / PK / UNIQUE / CHECK)
 */

'use strict';

// -----------------------------------------------------------
// Statement splitter
// -----------------------------------------------------------

/**
 * Split raw DDL text into individual SQL statements.
 * Handles nested parentheses, string literals, and line/block comments.
 * Splits on `;` at depth 0, but also handles PL/SQL block terminators (`/` on its own line).
 */
function splitStatements(ddlText) {
  const statements = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;
  const len = ddlText.length;

  while (i < len) {
    const ch = ddlText[i];

    // Block comment /* ... */
    if (!inString && ch === '/' && ddlText[i + 1] === '*') {
      const end = ddlText.indexOf('*/', i + 2);
      if (end === -1) { i = len; continue; }
      current += ddlText.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Line comment -- ...
    if (!inString && ch === '-' && ddlText[i + 1] === '-') {
      const end = ddlText.indexOf('\n', i);
      const lineEnd = end === -1 ? len : end + 1;
      current += ddlText.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }

    // String literals: single-quoted with '' escaping
    if (!inString && ch === "'") {
      inString = true;
      stringChar = "'";
      current += ch;
      i++;
      continue;
    }
    if (inString && ch === stringChar) {
      current += ch;
      i++;
      // Oracle uses '' for escaped single quote
      if (i < len && ddlText[i] === stringChar) {
        current += ddlText[i];
        i++;
      } else {
        inString = false;
      }
      continue;
    }

    if (!inString) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;

      if (ch === ';' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = '';
        i++;
        continue;
      }

      // PL/SQL block terminator: '/' alone on a line
      if (ch === '/' && depth === 0) {
        // Check it's on its own line (only whitespace before/after on same line)
        const lineStart = ddlText.lastIndexOf('\n', i - 1) + 1;
        const lineEnd = ddlText.indexOf('\n', i);
        const line = ddlText.slice(lineStart, lineEnd === -1 ? len : lineEnd).trim();
        if (line === '/') {
          const trimmed = current.trim();
          if (trimmed) statements.push(trimmed);
          current = '';
          i = lineEnd === -1 ? len : lineEnd + 1;
          continue;
        }
      }
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}

// -----------------------------------------------------------
// Column definition parser
// -----------------------------------------------------------

/**
 * Oracle data types with their parameter structure.
 * Returns { dataType, length, precision, scale, charSemantics }
 */
function parseDataType(typeStr) {
  if (!typeStr) return { dataType: typeStr };

  // Match type with optional params: NUMBER(10,2), VARCHAR2(200 CHAR), TIMESTAMP(6)
  const m = typeStr.match(/^(\w+(?:\s+\w+)*?)\s*(?:\(([^)]+)\))?$/i);
  if (!m) return { dataType: typeStr.toUpperCase() };

  const typeName = m[1].toUpperCase().replace(/\s+/g, ' ');
  const params = m[2] ? m[2].trim() : null;

  let length = null, precision = null, scale = null, charSemantics = null;

  if (params) {
    if (typeName === 'NUMBER' || typeName === 'FLOAT' || typeName === 'DECIMAL' || typeName === 'NUMERIC') {
      const parts = params.split(',').map(s => s.trim());
      precision = parseInt(parts[0], 10) || null;
      scale = parts.length > 1 ? (parseInt(parts[1], 10) || 0) : null;
    } else if (typeName === 'VARCHAR2' || typeName === 'NVARCHAR2' || typeName === 'CHAR' || typeName === 'NCHAR' || typeName === 'RAW') {
      // May include CHAR or BYTE semantics: VARCHAR2(200 CHAR)
      const charMatch = params.match(/^(\d+)\s*(CHAR|BYTE)?$/i);
      if (charMatch) {
        length = parseInt(charMatch[1], 10) || null;
        charSemantics = charMatch[2] ? charMatch[2].toUpperCase() : null;
      }
    } else if (typeName === 'TIMESTAMP' || typeName === 'TIMESTAMP WITH TIME ZONE' || typeName === 'TIMESTAMP WITH LOCAL TIME ZONE') {
      precision = parseInt(params, 10) || null;
    } else {
      length = parseInt(params, 10) || null;
    }
  }

  return { dataType: typeName, length, precision, scale, charSemantics };
}

/**
 * Extract the default value expression from a column definition fragment.
 * Handles: DEFAULT SYSDATE, DEFAULT 0, DEFAULT 'N', DEFAULT (expr)
 */
function extractDefault(fragment) {
  // DEFAULT is followed by value up to next constraint keyword or end
  const m = fragment.match(/\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|CONSTRAINT|CHECK|UNIQUE|PRIMARY\s+KEY|REFERENCES|ENABLE|DISABLE|VISIBLE|INVISIBLE|ENCRYPT)|\s*$)/i);
  if (!m) return null;
  return m[1].trim().replace(/^'(.*)'$/, '$1'); // strip surrounding quotes
}

/**
 * Extract inline CHECK expression.
 */
function extractInlineCheck(fragment) {
  const m = fragment.match(/\bCHECK\s*\((.+)\)/i);
  return m ? m[1].trim() : null;
}

/**
 * Split the body of a CREATE TABLE (...) into individual column/constraint tokens,
 * respecting nested parentheses (e.g. NUMBER(10,2), CHECK(x > 0)).
 */
function splitColumnDefs(body) {
  const items = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      const t = current.trim();
      if (t) items.push(t);
      current = '';
      continue;
    }
    current += ch;
  }
  const t = current.trim();
  if (t) items.push(t);
  return items;
}

/**
 * Parse a single column definition.
 * Returns a column object or null if not a column (e.g. constraint line).
 */
function parseColumnDef(def) {
  def = def.trim();

  // Skip table-level constraints (they start with CONSTRAINT, PRIMARY, UNIQUE, FOREIGN, CHECK)
  if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(def)) return null;

  // Column: name type [options...]
  // Name is the first token (possibly quoted)
  const nameMatch = def.match(/^"?([A-Z_][A-Z0-9_$#]*)"?\s+(.+)/i);
  if (!nameMatch) return null;

  const name = nameMatch[1].toUpperCase();
  const rest = nameMatch[2];

  // Extract data type (everything up to first constraint keyword or end)
  const typeEndMatch = rest.match(/^([^(,]+(?:\([^)]*\))?(?:\s+(?:WITH\s+TIME\s+ZONE|WITH\s+LOCAL\s+TIME\s+ZONE))?)/i);
  let typeStr = typeEndMatch ? typeEndMatch[0].trim() : rest.trim();

  // Trim off constraint keywords that leaked into typeStr
  typeStr = typeStr.replace(/\s+(NOT\s+NULL|NULL|DEFAULT|CONSTRAINT|PRIMARY|UNIQUE|CHECK|REFERENCES|GENERATED|ENABLE|DISABLE|VISIBLE|INVISIBLE|ENCRYPT).*$/i, '').trim();

  const { dataType, length, precision, scale, charSemantics } = parseDataType(typeStr);

  const nullable = /\bNOT\s+NULL\b/i.test(rest) ? false : true;
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
  const isUnique = /\bUNIQUE\b/i.test(rest);
  const defaultValue = extractDefault(rest);
  const checkExpression = extractInlineCheck(rest);

  const col = {
    name,
    dataType: dataType || 'UNKNOWN',
    nullable,
    isPrimaryKey,
    isUnique,
    isForeignKey: false,
    isIndexed: false,
  };

  if (length !== null) col.length = length;
  if (precision !== null) col.precision = precision;
  if (scale !== null) col.scale = scale;
  if (charSemantics) col.charSemantics = charSemantics;
  if (defaultValue !== null) col.defaultValue = defaultValue;
  if (checkExpression) col.checkExpression = checkExpression;

  return col;
}

/**
 * Parse a table-level CONSTRAINT definition.
 */
function parseTableConstraint(def, tableName) {
  def = def.trim();

  // Named constraint: CONSTRAINT name <type>
  let constraintName = null;
  const namedMatch = def.match(/^CONSTRAINT\s+"?([A-Z_][A-Z0-9_$#]*)"?\s+/i);
  if (namedMatch) {
    constraintName = namedMatch[1].toUpperCase();
    def = def.slice(namedMatch[0].length);
  }

  const constraint = { name: constraintName, tableName: tableName.toUpperCase() };

  // PRIMARY KEY (cols)
  const pkMatch = def.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  if (pkMatch) {
    constraint.constraintType = 'PRIMARY_KEY';
    constraint.columns = splitColList(pkMatch[1]);
    return constraint;
  }

  // UNIQUE (cols)
  const uqMatch = def.match(/^UNIQUE\s*\(([^)]+)\)/i);
  if (uqMatch) {
    constraint.constraintType = 'UNIQUE';
    constraint.columns = splitColList(uqMatch[1]);
    return constraint;
  }

  // FOREIGN KEY (cols) REFERENCES ref_table (ref_cols) [ON DELETE action]
  const fkMatch = def.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+"?(\w+)"?\."?(\w+)"?\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+(\w+(?:\s+\w+)?))?/i)
    || def.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+"?(\w+)"?\s*(?:\(([^)]+)\))?(?:\s+ON\s+DELETE\s+(\w+(?:\s+\w+)?))?/i);
  if (fkMatch) {
    constraint.constraintType = 'FOREIGN_KEY';
    if (fkMatch.length === 6) {
      // schema.table match
      constraint.columns = splitColList(fkMatch[1]);
      constraint.refTableOwner = fkMatch[2].toUpperCase();
      constraint.refTableName = fkMatch[3].toUpperCase();
      constraint.refColumns = fkMatch[4] ? splitColList(fkMatch[4]) : [];
      constraint.onDelete = fkMatch[5] ? fkMatch[5].toUpperCase() : null;
    } else {
      constraint.columns = splitColList(fkMatch[1]);
      constraint.refTableName = fkMatch[2].toUpperCase();
      constraint.refColumns = fkMatch[3] ? splitColList(fkMatch[3]) : [];
      constraint.onDelete = fkMatch[4] ? fkMatch[4].toUpperCase() : null;
    }
    return constraint;
  }

  // CHECK (expression)
  const checkMatch = def.match(/^CHECK\s*\((.+)\)(?:\s+ENABLE)?(?:\s+DISABLE)?(?:\s+VALIDATE)?(?:\s+NOVALIDATE)?/i);
  if (checkMatch) {
    constraint.constraintType = 'CHECK';
    constraint.checkExpression = checkMatch[1].trim();
    // Oracle-specific options
    const enabledMatch = def.match(/\b(ENABLE|DISABLE)\b/i);
    constraint.enabled = enabledMatch ? enabledMatch[1].toUpperCase() === 'ENABLE' : true;
    const validatedMatch = def.match(/\b(VALIDATE|NOVALIDATE)\b/i);
    constraint.validated = validatedMatch ? validatedMatch[1].toUpperCase() === 'VALIDATE' : true;
    return constraint;
  }

  return null; // unrecognized
}

function splitColList(str) {
  return str.split(',').map(s => s.trim().replace(/"/g, '').toUpperCase()).filter(Boolean);
}

// -----------------------------------------------------------
// CREATE TABLE parser
// -----------------------------------------------------------

/**
 * Parse a CREATE TABLE statement.
 */
function parseCreateTable(stmt) {
  // CREATE [GLOBAL TEMPORARY] TABLE [schema.]name (body) [options]
  const headerMatch = stmt.match(
    /^CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\s+"?(?:(\w+)"?\."?)?(\w+)"?\s*\(/i
  );
  if (!headerMatch) return null;

  const owner = headerMatch[1] ? headerMatch[1].toUpperCase() : null;
  const name = headerMatch[2].toUpperCase();
  const fullName = owner ? `${owner}.${name}` : name;

  // Extract the table body (outermost parens)
  const bodyStart = stmt.indexOf('(');
  const bodyEnd = findMatchingParen(stmt, bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) return null;

  const body = stmt.slice(bodyStart + 1, bodyEnd);

  // Check if TEMPORARY
  const tableType = /GLOBAL\s+TEMPORARY/i.test(stmt) ? 'temporary' : 'table';

  const columnDefs = splitColumnDefs(body);

  const columns = [];
  const constraints = [];

  for (const def of columnDefs) {
    if (/^(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b)/i.test(def.trim())) {
      const constraint = parseTableConstraint(def, name);
      if (constraint) constraints.push(constraint);
    } else {
      const col = parseColumnDef(def);
      if (col) columns.push(col);
    }
  }

  // Mark columns referenced by PK
  const pkConstraint = constraints.find(c => c.constraintType === 'PRIMARY_KEY');
  if (pkConstraint) {
    for (const col of columns) {
      if (pkConstraint.columns.includes(col.name)) col.isPrimaryKey = true;
    }
  }

  // Mark FK columns
  for (const con of constraints) {
    if (con.constraintType === 'FOREIGN_KEY') {
      for (const col of columns) {
        if (con.columns.includes(col.name)) col.isForeignKey = true;
      }
    }
  }

  // Truncate DDL text
  const ddlText = stmt.slice(0, 1000) + (stmt.length > 1000 ? '\n-- [truncated]' : '');

  return {
    name,
    owner,
    fullName,
    tableType,
    columnCount: columns.length,
    hasPrimaryKey: columns.some(c => c.isPrimaryKey) || !!pkConstraint,
    columns,
    constraints,
    ddlText,
  };
}

// -----------------------------------------------------------
// CREATE VIEW parser
// -----------------------------------------------------------

function parseCreateView(stmt) {
  // CREATE [OR REPLACE] [FORCE|NOFORCE] VIEW [schema.]name [(col_list)] AS ...
  const m = stmt.match(
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+|NOFORCE\s+)?(?:MATERIALIZED\s+)?VIEW\s+"?(?:(\w+)"?\."?)?(\w+)"?\s*(?:\(([^)]*)\))?\s+AS\s+([\s\S]+)/i
  );
  if (!m) return null;

  const owner = m[1] ? m[1].toUpperCase() : null;
  const name = m[2].toUpperCase();
  const fullName = owner ? `${owner}.${name}` : name;
  const columnList = m[3] ? splitColList(m[3]) : [];
  const definition = m[4] ? m[4].trim().slice(0, 1000) : null;
  const isMatView = /MATERIALIZED\s+VIEW/i.test(stmt);

  return {
    name,
    owner,
    fullName,
    viewType: isMatView ? 'materialized_view' : 'view',
    definition,
    columns: columnList,
  };
}

// -----------------------------------------------------------
// CREATE PROCEDURE / FUNCTION parser
// -----------------------------------------------------------

function parseCreateProcedure(stmt) {
  // CREATE [OR REPLACE] PROCEDURE|FUNCTION [schema.]name [(params)] [RETURN type] AS|IS ...
  const m = stmt.match(
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER)\s+"?(?:(\w+)"?\."?)?(\w+)"?\s*([\s\S]*)/i
  );
  if (!m) return null;

  const procType = m[1].toUpperCase().replace(/\s+/, '_');
  const owner = m[2] ? m[2].toUpperCase() : null;
  const name = m[3].toUpperCase();
  const fullName = owner ? `${owner}.${name}` : name;
  const rest = m[4] || '';

  // Extract parameters if present
  const parameters = [];
  const parenStart = rest.indexOf('(');
  if (parenStart !== -1 && procType !== 'PACKAGE_BODY' && procType !== 'PACKAGE') {
    const parenEnd = findMatchingParen(rest, parenStart);
    if (parenEnd !== -1) {
      const paramStr = rest.slice(parenStart + 1, parenEnd);
      // Split params by comma at depth 0
      const paramDefs = splitColumnDefs(paramStr);
      for (const pd of paramDefs) {
        const pm = pd.trim().match(/^"?(\w+)"?\s+(IN\s+OUT|IN|OUT)?\s*(.+?)(?:\s+DEFAULT\s+.*)?$/i);
        if (pm) {
          parameters.push({
            name: pm[1].toUpperCase(),
            direction: pm[2] ? pm[2].toUpperCase().replace(/\s+/, ' ') : 'IN',
            dataType: pm[3].trim().toUpperCase(),
          });
        }
      }
    }
  }

  // Extract RETURN type for functions
  let returnType = null;
  if (procType === 'FUNCTION') {
    const retMatch = rest.match(/\bRETURN\s+(\w+(?:\s*\(\d+\))?)/i);
    if (retMatch) returnType = retMatch[1].toUpperCase();
  }

  const body = stmt.slice(0, 1000) + (stmt.length > 1000 ? '\n-- [truncated]' : '');

  const typeLower = procType.toLowerCase().replace('_', ' ');

  return {
    name,
    owner,
    fullName,
    procedureType: typeLower,
    parameters,
    returnType,
    body,
  };
}

// -----------------------------------------------------------
// CREATE INDEX parser
// -----------------------------------------------------------

function parseCreateIndex(stmt) {
  // CREATE [UNIQUE|BITMAP] INDEX [schema.]name ON [schema.]table (cols) [options]
  const m = stmt.match(
    /^CREATE\s+(UNIQUE\s+|BITMAP\s+)?INDEX\s+"?(?:(\w+)"?\."?)?(\w+)"?\s+ON\s+"?(?:(\w+)"?\."?)?(\w+)"?\s*\(([^)]+)\)(?:\s+(.*))?/i
  );
  if (!m) return null;

  const indexModifier = m[1] ? m[1].trim().toUpperCase() : null;
  const indexName = m[3].toUpperCase();
  const tableOwner = m[4] ? m[4].toUpperCase() : null;
  const tableName = m[5].toUpperCase();
  const tableFullName = tableOwner ? `${tableOwner}.${tableName}` : tableName;
  const colStr = m[6];
  const options = m[7] || '';

  const columns = splitColList(colStr);

  // Detect function-based (expression in columns)
  const isFunctionBased = columns.some(c => /[()+ -]/.test(c));

  let indexType = 'BTREE';
  if (indexModifier === 'BITMAP') indexType = 'BITMAP';
  else if (isFunctionBased) indexType = 'FUNCTION_BASED';

  // Tablespace
  const tsMatch = options.match(/\bTABLESPACE\s+(\w+)/i);
  const tablespace = tsMatch ? tsMatch[1].toUpperCase() : null;

  return {
    name: indexName,
    tableName,
    tableFullName,
    columns,
    isUnique: indexModifier === 'UNIQUE',
    indexType,
    tablespace,
    whereClause: isFunctionBased ? colStr.trim() : null,
  };
}

// -----------------------------------------------------------
// COMMENT ON parser
// -----------------------------------------------------------

function parseComment(stmt) {
  // COMMENT ON TABLE [schema.]name IS 'text'
  const tableMatch = stmt.match(
    /^COMMENT\s+ON\s+TABLE\s+"?(?:(\w+)"?\."?)?(\w+)"?\s+IS\s+'((?:[^']|'')*)'/i
  );
  if (tableMatch) {
    return {
      target: 'table',
      owner: tableMatch[1] ? tableMatch[1].toUpperCase() : null,
      name: tableMatch[2].toUpperCase(),
      comment: tableMatch[3].replace(/''/g, "'"),
    };
  }

  // COMMENT ON COLUMN [schema.]table.column IS 'text'
  const colMatch = stmt.match(
    /^COMMENT\s+ON\s+COLUMN\s+"?(?:(\w+)"?\."?)?(\w+)"?\."?(\w+)"?\s+IS\s+'((?:[^']|'')*)'/i
  );
  if (colMatch) {
    return {
      target: 'column',
      owner: colMatch[1] ? colMatch[1].toUpperCase() : null,
      tableName: colMatch[2].toUpperCase(),
      columnName: colMatch[3].toUpperCase(),
      comment: colMatch[4].replace(/''/g, "'"),
    };
  }

  return null;
}

// -----------------------------------------------------------
// ALTER TABLE … ADD CONSTRAINT parser
// -----------------------------------------------------------

function parseAlterTableConstraint(stmt) {
  const m = stmt.match(/^ALTER\s+TABLE\s+"?(?:(\w+)"?\."?)?(\w+)"?\s+ADD\s+(.*)/is);
  if (!m) return null;

  const owner = m[1] ? m[1].toUpperCase() : null;
  const tableName = m[2].toUpperCase();
  const addClause = m[3].trim();

  const constraint = parseTableConstraint(addClause, tableName);
  if (!constraint) return null;

  return { tableName, owner, constraint };
}

// -----------------------------------------------------------
// Utility
// -----------------------------------------------------------

function findMatchingParen(str, openPos) {
  let depth = 0;
  for (let i = openPos; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// -----------------------------------------------------------
// Main parser entry point
// -----------------------------------------------------------

/**
 * Parse an Oracle DDL file and return structured data.
 *
 * @param {string} ddlText - Full content of the .sql DDL file
 * @returns {{ tables, views, procedures, indexes, comments }}
 */
function parseOracleDDL(ddlText) {
  const statements = splitStatements(ddlText);

  const tables = [];
  const views = [];
  const procedures = [];
  const indexes = [];
  const commentMap = { tables: {}, columns: {} };

  const tableMap = {}; // name → table object, for post-processing comments

  for (const stmt of statements) {
    // Strip leading line comments (-- ...) to find the first keyword
    const stripped = stmt.replace(/^(\s*--[^\n]*\n)+\s*/g, '').trimStart();
    const upper = stripped.toUpperCase();

    if (upper.startsWith('CREATE') && /CREATE\s+(?:GLOBAL\s+TEMPORARY\s+)?TABLE\b/i.test(stripped)) {
      const t = parseCreateTable(stripped);
      if (t) {
        tables.push(t);
        tableMap[t.name] = t;
        if (t.owner) tableMap[t.fullName] = t;
      }
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+|NOFORCE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.test(stripped)) {
      const v = parseCreateView(stripped);
      if (v) views.push(v);
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b/i.test(stripped)) {
      const p = parseCreateProcedure(stripped);
      if (p) procedures.push(p);
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:UNIQUE\s+|BITMAP\s+)?INDEX\b/i.test(stripped)) {
      const idx = parseCreateIndex(stripped);
      if (idx) indexes.push(idx);
    } else if (upper.startsWith('COMMENT')) {
      const c = parseComment(stripped);
      if (c) {
        if (c.target === 'table') {
          commentMap.tables[c.name] = c.comment;
          if (c.owner) commentMap.tables[`${c.owner}.${c.name}`] = c.comment;
        } else if (c.target === 'column') {
          const key = `${c.tableName}.${c.columnName}`;
          commentMap.columns[key] = c.comment;
        }
      }
    } else if (upper.startsWith('ALTER')) {
      const alt = parseAlterTableConstraint(stripped);
      if (alt) {
        const existing = tableMap[alt.tableName] || tableMap[`${alt.owner}.${alt.tableName}`];
        if (existing) {
          existing.constraints.push(alt.constraint);
          // Update column flags
          if (alt.constraint.constraintType === 'FOREIGN_KEY') {
            for (const col of existing.columns) {
              if (alt.constraint.columns.includes(col.name)) col.isForeignKey = true;
            }
          }
          if (alt.constraint.constraintType === 'PRIMARY_KEY') {
            for (const col of existing.columns) {
              if (alt.constraint.columns.includes(col.name)) col.isPrimaryKey = true;
            }
            existing.hasPrimaryKey = true;
          }
        }
      }
    }
  }

  // Apply comments to tables and columns
  for (const table of tables) {
    const tc = commentMap.tables[table.name] || commentMap.tables[table.fullName];
    if (tc) table.comment = tc;

    for (const col of table.columns) {
      const cc = commentMap.columns[`${table.name}.${col.name}`];
      if (cc) col.comment = cc;
    }
  }

  // Apply indexes to columns (mark isIndexed)
  for (const idx of indexes) {
    const table = tableMap[idx.tableName] || tableMap[idx.tableFullName];
    if (table) {
      for (const col of table.columns) {
        if (idx.columns.includes(col.name)) col.isIndexed = true;
      }
      // Attach index to table
      if (!table.indexes) table.indexes = [];
      table.indexes.push(idx);
    }
  }

  // Ensure all tables have an indexes array
  for (const table of tables) {
    if (!table.indexes) table.indexes = [];
  }

  // Add ordinalPosition to columns
  for (const table of tables) {
    table.columns.forEach((col, i) => { col.ordinalPosition = i + 1; });
    table.columnCount = table.columns.length;
  }

  // Build standalone indexes list (those not attached to a table in this file)
  const standaloneIndexes = indexes.filter(idx => !tableMap[idx.tableName] && !tableMap[idx.tableFullName]);

  return { tables, views, procedures, indexes: standaloneIndexes, allIndexes: indexes };
}

module.exports = { parseOracleDDL };
