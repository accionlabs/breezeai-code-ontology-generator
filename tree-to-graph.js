#!/usr/bin/env node
const fs = require("fs");
const neo4j = require("neo4j-driver");
const { dbConfig } = require("./config")

if (process.argv.length < 3) {
  console.error("Usage: node importToNeo4j.js <repo_json_path>");
  process.exit(1);
}

const jsonPath = process.argv[2];
const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const files = jsonData;


const driver = neo4j.driver(
  dbConfig.dbUrl,
  neo4j.auth.basic(dbConfig.username, dbConfig.password)
);


async function importRepo(files) {
  const session = driver.session({ database: dbConfig.dbName });
  console.log(`📦 Importing ${files.length} files into Neo4j...`);

  try {
    for (const file of files) {
      await session.run(
        `MERGE (f:File {path: $path})
         SET f.externalImports = $externalImports`,
        { path: file.path, externalImports: file.externalImports }
      );

      for (const imp of file.importFiles) {
        await session.run(
          `MERGE (imp:File {path: $impPath})
           MERGE (f:File {path: $path})-[:IMPORTS]->(imp)`,
          { path: file.path, impPath: imp }
        );
      }
    }

    console.log("✅ Import complete.");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await session.close();
    await driver.close();
  }
}

importRepo(files);
