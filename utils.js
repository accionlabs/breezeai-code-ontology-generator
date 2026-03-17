/**
 * Shared utilities for Breeze Code Ontology Generator
 */

const MAX_LINES = 200;
const MAX_CHARS = 10000;
const TRUNCATION_MARKER = "// ... [truncated]";

/**
 * Truncate source code to stay within limits.
 * Hard limit: 200 lines or 10,000 characters, whichever hits first.
 * @param {string} rawSource - The raw source code string
 * @returns {string} - Truncated source with marker if exceeded
 */
function truncateSourceCode(rawSource) {
  if (!rawSource) return rawSource;

  let result = rawSource;
  let truncated = false;

  // Check line limit
  const lines = result.split("\n");
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join("\n");
    truncated = true;
  }

  // Check character limit
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS);
    truncated = true;
  }

  if (truncated) {
    result += "\n" + TRUNCATION_MARKER;
  }

  return result;
}

// -----------------------------------------------------------
// Source cache: avoids reading + parsing the same file multiple
// times when extractImports, extractFunctions, and extractClasses
// are called sequentially for the same file.
// -----------------------------------------------------------
const fs = require("fs");

let _cachedPath = null;
let _cachedSource = null;
let _cachedTree = null;

/**
 * Read file contents with single-entry cache.
 * Consecutive calls for the same filePath return the cached string.
 */
function readSource(filePath) {
  if (_cachedPath === filePath && _cachedSource !== null) return _cachedSource;
  _cachedPath = filePath;
  _cachedSource = fs.readFileSync(filePath, "utf8");
  _cachedTree = null; // invalidate tree when file changes
  return _cachedSource;
}

/**
 * Parse file with tree-sitter, caching both source and tree.
 * If the same filePath was already parsed (by any parser using the
 * same grammar), the cached tree is returned directly.
 */
function parseSource(filePath, parser) {
  const source = readSource(filePath);
  if (_cachedTree) return { source, tree: _cachedTree };
  _cachedTree = parser.parse(source);
  return { source, tree: _cachedTree };
}

// -----------------------------------------------------------
// Query statement detection patterns
// -----------------------------------------------------------

/**
 * Database method signatures organized by database/ORM.
 * Each key is a database identifier, value is an array of method names unique to that DB.
 * Used to both detect query statements AND identify which database is integrated.
 */
const DB_METHOD_MAP = {
  sql: [
    'query', 'rawQuery', 'raw', 'execute', 'exec', 'executeSql',
    'prepare', 'prepareStatement', 'executeQuery', 'executeUpdate',
  ],
  sequelize: [
    'findAll', 'findOne', 'findByPk', 'findOrCreate', 'findAndCountAll',
    'upsert', 'bulkCreate',
  ],
  prisma: [
    'findMany', 'findFirst', 'findUnique',
  ],
  typeorm: [
    'createQueryBuilder', 'getRepository',
  ],
  mongodb: [
    'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
    'insertOne', 'insertMany', 'updateOne', 'updateMany',
    'deleteOne', 'deleteMany', 'replaceOne',
    'countDocuments', 'estimatedDocumentCount',
    'aggregate', 'bulkWrite',
  ],
  neo4j: [
    'readTransaction', 'writeTransaction', 'executeRead', 'executeWrite',
  ],
  couchdb: [
    'allDocs', 'bulkDocs',
    'createIndex', 'getIndexes', 'deleteIndex',
  ],
  redis: [
    'hget', 'hset', 'hgetall', 'hdel', 'hmset', 'hmget',
    'lpush', 'rpush', 'lpop', 'rpop', 'lrange',
    'sadd', 'srem', 'smembers', 'sismember',
    'zadd', 'zrem', 'zrange', 'zrangebyscore',
    'mset', 'mget',
  ],
  dynamodb: [
    'getItem', 'putItem', 'deleteItem', 'updateItem',
    'batchGetItem', 'batchWriteItem', 'transactGetItems', 'transactWriteItems',
  ],
  elasticsearch: [
    'msearch',
  ],
  firebase: [
    'getDocs', 'getDoc', 'setDoc', 'updateDoc', 'deleteDoc',
    'addDoc', 'onSnapshot',
  ],
  entity_framework: [
    'ToListAsync', 'ToList', 'ToArrayAsync', 'ToArray',
    'FirstOrDefaultAsync', 'FirstOrDefault', 'FirstAsync',
    'SingleOrDefaultAsync', 'SingleOrDefault', 'SingleAsync',
    'LastOrDefaultAsync', 'LastOrDefault',
    'CountAsync', 'LongCountAsync', 'AnyAsync', 'AllAsync',
    'MinAsync', 'MaxAsync', 'SumAsync', 'AverageAsync',
    'FindAsync', 'AddAsync', 'AddRangeAsync',
    'SaveChangesAsync', 'SaveChanges',
    'Include', 'ThenInclude', 'AsNoTracking', 'AsTracking',
    'FromSqlRaw', 'FromSqlInterpolated', 'ExecuteSqlRaw', 'ExecuteSqlInterpolated',
  ],
  django: [
    'select_related', 'prefetch_related',
    'get_or_create', 'update_or_create', 'bulk_update',
    'values_list',
  ],
  sqlalchemy: [
    'session_query', 'add_all',
  ],
  hibernate: [
    'findById', 'findAll',
  ],
};

// Build a reverse lookup: method name -> database name
const METHOD_TO_DB = new Map();
for (const [db, methods] of Object.entries(DB_METHOD_MAP)) {
  for (const method of methods) {
    // If a method appears in multiple DBs, first one wins (more specific DBs should be listed first)
    if (!METHOD_TO_DB.has(method)) {
      METHOD_TO_DB.set(method, db);
    }
  }
}

/** Database query language patterns */
const QUERY_PATTERNS = [
  // SQL (MySQL, PostgreSQL, SQLite, MSSQL, Oracle)
  /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|MERGE|TRUNCATE)\b/i,
  // Neo4j Cypher — require graph-specific syntax context
  /\b(MATCH|OPTIONAL\s+MATCH)\s*\(/i,                   // MATCH (...), OPTIONAL MATCH (...)
  /\b(MATCH|CREATE|MERGE)\s*\([a-zA-Z0-9_]*:/i,         // MATCH (n:Label), CREATE (n:Label)
  /\bDETACH\s+DELETE\b/i,                                // DETACH DELETE
  /\bLOAD\s+CSV\b/i,                                     // LOAD CSV
  // MongoDB aggregation string patterns (e.g. in raw commands)
  /\$match|\$group|\$project|\$lookup|\$unwind|\$sort|\$limit|\$skip/,
  // GraphQL
  /\b(query|mutation|subscription)\s*[\({]/i,
  // Elasticsearch Query DSL
  /\b(bool|must|should|must_not|filter)\b.*\b(match|term|range|exists)\b/i,
  // Cassandra CQL
  /\b(KEYSPACE|COLUMNFAMILY|MATERIALIZED\s+VIEW|CONSISTENCY)\b/i,
  // Gremlin (graph DB)
  /\bg\.(V|E|addV|addE|traversal)\s*\(/,
  // SPARQL
  /\b(SELECT|CONSTRUCT|ASK|DESCRIBE)\s+.*\bWHERE\s*\{/i,
];

/**
 * Check if a string node's text contains a database query (SQL, Cypher, GraphQL, etc.).
 */
function containsDbQuery(text) {
  return QUERY_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Check if a method name is a known DB call method.
 * @returns {string|null} - Database name (e.g. 'mongodb', 'redis', 'entity_framework') or null if not a DB method.
 */
function getDbFromMethod(methodName) {
  return METHOD_TO_DB.get(methodName) || null;
}

module.exports = {
  truncateSourceCode, readSource, parseSource,
  containsDbQuery, getDbFromMethod, DB_METHOD_MAP, QUERY_PATTERNS
};
