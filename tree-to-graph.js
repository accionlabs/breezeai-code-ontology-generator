#!/usr/bin/env node
const fs = require("fs");
const neo4j = require("neo4j-driver");
const { dbConfig } = require("./config");

if (process.argv.length < 4) {
  console.error("Usage: node importToNeo4j.js <repo_json_path> <projectUuid>");
  process.exit(1);
}

const jsonPath = process.argv[2];
const projectUuid = process.argv[3];

const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const files = jsonData;

console.log("files", files.length);

const driver = neo4j.driver(
  dbConfig.dbUrl,
  neo4j.auth.basic(dbConfig.username, dbConfig.password)
);

// Ensure unique constraint once (run separately / at app start)
async function ensureConstraint() {
  const session = driver.session({ database: dbConfig.dbName });
  try {
    await session.executeWrite(tx =>
      tx.run(
        `CREATE CONSTRAINT IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE`
      )
    );
  } finally {
    console.log("closing session1");
    await session.close();
  }
}

async function importRepo(files, projectUuid) {
  if (!files || files.length === 0) return;

  const session = driver.session({ database: dbConfig.dbName });

  try {
    await ensureConstraint();

    // 1) Merge File nodes with projectUuid
    await session.executeWrite(tx =>
      tx.run(
        `
        UNWIND $files AS file
        MERGE (f:File {path: file.path})
        SET f.externalImports = file.externalImports,
            f.projectUuid = $projectUuid
        `,
        { files, projectUuid }
      )
    );

    // 2) Merge IMPORTS relationships
    const relPairs = [];
    for (const file of files) {
      if (!file.importFiles || file.importFiles.length === 0) continue;
      for (const imp of file.importFiles) {
        relPairs.push({ from: file.path, to: imp });
      }
    }

    if (relPairs.length > 0) {
      await session.executeWrite(tx =>
        tx.run(
          `
    UNWIND $pairs AS p
    MERGE (a:File {path: p.from})
      ON CREATE SET a.projectUuid = $projectUuid
      ON MATCH SET a.projectUuid = coalesce(a.projectUuid, $projectUuid)
    MERGE (b:File {path: p.to})
      ON CREATE SET b.projectUuid = $projectUuid
      ON MATCH SET b.projectUuid = coalesce(b.projectUuid, $projectUuid)
    MERGE (a)-[:IMPORTS]->(b)
    `,
          { pairs: relPairs, projectUuid }
        )
      );
    }

    console.log("✅ Import complete with projectUuid:", projectUuid);
  } catch (err) {
    console.error("closing session2");
    console.error("❌ Error importing repo:", err);
    throw err;
  } finally {
    await session.close();
  }
}

importRepo(files, projectUuid);
