## 🧩 Overview

The tool operates in **two stages**:

1. **Code Parsing & JSON Generation**  
   Parses a Perl repository and outputs:
   - A **package-to-path mapper JSON** — maps each Perl package to its corresponding file path.  
   - A **file dependency tree JSON** — captures which files import or depend on others.

2. **Graph Migration to Neo4j**  
   Reads the generated dependency JSON and imports it into Neo4j, using a configuration file for DB connection.

---

## ⚙️ Prerequisites

- **Node.js v18+**
- **Neo4j Database** (local or remote)
- A `config.json` file containing Neo4j credentials
- Basic understanding of Perl package structure (`.pl` and `.pm` files)

---

## 🗂️ Repository Structure

```
.
├── config/
│   └── config.json              # Contains Neo4j connection details
├── file-tree-mapper.js          # Script to analyze Perl repo and create JSONs
├── tree-to-graph.js             # Script to migrate dependency JSON into Neo4j
├── package-lock.json
├── README.md
└── output/
    ├── package-path-mapper.json
    └── file-dependency-tree.json
```

---

## ⚙️ Configuration Setup

Before running the scripts, configure your Neo4j connection details in `config/config.json`:

```json
{ 
    "dbConfig": {
        "dbUrl": "neo4j://localhost:7687",
        "username": "neo4j",
        "password": "12345678",
        "dbName": "codeviz"
    }


}
```

This file will be automatically read by `tree-to-graph.js` for database connection.

---

## 🚀 Usage

### Step 1: Generate the File Tree and Mapper JSONs

Run the following command to analyze your Perl repository:

```bash
node file-tree-mapper.js <path-to-perl-repo> <output-mapper-json-filename> <output-file-tree-json>
```

**Example:**
```bash
node file-tree-mapper.js ./perl-app ./output/package-path-mapper.json ./output/file-dependency-tree.json
```

This will:
- Recursively scan the Perl repository.
- Identify `.pl` and `.pm` files.
- Parse `package`, `use`, and `require` statements.
- Generate:
  - `package-path-mapper.json` — maps package names to file paths.
  - `file-dependency-tree.json` — shows which files depend on which.

---

### Step 2: Migrate the Dependency Tree to Neo4j

Once the JSON is generated, run the graph migration command:

```bash
node tree-to-graph.js <path-to-file-dependency-tree-json>
```

**Example:**
```bash
node tree-to-graph.js ./output/file-dependency-tree.json
```

This script will:
- Read Neo4j credentials from `config/config.json`.
- Connect to your Neo4j database.
- Create `File` nodes and `IMPORTS` relationships.
- Populate the graph for exploration.

---

## 🧠 Example Neo4j Queries

View all file relationships:

```cypher
MATCH (f:File)-[:IMPORTS]->(d:File)
RETURN f, d
```

List files that are not imported by any other file:

```cypher
MATCH (f:File)
WHERE NOT ()-[:IMPORTS]->(f)
RETURN f
```

---

## 🧱 Data Model

**Node Labels:**
- `File` — represents a `.pl` or `.pm` file.

**Relationships:**
- `[:IMPORTS]` — indicates one file depends on another.

---

## ⚠️ Notes

- Ensure the Neo4j database is running before executing the migration script.
- Update credentials in `config/config.json` instead of editing scripts.
- The parser assumes standard Perl module naming conventions (`Package::SubPackage → Package/SubPackage.pm`).

---

## 📄 License

This project is licensed under the MIT License.
