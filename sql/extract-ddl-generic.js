/**
 * Generic multi-dialect DDL parser built on node-sql-parser.
 *
 * Used for any non-Oracle dialect (Postgres, MySQL/MariaDB, T-SQL, SQLite, etc.).
 * Walks the AST produced by node-sql-parser and normalizes it into the same
 * record shape that the Oracle parser emits, so downstream consumers don't care
 * which dialect a file came from:
 *
 *   { tables, views, procedures, indexes, allIndexes }
 *
 * Strategy: split the file into individual statements (reusing the Oracle
 * splitter, which is dialect-agnostic for `;` termination + comments + strings),
 * then parse each statement independently. A failed statement is recorded but
 * does not abort the file — many real-world dumps mix DDL with `BEGIN;`,
 * `COMMIT;`, sequences, GRANTs, etc. that node-sql-parser may not support.
 */

'use strict';

const { Parser } = require('node-sql-parser');
const { splitStatements } = require('./extract-ddl-oracle');

const parser = new Parser();

// -----------------------------------------------------------
// AST helpers
// -----------------------------------------------------------

function unwrapName(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(unwrapName).filter(Boolean).join('.');
  if (node.value != null) return String(node.value);
  if (node.expr) return unwrapName(node.expr);
  if (node.name) return unwrapName(node.name);
  if (node.column) return unwrapName(node.column);
  return null;
}

function sameColList(a, b) {
  const aa = (a || []).map(x => String(x).toUpperCase()).sort();
  const bb = (b || []).map(x => String(x).toUpperCase()).sort();
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

/**
 * Semantic equality: same type, same column set, and (for FKs) same ref
 * table + column set. Constraint name is intentionally ignored so an FK
 * defined inline in CREATE TABLE and then re-declared via ALTER TABLE
 * ADD CONSTRAINT is treated as a single constraint.
 */
function constraintsEquivalent(a, b) {
  if (!a || !b) return false;
  if (a.constraintType !== b.constraintType) return false;
  if (!sameColList(a.columns, b.columns)) return false;
  if (a.constraintType === 'FOREIGN_KEY') {
    if ((a.refTableName || '').toUpperCase() !== (b.refTableName || '').toUpperCase()) return false;
    if (!sameColList(a.refColumns, b.refColumns)) return false;
  }
  return true;
}

function upper(s) {
  return s == null ? null : String(s).toUpperCase();
}

function tableRef(t) {
  if (!t) return { owner: null, name: null };
  const ref = Array.isArray(t) ? t[0] : t;
  return {
    owner: ref.db ? upper(ref.db) : null,
    name: upper(ref.table),
  };
}

function fullName(owner, name) {
  return owner ? `${owner}.${name}` : name;
}

function formatDataType(def) {
  if (!def) return 'UNKNOWN';
  let s = String(def.dataType || 'UNKNOWN').toUpperCase();
  if (def.length != null) {
    if (def.scale != null) s += `(${def.length},${def.scale})`;
    else s += `(${def.length})`;
  }
  return s;
}

// -----------------------------------------------------------
// CREATE TABLE
// -----------------------------------------------------------

function extractTable(stmt) {
  const { owner, name } = tableRef(stmt.table);
  if (!name) return null;

  const columns = [];
  const constraints = [];
  const defs = stmt.create_definitions || [];
  let ordinal = 0;

  for (const d of defs) {
    if (!d) continue;

    if (d.resource === 'column') {
      ordinal++;
      const colName = upper(unwrapName(d.column));
      const dt = formatDataType(d.definition);
      const nullable = !(d.nullable && /not\s+null/i.test(d.nullable.value || d.nullable.type || ''));
      const isPrimaryKey = !!(d.primary_key || d.unique === 'primary key');
      const isUnique = !!(d.unique && /unique/i.test(d.unique));
      const col = {
        name: colName,
        dataType: dt,
        nullable,
        isPrimaryKey,
        isUnique,
        isForeignKey: false,
        isIndexed: false,
        ordinalPosition: ordinal,
      };
      if (d.definition && d.definition.length != null) col.length = d.definition.length;
      if (d.definition && d.definition.scale != null) col.scale = d.definition.scale;
      if (d.default_val && d.default_val.value != null) {
        const v = d.default_val.value;
        col.defaultValue = typeof v === 'object' ? (v.value || unwrapName(v) || JSON.stringify(v)) : String(v);
      }
      columns.push(col);
      continue;
    }

    if (d.resource === 'constraint') {
      const cname = d.constraint ? upper(d.constraint) : null;
      const ctype = (d.constraint_type || '').toLowerCase();
      const c = { name: cname, tableName: name };

      if (ctype.includes('primary key')) {
        c.constraintType = 'PRIMARY_KEY';
        c.columns = (d.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
        constraints.push(c);
      } else if (ctype.includes('unique')) {
        c.constraintType = 'UNIQUE';
        c.columns = (d.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
        constraints.push(c);
      } else if (ctype === 'foreign key' || ctype.includes('foreign')) {
        c.constraintType = 'FOREIGN_KEY';
        c.columns = (d.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
        if (d.reference_definition) {
          const ref = tableRef(d.reference_definition.table);
          c.refTableName = ref.name;
          if (ref.owner) c.refTableOwner = ref.owner;
          c.refColumns = (d.reference_definition.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
          if (d.reference_definition.on_delete) c.onDelete = upper(d.reference_definition.on_delete);
        }
        constraints.push(c);
      } else if (ctype === 'check') {
        c.constraintType = 'CHECK';
        c.checkExpression = JSON.stringify(d.definition || d.expr || null);
        constraints.push(c);
      }
    }
  }

  // Mark PK / FK columns
  const pk = constraints.find(c => c.constraintType === 'PRIMARY_KEY');
  if (pk) for (const col of columns) if (pk.columns.includes(col.name)) col.isPrimaryKey = true;
  for (const con of constraints) {
    if (con.constraintType === 'FOREIGN_KEY') {
      for (const col of columns) if (con.columns.includes(col.name)) col.isForeignKey = true;
    }
  }

  return {
    name,
    owner,
    fullName: fullName(owner, name),
    tableType: stmt.temporary ? 'temporary' : 'table',
    columnCount: columns.length,
    hasPrimaryKey: columns.some(c => c.isPrimaryKey) || !!pk,
    columns,
    constraints,
  };
}

// -----------------------------------------------------------
// CREATE VIEW
// -----------------------------------------------------------

function extractView(stmt) {
  const { owner, name } = tableRef(stmt.view || stmt.table);
  if (!name) return null;
  return {
    name,
    owner,
    fullName: fullName(owner, name),
    viewType: 'view',
    definition: null,
    columns: [],
  };
}

// -----------------------------------------------------------
// CREATE INDEX
// -----------------------------------------------------------

function extractIndex(stmt) {
  const { owner, name: tableName } = tableRef(stmt.table);
  const indexName = upper(stmt.index);
  const cols = (stmt.index_columns || [])
    .map(c => upper(unwrapName(c.column || c)))
    .filter(Boolean);
  return {
    name: indexName,
    tableName,
    tableFullName: fullName(owner, tableName),
    columns: cols,
    isUnique: /unique/i.test(stmt.index_type || ''),
    indexType: 'BTREE',
    tablespace: null,
    whereClause: null,
  };
}

// -----------------------------------------------------------
// ALTER TABLE … ADD CONSTRAINT (FK / PK / UNIQUE / CHECK)
// -----------------------------------------------------------

function extractOnAction(refDef, kind) {
  if (!refDef) return null;
  if (refDef[`on_${kind}`]) return upper(unwrapName(refDef[`on_${kind}`]));
  if (Array.isArray(refDef.on_action)) {
    const hit = refDef.on_action.find(a => (a.type || '').toLowerCase() === `on ${kind}`);
    if (hit) return upper(unwrapName(hit.value));
  }
  return null;
}

function buildConstraintFromDef(def, tableName) {
  if (!def) return null;
  const cname = def.constraint ? upper(def.constraint) : null;
  const ctype = (def.constraint_type || '').toLowerCase();
  const c = { name: cname, tableName };
  if (ctype.includes('primary key')) {
    c.constraintType = 'PRIMARY_KEY';
    c.columns = (def.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
    return c;
  }
  if (ctype.includes('unique')) {
    c.constraintType = 'UNIQUE';
    c.columns = (def.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
    return c;
  }
  if (ctype === 'foreign key' || ctype.includes('foreign')) {
    c.constraintType = 'FOREIGN_KEY';
    c.columns = (def.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
    if (def.reference_definition) {
      const ref = tableRef(def.reference_definition.table);
      c.refTableName = ref.name;
      if (ref.owner) c.refTableOwner = ref.owner;
      c.refColumns = (def.reference_definition.definition || []).map(x => upper(unwrapName(x))).filter(Boolean);
      const onDel = extractOnAction(def.reference_definition, 'delete');
      const onUpd = extractOnAction(def.reference_definition, 'update');
      if (onDel) c.onDelete = onDel;
      if (onUpd) c.onUpdate = onUpd;
    }
    return c;
  }
  if (ctype === 'check') {
    c.constraintType = 'CHECK';
    c.checkExpression = JSON.stringify(def.definition || def.expr || null);
    return c;
  }
  return null;
}

function extractAlterConstraints(stmt) {
  const out = [];
  const { name: tableName } = tableRef(stmt.table);
  if (!tableName) return out;
  const exprs = stmt.expr || [];
  const list = Array.isArray(exprs) ? exprs : [exprs];
  for (const e of list) {
    if (!e || (e.action || '').toLowerCase() !== 'add') continue;
    // node-sql-parser nests the constraint info under create_definitions for ALTER … ADD CONSTRAINT
    const def = e.create_definitions || e;
    if (def.resource !== 'constraint' && e.resource !== 'constraint') continue;
    const c = buildConstraintFromDef(def, tableName);
    if (c) out.push({ tableName, constraint: c });
  }
  return out;
}

// -----------------------------------------------------------
// Main entrypoint
// -----------------------------------------------------------

/**
 * Parse a multi-statement SQL DDL file using node-sql-parser.
 *
 * @param {string} ddlText
 * @param {string} dialect - node-sql-parser `database` value (e.g. 'postgresql')
 * @returns {{tables, views, procedures, indexes, allIndexes, parseStats}}
 */
function parseGenericDDL(ddlText, dialect) {
  const tables = [];
  const views = [];
  const procedures = [];
  const indexes = [];
  const tableMap = {};

  let okCount = 0;
  let failCount = 0;
  const failures = [];

  const statements = splitStatements(ddlText);

  for (const raw of statements) {
    const stmt = raw.trim();
    if (!stmt) continue;

    let asts;
    try {
      asts = parser.astify(stmt + (stmt.endsWith(';') ? '' : ';'), { database: dialect });
    } catch (err) {
      failCount++;
      if (failures.length < 5) failures.push(err.message);
      continue;
    }
    okCount++;
    const list = Array.isArray(asts) ? asts : [asts];

    for (const ast of list) {
      if (!ast || ast.type !== 'create' && ast.type !== 'alter') continue;

      if (ast.type === 'create') {
        const kw = (ast.keyword || '').toLowerCase();
        if (kw === 'table') {
          const t = extractTable(ast);
          if (t) {
            tables.push(t);
            tableMap[t.name] = t;
          }
        } else if (kw === 'view') {
          const v = extractView(ast);
          if (v) views.push(v);
        } else if (kw === 'index') {
          const idx = extractIndex(ast);
          if (idx) indexes.push(idx);
        } else if (kw === 'function' || kw === 'procedure') {
          const ref = tableRef(ast.function || ast.procedure || ast.table);
          procedures.push({
            name: ref.name,
            owner: ref.owner,
            fullName: fullName(ref.owner, ref.name),
            procedureType: kw,
            parameters: [],
            returnType: null,
          });
        }
      } else if (ast.type === 'alter') {
        const adds = extractAlterConstraints(ast);
        for (const { tableName, constraint } of adds) {
          const t = tableMap[tableName];
          if (t) {
            if (t.constraints.some(c => constraintsEquivalent(c, constraint))) continue;
            t.constraints.push(constraint);
            if (constraint.constraintType === 'FOREIGN_KEY') {
              for (const col of t.columns) {
                if (constraint.columns.includes(col.name)) col.isForeignKey = true;
              }
            }
            if (constraint.constraintType === 'PRIMARY_KEY') {
              t.hasPrimaryKey = true;
              for (const col of t.columns) {
                if (constraint.columns.includes(col.name)) col.isPrimaryKey = true;
              }
            }
          }
        }
      }
    }
  }

  // Attach indexes to their tables and mark indexed columns
  for (const idx of indexes) {
    const t = tableMap[idx.tableName];
    if (t) {
      if (!t.indexes) t.indexes = [];
      t.indexes.push(idx);
      for (const col of t.columns) {
        if (idx.columns.includes(col.name)) col.isIndexed = true;
      }
    }
  }
  for (const t of tables) if (!t.indexes) t.indexes = [];

  const standaloneIndexes = indexes.filter(i => !tableMap[i.tableName]);

  return {
    tables,
    views,
    procedures,
    indexes: standaloneIndexes,
    allIndexes: indexes,
    parseStats: { ok: okCount, failed: failCount, sampleErrors: failures },
  };
}

module.exports = { parseGenericDDL };
