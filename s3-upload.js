const { PassThrough } = require("stream");
const zlib = require("zlib");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION, AWS_S3_BUCKET } = require("./app-config");

/**
 * Creates a streaming pipeline: PassThrough → gzip → S3 multipart upload.
 *
 * @param {string} s3Key - The S3 object key (e.g. "code-ontology/{uuid}/{commit}.ndjson.gz")
 * @returns {{ passThrough: import("stream").PassThrough, uploadPromise: Promise<void> }}
 */
function createS3UploadStream(s3Key) {
  if (!AWS_S3_BUCKET) {
    throw new Error("AWS_S3_BUCKET is not configured");
  }

  const s3Client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY,
      secretAccessKey: AWS_SECRET_KEY,
    },
  });

  const passThrough = new PassThrough();
  const gzip = zlib.createGzip();

  const gzipStream = passThrough.pipe(gzip);

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: AWS_S3_BUCKET,
      Key: s3Key,
      Body: gzipStream,
      ContentType: "application/x-ndjson",
      ContentEncoding: "gzip",
    },
    queueSize: 4,
    // Data under partSize is sent as a single PutObject (no multipart needed).
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  });

  const uploadPromise = upload.done().then(() => {
    console.log(`S3 upload complete: s3://${AWS_S3_BUCKET}/${s3Key}`);
  });

  return { passThrough, uploadPromise };
}

module.exports = { createS3UploadStream };
