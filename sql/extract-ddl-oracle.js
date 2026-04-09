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
/**
 * True if `buffer` (the in-progress statement so far) looks like the head of a
 * PL/SQL block. Used by splitStatements to keep semicolons inside the block.
 */
function isPlSqlBlockStart(buffer) {
  // Strip leading whitespace + line comments to find the first keyword.
  const head = buffer.replace(/^(?:\s|--[^\n]*\n)+/, '').toUpperCase();
  if (!head) return false;
  if (/^DECLARE\b/.test(head)) return true;
  // A bare `BEGIN` with no body yet is a Postgres-style transaction marker
  // (`BEGIN;`), not a PL/SQL block. Treat as PL/SQL only when there is some
  // body content following the BEGIN keyword.
  if (/^BEGIN\b\s*\S/.test(head)) return true;
  if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE\s+BODY)\b/.test(head)) {
    return true;
  }
  return false;
}

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

    // Oracle q-quote literal: q'X...X' or Q'X...X' where X is a delimiter.
    // Bracket pairs use the matching closer: q'[...]', q'<...>', q'(...)' , q'{...}'.
    // Any other char is its own terminator: q'!...!'.
    if (!inString && (ch === 'q' || ch === 'Q') && ddlText[i + 1] === "'") {
      const opener = ddlText[i + 2];
      if (opener !== undefined) {
        const closer =
          opener === '[' ? ']' :
          opener === '<' ? '>' :
          opener === '(' ? ')' :
          opener === '{' ? '}' : opener;
        const search = closer + "'";
        const end = ddlText.indexOf(search, i + 3);
        if (end !== -1) {
          current += ddlText.slice(i, end + 2);
          i = end + 2;
          continue;
        }
      }
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
        // Inside a PL/SQL block (CREATE PROCEDURE / FUNCTION / TRIGGER / PACKAGE
        // or a bare DECLARE/BEGIN block) semicolons are statement terminators
        // *inside* the block — they don't end the outer DDL. Only the `/`
        // sentinel on its own line ends the block. Detect by inspecting the
        // start of `current`.
        if (isPlSqlBlockStart(current)) {
          current += ch;
          i++;
          continue;
        }
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
// Identifier helpers
// -----------------------------------------------------------

// Regex source for an Oracle identifier: either a double-quoted name (case
// preserved, may contain escaped "" inside) or a bare identifier.
const IDENT_RE_SRC = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)';

/**
 * Normalize an Oracle identifier to its canonical form, applying Oracle's
 * case-folding rules:
 *   - "MyCol"  → MyCol   (preserved, case-sensitive)
 *   - mycol    → MYCOL   (Oracle uppercases unquoted identifiers internally)
 *   - "MYCOL"  → MYCOL   (matches the unquoted form, as Oracle does)
 *
 * Strings already without surrounding quotes are treated as unquoted (i.e.
 * uppercased) so the helper is safe to call on raw regex captures.
 */
function unquoteIdent(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s.toUpperCase();
}

/**
 * Split a comma-separated identifier list, applying unquoteIdent to each entry.
 */
function splitColList(str) {
  if (!str) return [];
  // Identifiers can contain commas only inside double quotes, which is rare;
  // we still tolerate it by tracking quote state during the split.
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (ch === ',' && !inQuote) {
      const t = cur.trim();
      if (t) out.push(unquoteIdent(t));
      cur = '';
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) out.push(unquoteIdent(t));
  return out;
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
 * Returns the expression verbatim (including any surrounding quotes for string
 * literals) and tags it with `kind` so downstream consumers can distinguish a
 * literal from a function call or general expression.
 *
 * Handles: DEFAULT SYSDATE, DEFAULT 0, DEFAULT 'N', DEFAULT (expr),
 *          DEFAULT TO_DATE('2020-01-01','YYYY-MM-DD')
 *
 * The match is paren-aware so multi-token expressions with embedded commas
 * (e.g. function calls) are captured in full.
 */
function extractDefault(fragment) {
  const re = /\bDEFAULT\b/i;
  const m = re.exec(fragment);
  if (!m) return null;
  let i = m.index + m[0].length;
  // Skip whitespace
  while (i < fragment.length && /\s/.test(fragment[i])) i++;

  // ON NULL is an Oracle 12c modifier: DEFAULT ON NULL <expr>
  if (/^ON\s+NULL\b/i.test(fragment.slice(i))) {
    i += fragment.slice(i).match(/^ON\s+NULL\s*/i)[0].length;
  }

  // Now consume the expression. Track parens; stop at depth 0 when we hit a
  // constraint keyword or end of fragment.
  const STOP = /^(NOT\s+NULL|NULL|CONSTRAINT|CHECK|UNIQUE|PRIMARY\s+KEY|REFERENCES|ENABLE|DISABLE|VISIBLE|INVISIBLE|ENCRYPT|GENERATED)\b/i;
  let depth = 0;
  let inStr = false;
  let buf = '';
  while (i < fragment.length) {
    const ch = fragment[i];
    if (inStr) {
      buf += ch;
      i++;
      if (ch === "'") {
        if (fragment[i] === "'") { buf += "'"; i++; } // escaped quote
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; buf += ch; i++; continue; }
    if (ch === '(') { depth++; buf += ch; i++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      buf += ch;
      i++;
      continue;
    }
    if (depth === 0 && /\s/.test(ch)) {
      // Look ahead to see if a stop keyword starts here
      const rest = fragment.slice(i + 1);
      if (STOP.test(rest)) break;
    }
    buf += ch;
    i++;
  }

  const value = buf.trim().replace(/,$/, '');
  if (!value) return null;

  let kind;
  if (/^'.*'$/.test(value) || /^N'.*'$/i.test(value)) kind = 'literal';
  else if (/^-?\d+(\.\d+)?$/.test(value)) kind = 'literal';
  else if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(value)) kind = 'function_call';
  else if (/^(SYSDATE|SYSTIMESTAMP|CURRENT_DATE|CURRENT_TIMESTAMP|USER|UID|NULL|TRUE|FALSE)$/i.test(value)) kind = 'pseudo_column';
  else kind = 'expression';

  return { value, kind };
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
 *
 * Returns `{ column, inlineConstraints }` or null if the line is a table-level
 * constraint (which the caller routes to parseTableConstraint instead).
 *
 * `inlineConstraints` contains any FOREIGN_KEY / CHECK / UNIQUE / PRIMARY_KEY
 * constraints declared inline on the column, normalized to the same shape as
 * table-level constraints so the graph consumer doesn't need to special-case
 * inline vs out-of-line.
 */
function parseColumnDef(def, tableName) {
  def = def.trim();

  // Skip table-level constraints (they start with CONSTRAINT, PRIMARY, UNIQUE, FOREIGN, CHECK)
  if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(def)) return null;

  // Column: name type [options...]   (name may be a quoted identifier)
  const nameRe = new RegExp('^(' + IDENT_RE_SRC + ')\\s+([\\s\\S]+)');
  const nameMatch = def.match(nameRe);
  if (!nameMatch) return null;

  const name = unquoteIdent(nameMatch[1]);
  const rest = nameMatch[2];

  // Extract data type (everything up to first constraint keyword or end)
  const typeEndMatch = rest.match(/^([^(,]+(?:\([^)]*\))?(?:\s+(?:WITH\s+TIME\s+ZONE|WITH\s+LOCAL\s+TIME\s+ZONE))?)/i);
  let typeStr = typeEndMatch ? typeEndMatch[0].trim() : rest.trim();

  // Trim off constraint keywords that leaked into typeStr
  typeStr = typeStr.replace(/\s+(NOT\s+NULL|NULL|DEFAULT|CONSTRAINT|PRIMARY|UNIQUE|CHECK|REFERENCES|GENERATED|ENABLE|DISABLE|VISIBLE|INVISIBLE|ENCRYPT|AS\b).*$/i, '').trim();

  const { dataType, length, precision, scale, charSemantics } = parseDataType(typeStr);

  const nullable = /\bNOT\s+NULL\b/i.test(rest) ? false : true;
  const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
  const isUnique = /\bUNIQUE\b/i.test(rest);
  const defaultInfo = extractDefault(rest);
  const checkExpression = extractInlineCheck(rest);

  // Identity columns: GENERATED [ALWAYS|BY DEFAULT [ON NULL]] AS IDENTITY
  let isIdentity = false;
  let identityGeneration = null;
  const identMatch = rest.match(/\bGENERATED\s+(ALWAYS|BY\s+DEFAULT(?:\s+ON\s+NULL)?)\s+AS\s+IDENTITY\b/i);
  if (identMatch) {
    isIdentity = true;
    identityGeneration = identMatch[1].toUpperCase().replace(/\s+/g, ' ');
  }

  // Virtual / computed columns: <type> GENERATED ALWAYS AS (<expr>) [VIRTUAL]
  // Also bare form: <type> AS (<expr>) [VIRTUAL]
  let isVirtual = false;
  let virtualExpression = null;
  const virtMatch =
    rest.match(/\bGENERATED\s+ALWAYS\s+AS\s*\(([\s\S]+?)\)\s*(?:VIRTUAL)?(?!\s+IDENTITY)/i) ||
    rest.match(/(?:^|\s)AS\s*\(([\s\S]+?)\)\s*VIRTUAL\b/i);
  if (virtMatch && !isIdentity) {
    isVirtual = true;
    virtualExpression = virtMatch[1].trim();
  }

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
  if (defaultInfo) {
    col.defaultValue = defaultInfo.value;
    col.defaultKind = defaultInfo.kind;
  }
  if (checkExpression) col.checkExpression = checkExpression;
  if (isIdentity) {
    col.isIdentity = true;
    col.identityGeneration = identityGeneration;
  }
  if (isVirtual) {
    col.isVirtual = true;
    col.virtualExpression = virtualExpression;
  }

  // -----------------------------------------------------------
  // Inline constraints
  // -----------------------------------------------------------
  const inlineConstraints = [];

  // Inline named constraint qualifier: CONSTRAINT name (PRIMARY KEY|UNIQUE|CHECK|REFERENCES ...)
  // We parse constraint clauses sequentially through `rest`. To keep this
  // simple and robust we look for each clause independently and capture an
  // optional preceding `CONSTRAINT name` qualifier per clause.
  const constraintNameRe = new RegExp('CONSTRAINT\\s+(' + IDENT_RE_SRC + ')\\s+', 'i');

  // Inline FK: [CONSTRAINT name] REFERENCES [schema.]table[(col)] [ON DELETE action]
  const fkRe = new RegExp(
    '(?:CONSTRAINT\\s+(' + IDENT_RE_SRC + ')\\s+)?REFERENCES\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s*(?:\\(([^)]+)\\))?(?:\\s+ON\\s+DELETE\\s+(CASCADE|SET\\s+NULL|SET\\s+DEFAULT|NO\\s+ACTION|RESTRICT))?',
    'i'
  );
  const fkM = rest.match(fkRe);
  if (fkM) {
    const c = {
      name: fkM[1] ? unquoteIdent(fkM[1]) : null,
      tableName,
      constraintType: 'FOREIGN_KEY',
      columns: [name],
      refTableName: unquoteIdent(fkM[3]),
      refColumns: fkM[4] ? splitColList(fkM[4]) : [],
    };
    if (fkM[2]) c.refTableOwner = unquoteIdent(fkM[2]);
    if (fkM[5]) c.onDelete = fkM[5].toUpperCase().replace(/\s+/g, ' ');
    inlineConstraints.push(c);
    col.isForeignKey = true;
  }

  // Inline PRIMARY KEY (with optional CONSTRAINT name)
  const pkInlineRe = new RegExp(
    '(?:CONSTRAINT\\s+(' + IDENT_RE_SRC + ')\\s+)?PRIMARY\\s+KEY\\b',
    'i'
  );
  const pkM = rest.match(pkInlineRe);
  if (pkM) {
    inlineConstraints.push({
      name: pkM[1] ? unquoteIdent(pkM[1]) : null,
      tableName,
      constraintType: 'PRIMARY_KEY',
      columns: [name],
    });
  }

  // Inline UNIQUE (with optional CONSTRAINT name) — but skip if it's actually
  // part of UNIQUE INDEX or part of a PRIMARY KEY clause we already captured
  const uqInlineRe = new RegExp(
    '(?:CONSTRAINT\\s+(' + IDENT_RE_SRC + ')\\s+)?UNIQUE(?!\\s+INDEX)\\b',
    'i'
  );
  const uqM = rest.match(uqInlineRe);
  if (uqM && !pkM) {
    inlineConstraints.push({
      name: uqM[1] ? unquoteIdent(uqM[1]) : null,
      tableName,
      constraintType: 'UNIQUE',
      columns: [name],
    });
  }

  // Inline CHECK
  if (checkExpression) {
    const ckNameM = rest.match(constraintNameRe);
    inlineConstraints.push({
      name: ckNameM ? unquoteIdent(ckNameM[1]) : null,
      tableName,
      constraintType: 'CHECK',
      checkExpression,
    });
  }

  return { column: col, inlineConstraints };
}

/**
 * Parse a table-level CONSTRAINT definition.
 */
function parseTableConstraint(def, tableName) {
  def = def.trim();

  // Named constraint: CONSTRAINT name <type>
  let constraintName = null;
  const namedRe = new RegExp('^CONSTRAINT\\s+(' + IDENT_RE_SRC + ')\\s+', 'i');
  const namedMatch = def.match(namedRe);
  if (namedMatch) {
    constraintName = unquoteIdent(namedMatch[1]);
    def = def.slice(namedMatch[0].length);
  }

  const constraint = { name: constraintName, tableName };

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

  // FOREIGN KEY (cols) REFERENCES [schema.]ref_table (ref_cols) [ON DELETE action]
  const fkRe = new RegExp(
    '^FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s*(?:\\(([^)]+)\\))?(?:\\s+ON\\s+DELETE\\s+(CASCADE|SET\\s+NULL|SET\\s+DEFAULT|NO\\s+ACTION|RESTRICT))?',
    'i'
  );
  const fkMatch = def.match(fkRe);
  if (fkMatch) {
    constraint.constraintType = 'FOREIGN_KEY';
    constraint.columns = splitColList(fkMatch[1]);
    if (fkMatch[2]) constraint.refTableOwner = unquoteIdent(fkMatch[2]);
    constraint.refTableName = unquoteIdent(fkMatch[3]);
    constraint.refColumns = fkMatch[4] ? splitColList(fkMatch[4]) : [];
    if (fkMatch[5]) constraint.onDelete = fkMatch[5].toUpperCase().replace(/\s+/g, ' ');
    // DEFERRABLE / INITIALLY DEFERRED
    if (/\bDEFERRABLE\b/i.test(def)) constraint.deferrable = true;
    if (/\bINITIALLY\s+DEFERRED\b/i.test(def)) constraint.initiallyDeferred = true;
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

// -----------------------------------------------------------
// CREATE TABLE parser
// -----------------------------------------------------------

/**
 * Parse a CREATE TABLE statement.
 */
function parseCreateTable(stmt) {
  // CREATE [GLOBAL TEMPORARY] TABLE [schema.]name (body) [options]
  const headerRe = new RegExp(
    '^CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+)?TABLE\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s*\\(',
    'i'
  );
  const headerMatch = stmt.match(headerRe);
  if (!headerMatch) return null;

  const owner = headerMatch[1] ? unquoteIdent(headerMatch[1]) : null;
  const name = unquoteIdent(headerMatch[2]);
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
      const result = parseColumnDef(def, name);
      if (result) {
        columns.push(result.column);
        if (result.inlineConstraints && result.inlineConstraints.length) {
          constraints.push(...result.inlineConstraints);
        }
      }
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
  // CREATE [OR REPLACE] [FORCE|NOFORCE] [MATERIALIZED] VIEW [schema.]name
  //   [(col_list)] [storage/refresh/build/query-rewrite clauses ...] AS <select>
  // Materialized views in Oracle often have many clauses between the name and AS,
  // so we non-greedily skip to the first standalone AS keyword.
  const viewRe = new RegExp(
    '^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FORCE\\s+|NOFORCE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')([\\s\\S]*?)\\bAS\\b\\s+([\\s\\S]+)',
    'i'
  );
  const m = stmt.match(viewRe);
  if (!m) return null;

  const owner = m[1] ? unquoteIdent(m[1]) : null;
  const name = unquoteIdent(m[2]);
  const fullName = owner ? `${owner}.${name}` : name;
  // m[3] holds optional column list and any storage/refresh clauses; pull out a column list if present
  const colListMatch = (m[3] || '').match(/^\s*\(([^)]*)\)/);
  const columnList = colListMatch ? splitColList(colListMatch[1]) : [];
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
  const procRe = new RegExp(
    '^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:EDITIONABLE\\s+|NONEDITIONABLE\\s+)?(PROCEDURE|FUNCTION|PACKAGE(?:\\s+BODY)?|TRIGGER)\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s*([\\s\\S]*)',
    'i'
  );
  const m = stmt.match(procRe);
  if (!m) return null;

  const procType = m[1].toUpperCase().replace(/\s+/, '_');
  const owner = m[2] ? unquoteIdent(m[2]) : null;
  const name = unquoteIdent(m[3]);
  const fullName = owner ? `${owner}.${name}` : name;
  const rest = m[4] || '';

  // Extract parameters if present (skip for triggers — they don't take params)
  const parameters = [];
  const parenStart = rest.indexOf('(');
  if (parenStart !== -1 && procType !== 'PACKAGE_BODY' && procType !== 'PACKAGE' && procType !== 'TRIGGER') {
    const parenEnd = findMatchingParen(rest, parenStart);
    if (parenEnd !== -1) {
      const paramStr = rest.slice(parenStart + 1, parenEnd);
      const paramDefs = splitColumnDefs(paramStr);
      const paramRe = new RegExp(
        '^(' + IDENT_RE_SRC + ')\\s+(IN\\s+OUT(?:\\s+NOCOPY)?|IN|OUT(?:\\s+NOCOPY)?)?\\s*([\\s\\S]+?)(?:\\s+DEFAULT\\s+[\\s\\S]+)?$',
        'i'
      );
      for (const pd of paramDefs) {
        const pm = pd.trim().match(paramRe);
        if (pm) {
          parameters.push({
            name: unquoteIdent(pm[1]),
            direction: pm[2] ? pm[2].toUpperCase().replace(/\s+/g, ' ').replace(/\s*NOCOPY$/, '') : 'IN',
            dataType: pm[3].trim().toUpperCase(),
          });
        }
      }
    }
  }

  // Extract RETURN type for functions (allow VARCHAR2(200 CHAR), schema.type, %ROWTYPE, etc.)
  let returnType = null;
  if (procType === 'FUNCTION') {
    const retMatch = rest.match(/\bRETURN\s+([A-Za-z_][\w$#.]*(?:\s*\([^)]*\))?(?:%(?:ROWTYPE|TYPE))?)/i);
    if (retMatch) returnType = retMatch[1].trim().toUpperCase();
  }

  // -----------------------------------------------------------
  // Trigger metadata: timing, event, target table, level
  // -----------------------------------------------------------
  let triggerInfo = null;
  if (procType === 'TRIGGER') {
    triggerInfo = {};
    // Trigger event/timing detection must look only at the header (before the
    // PL/SQL body), otherwise INSERT/UPDATE/DELETE inside the body leak into
    // the event list.
    const bodyStartIdx = rest.search(/\b(?:DECLARE|BEGIN)\b/i);
    const header = bodyStartIdx >= 0 ? rest.slice(0, bodyStartIdx) : rest;

    const timingMatch = header.match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\b/i);
    if (timingMatch) triggerInfo.timing = timingMatch[1].toUpperCase().replace(/\s+/g, ' ');

    const events = [];
    if (/\bINSERT\b/i.test(header)) events.push('INSERT');
    if (/\bUPDATE\b/i.test(header)) {
      events.push('UPDATE');
      const updColsMatch = header.match(/\bUPDATE\s+OF\s+([^\n;]+?)(?:\s+(?:OR|ON)\b|$)/i);
      if (updColsMatch) triggerInfo.updateColumns = splitColList(updColsMatch[1]);
    }
    if (/\bDELETE\b/i.test(header)) events.push('DELETE');
    if (events.length) triggerInfo.events = events;

    const onMatch = header.match(new RegExp('\\bON\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')', 'i'));
    if (onMatch) {
      if (onMatch[1]) triggerInfo.targetOwner = unquoteIdent(onMatch[1]);
      triggerInfo.targetTable = unquoteIdent(onMatch[2]);
    }
    if (/\bFOR\s+EACH\s+ROW\b/i.test(header)) triggerInfo.level = 'ROW';
    else triggerInfo.level = 'STATEMENT';

    const whenMatch = header.match(/\bWHEN\s*\(([\s\S]+?)\)\s*$/i);
    if (whenMatch) triggerInfo.whenCondition = whenMatch[1].trim();
  }

  const body = stmt.slice(0, 1000) + (stmt.length > 1000 ? '\n-- [truncated]' : '');

  const typeLower = procType.toLowerCase().replace('_', ' ');

  const out = {
    name,
    owner,
    fullName,
    procedureType: typeLower,
    parameters,
    returnType,
    body,
  };
  if (triggerInfo) out.trigger = triggerInfo;
  return out;
}

// -----------------------------------------------------------
// CREATE INDEX parser
// -----------------------------------------------------------

function parseCreateIndex(stmt) {
  // CREATE [UNIQUE|BITMAP] INDEX [schema.]name ON [schema.]table (cols) [options]
  const idxRe = new RegExp(
    '^CREATE\\s+(UNIQUE\\s+|BITMAP\\s+)?INDEX\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s+ON\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s*\\(([^)]+)\\)(?:\\s+([\\s\\S]*))?',
    'i'
  );
  const m = stmt.match(idxRe);
  if (!m) return null;

  const indexModifier = m[1] ? m[1].trim().toUpperCase() : null;
  const indexName = unquoteIdent(m[3]);
  const tableOwner = m[4] ? unquoteIdent(m[4]) : null;
  const tableName = unquoteIdent(m[5]);
  const tableFullName = tableOwner ? `${tableOwner}.${tableName}` : tableName;
  const colStr = m[6];
  const options = m[7] || '';

  // Function-based indexes contain expressions, not bare columns. Detect from
  // the raw string before splitting (splitColList would mangle expressions).
  const isFunctionBased = /[()+\-*/]/.test(colStr);
  const columns = isFunctionBased ? [] : splitColList(colStr);
  const expressions = isFunctionBased ? [colStr.trim()] : null;

  let indexType = 'BTREE';
  if (indexModifier === 'BITMAP') indexType = 'BITMAP';
  else if (isFunctionBased) indexType = 'FUNCTION_BASED';

  const tsMatch = options.match(/\bTABLESPACE\s+(\w+)/i);
  const tablespace = tsMatch ? tsMatch[1].toUpperCase() : null;

  const out = {
    name: indexName,
    tableName,
    tableFullName,
    columns,
    isUnique: indexModifier === 'UNIQUE',
    indexType,
    tablespace,
  };
  if (expressions) out.expressions = expressions;
  return out;
}

// -----------------------------------------------------------
// CREATE SEQUENCE parser
// -----------------------------------------------------------

/**
 * Parse `CREATE SEQUENCE [schema.]name [option ...]` and return a sequence
 * descriptor. Sequences are first-class graph nodes — triggers and DEFAULT
 * expressions reference them to drive auto-increment semantics.
 */
function parseCreateSequence(stmt) {
  const re = new RegExp(
    '^CREATE\\s+SEQUENCE\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\b([\\s\\S]*)',
    'i'
  );
  const m = stmt.match(re);
  if (!m) return null;

  const owner = m[1] ? unquoteIdent(m[1]) : null;
  const name = unquoteIdent(m[2]);
  const options = m[3] || '';

  function readNum(re) {
    const mm = options.match(re);
    return mm ? Number(mm[1]) : null;
  }

  const seq = {
    name,
    owner,
    fullName: owner ? `${owner}.${name}` : name,
    startWith: readNum(/\bSTART\s+WITH\s+(-?\d+)/i),
    incrementBy: readNum(/\bINCREMENT\s+BY\s+(-?\d+)/i),
    minValue: /\bNOMINVALUE\b/i.test(options) ? null : readNum(/\bMINVALUE\s+(-?\d+)/i),
    maxValue: /\bNOMAXVALUE\b/i.test(options) ? null : readNum(/\bMAXVALUE\s+(-?\d+)/i),
    cache: /\bNOCACHE\b/i.test(options) ? 0 : readNum(/\bCACHE\s+(\d+)/i),
    cycle: /\bCYCLE\b/i.test(options) && !/\bNOCYCLE\b/i.test(options),
    order: /\bORDER\b/i.test(options) && !/\bNOORDER\b/i.test(options),
  };
  return seq;
}

// -----------------------------------------------------------
// COMMENT ON parser
// -----------------------------------------------------------

function parseComment(stmt) {
  // COMMENT ON {TABLE|VIEW|MATERIALIZED VIEW} [schema.]name IS 'text'
  const tableRe = new RegExp(
    '^COMMENT\\s+ON\\s+(?:TABLE|VIEW|MATERIALIZED\\s+VIEW)\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ")\\s+IS\\s+'((?:[^']|'')*)'",
    'i'
  );
  const tableMatch = stmt.match(tableRe);
  if (tableMatch) {
    return {
      target: 'table',
      owner: tableMatch[1] ? unquoteIdent(tableMatch[1]) : null,
      name: unquoteIdent(tableMatch[2]),
      comment: tableMatch[3].replace(/''/g, "'"),
    };
  }

  // COMMENT ON COLUMN [schema.]table.column IS 'text'
  const colRe = new RegExp(
    '^COMMENT\\s+ON\\s+COLUMN\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\.(' + IDENT_RE_SRC + ")\\s+IS\\s+'((?:[^']|'')*)'",
    'i'
  );
  const colMatch = stmt.match(colRe);
  if (colMatch) {
    return {
      target: 'column',
      owner: colMatch[1] ? unquoteIdent(colMatch[1]) : null,
      tableName: unquoteIdent(colMatch[2]),
      columnName: unquoteIdent(colMatch[3]),
      comment: colMatch[4].replace(/''/g, "'"),
    };
  }

  return null;
}

// -----------------------------------------------------------
// ALTER TABLE … ADD CONSTRAINT parser
// -----------------------------------------------------------

function parseAlterTableConstraint(stmt) {
  const re = new RegExp(
    '^ALTER\\s+TABLE\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s+ADD\\s+([\\s\\S]*)',
    'i'
  );
  const m = stmt.match(re);
  if (!m) return null;

  const owner = m[1] ? unquoteIdent(m[1]) : null;
  const tableName = unquoteIdent(m[2]);
  const addClause = m[3].trim();

  const constraint = parseTableConstraint(addClause, tableName);
  if (!constraint) return null;

  return { tableName, owner, constraint };
}

/**
 * Parse `ALTER TABLE … DROP CONSTRAINT name` so the snapshot model can remove
 * a previously declared constraint when re-applying a schema dump.
 */
function parseAlterTableDropConstraint(stmt) {
  const re = new RegExp(
    '^ALTER\\s+TABLE\\s+(?:(' + IDENT_RE_SRC + ')\\.)?(' + IDENT_RE_SRC + ')\\s+DROP\\s+CONSTRAINT\\s+(' + IDENT_RE_SRC + ')',
    'i'
  );
  const m = stmt.match(re);
  if (!m) return null;
  return {
    owner: m[1] ? unquoteIdent(m[1]) : null,
    tableName: unquoteIdent(m[2]),
    constraintName: unquoteIdent(m[3]),
  };
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
  const sequences = [];
  const commentMap = { tables: {}, columns: {} };

  const tableMap = {}; // name → table object, for post-processing comments

  // Per-statement parse report so the ingestion pipeline can monitor coverage
  // and downstream LLM consumers can detect when a file isn't fully understood.
  const parseReport = {
    totalStatements: statements.length,
    parsed: 0,
    skipped: 0,
    skippedSamples: [],
    byKind: {
      table: 0, view: 0, procedure: 0, index: 0, sequence: 0,
      comment: 0, alterAdd: 0, alterDrop: 0,
    },
  };

  function recordSkip(stmt, reason) {
    parseReport.skipped++;
    if (parseReport.skippedSamples.length < 5) {
      parseReport.skippedSamples.push({ reason, head: stmt.slice(0, 80) });
    }
  }

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
        parseReport.parsed++;
        parseReport.byKind.table++;
      } else {
        recordSkip(stripped, 'create_table_unparsed');
      }
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FORCE\s+|NOFORCE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.test(stripped)) {
      const v = parseCreateView(stripped);
      if (v) {
        views.push(v);
        parseReport.parsed++;
        parseReport.byKind.view++;
      } else {
        recordSkip(stripped, 'create_view_unparsed');
      }
    } else if (upper.startsWith('CREATE') && /CREATE\s+SEQUENCE\b/i.test(stripped)) {
      const s = parseCreateSequence(stripped);
      if (s) {
        sequences.push(s);
        parseReport.parsed++;
        parseReport.byKind.sequence++;
      } else {
        recordSkip(stripped, 'create_sequence_unparsed');
      }
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b/i.test(stripped)) {
      const p = parseCreateProcedure(stripped);
      if (p) {
        procedures.push(p);
        parseReport.parsed++;
        parseReport.byKind.procedure++;
      } else {
        recordSkip(stripped, 'create_procedure_unparsed');
      }
    } else if (upper.startsWith('CREATE') && /CREATE\s+(?:UNIQUE\s+|BITMAP\s+)?INDEX\b/i.test(stripped)) {
      const idx = parseCreateIndex(stripped);
      if (idx) {
        indexes.push(idx);
        parseReport.parsed++;
        parseReport.byKind.index++;
      } else {
        recordSkip(stripped, 'create_index_unparsed');
      }
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
        parseReport.parsed++;
        parseReport.byKind.comment++;
      } else {
        recordSkip(stripped, 'comment_unparsed');
      }
    } else if (upper.startsWith('ALTER')) {
      // Snapshot semantics: apply ADD CONSTRAINT and DROP CONSTRAINT in order so
      // re-parsing the same file always yields the same final state.
      const drop = parseAlterTableDropConstraint(stripped);
      if (drop) {
        const existing = tableMap[drop.tableName] || (drop.owner && tableMap[`${drop.owner}.${drop.tableName}`]);
        if (existing) {
          const before = existing.constraints.length;
          existing.constraints = existing.constraints.filter(c => c.name !== drop.constraintName);
          if (before !== existing.constraints.length) {
            // Recompute hasPrimaryKey + column flags after the drop
            const hasPk = existing.constraints.some(c => c.constraintType === 'PRIMARY_KEY');
            existing.hasPrimaryKey = hasPk;
            for (const col of existing.columns) {
              col.isPrimaryKey = false;
              col.isForeignKey = false;
            }
            for (const c of existing.constraints) {
              if (c.constraintType === 'PRIMARY_KEY') {
                for (const col of existing.columns) {
                  if (c.columns && c.columns.includes(col.name)) col.isPrimaryKey = true;
                }
              }
              if (c.constraintType === 'FOREIGN_KEY') {
                for (const col of existing.columns) {
                  if (c.columns && c.columns.includes(col.name)) col.isForeignKey = true;
                }
              }
            }
          }
        }
        parseReport.parsed++;
        parseReport.byKind.alterDrop++;
        continue;
      }

      const alt = parseAlterTableConstraint(stripped);
      if (alt) {
        const existing = tableMap[alt.tableName] || (alt.owner && tableMap[`${alt.owner}.${alt.tableName}`]);
        if (existing) {
          existing.constraints.push(alt.constraint);
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
        parseReport.parsed++;
        parseReport.byKind.alterAdd++;
      } else {
        recordSkip(stripped, 'alter_unparsed');
      }
    } else {
      recordSkip(stripped, 'unrecognized_statement');
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

  // Deterministic ordering: tables/views/etc. retain file-emit order; constraints
  // and indexes within each table sort by (type, then sorted column list, then name)
  // so that a re-parse of the same file always produces byte-identical output and
  // graph diffs reflect real schema changes — not parser quirks.
  function constraintKey(c) {
    return [c.constraintType || '', (c.columns || []).join(','), c.name || ''].join('|');
  }
  function indexKey(i) {
    return [i.indexType || '', (i.columns || []).join(','), i.name || ''].join('|');
  }
  for (const t of tables) {
    if (t.constraints) t.constraints.sort((a, b) => constraintKey(a).localeCompare(constraintKey(b)));
    if (t.indexes) t.indexes.sort((a, b) => indexKey(a).localeCompare(indexKey(b)));
  }

  return {
    tables,
    views,
    procedures,
    indexes: standaloneIndexes,
    allIndexes: indexes,
    sequences,
    parseReport,
  };
}

module.exports = { parseOracleDDL, splitStatements };
