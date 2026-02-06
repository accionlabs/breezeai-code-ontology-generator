#!/usr/bin/env node

const minimist = require("minimist");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const url = require("url");

const args = minimist(process.argv.slice(2), {
  alias: {
    k: "api-key",
    u: "uuid",
    b: "baseurl",
    p: "path",
  },
  string: ["api-key", "uuid", "baseurl", "path"],
});

function printUsage() {
  console.error(
    `Usage:\n` +
    `  upload-docs --api-key <key> --uuid <uuid> --baseurl <url> --path <file-or-dir>\n\n` +
    `Options:\n` +
    `  --api-key, -k <key>       API key for authentication (required)\n` +
    `  --uuid, -u <uuid>         UUID identifier (required)\n` +
    `  --baseurl, -b <url>       Base URL of the API (required)\n` +
    `  --path, -p <file-or-dir>  File or directory to upload (required)\n\n` +
    `When a directory is provided, all files in it are uploaded.\n`
  );
}

function validate() {
  console.log("args:", args); // Debugging line to print parsed arguments 
  const errors = [];
  if (!args["api-key"]) errors.push("--api-key is required");
  if (!args["uuid"]) errors.push("--uuid is required");
  if (!args["baseurl"]) errors.push("--baseurl is required");
  if (!args["path"]) errors.push("--path is required");

  if (errors.length > 0) {
    errors.forEach((e) => console.error(`Error: ${e}`));
    console.error("");
    printUsage();
    process.exit(1);
  }
}

function resolveFiles() {
  const files = [];
  const targetPath = path.resolve(args["path"]);

  if (!fs.existsSync(targetPath)) {
    console.error(`Path not found: ${targetPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(targetPath);

  if (stat.isFile()) {
    files.push(targetPath);
  } else if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry);
      if (fs.statSync(fullPath).isFile()) {
        files.push(fullPath);
      }
    }
    if (files.length === 0) {
      console.error(`No files found in directory: ${targetPath}`);
      process.exit(1);
    }
  } else {
    console.error(`Not a file or directory: ${targetPath}`);
    process.exit(1);
  }

  return files;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
    '.md': 'text/markdown',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function buildMultipartBody(filePath, uuid, boundary) {
  const fileName = path.basename(filePath);
  const fileContent = fs.readFileSync(filePath);
  const contentType = getMimeType(filePath);

  const parts = [];

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    )
  );
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n`));

  // UUID field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="uuid"\r\n\r\n` +
      `${uuid}\r\n`
    )
  );

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return Buffer.concat(parts);
}

function uploadFile(filePath, apiKey, uuid, baseurl) {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const body = buildMultipartBody(filePath, uuid, boundary);

    const uploadUrl = baseurl.replace(/\/+$/, "") + "/documents/upload";
    const parsedUrl = url.parse(uploadUrl);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "api-key": apiKey,
      },
    };

    const req = protocol.request(uploadUrl, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
            console.log(`    Response: ${JSON.stringify(parsed)}`);
          } catch {
            parsed = data;
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        } else {
          console.error(`Error response: HTTP ${res.statusCode} - ${data}`);
          reject(
            new Error(
              `Upload failed for ${path.basename(filePath)}: HTTP ${res.statusCode} - ${res.statusMessage}`
            )
          );
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error uploading ${path.basename(filePath)}: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  validate();

  const apiKey = args["api-key"];
  const uuid = args["uuid"];
  const baseurl = args["baseurl"];
  const files = resolveFiles();

  console.log(`\nUploading ${files.length} file(s) to ${baseurl}/documents/upload\n`);

  let successCount = 0;
  let failCount = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    try {
      process.stdout.write(`  Uploading ${fileName}...`);
      const result = await uploadFile(filePath, apiKey, uuid, baseurl);
      console.log(` done (HTTP ${result.statusCode})`);
      successCount++;
    } catch (err) {
      console.log(` FAILED`);
      console.error(`    ${err.message}`);
      failCount++;
    }
  }

  console.log(`\nUpload complete: ${successCount} succeeded, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

// Allow running standalone or importing
if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

module.exports = { uploadFile, resolveFiles };
