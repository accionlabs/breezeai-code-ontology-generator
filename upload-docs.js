const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const url = require("url");

function resolveFiles(targetInput) {
  const files = [];
  const targetPath = path.resolve(targetInput);

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
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
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

async function run(opts) {
  const apiKey = opts.apiKey;
  const uuid = opts.uuid;
  const baseurl = opts.baseurl;
  const files = resolveFiles(opts.path);

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

module.exports = { run, uploadFile, resolveFiles };
