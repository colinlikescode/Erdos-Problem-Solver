import { createHash } from "node:crypto";
import { createWriteStream, statSync, openAsBlob } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) client for run saves. Bucket `starfleet-run-saves`
 * lives in ENAM (near the NYC droplets) with Local Uploads enabled.
 *
 * UPLOAD DESIGN (deliberate - do not "simplify" back to lib-storage):
 * `@aws-sdk/lib-storage` hangs against R2 on slow/HL networks: the
 * CompleteMultipartUpload response is a deferred 200 whose real result arrives
 * later in a streaming body that the SDK reads with NO timeout, on a reused
 * keep-alive socket Cloudflare may have severed upstream (120s proxy read
 * timeout) - and SDK retries can't fire because send() already resolved.
 * So uploads here are presigned, independent PUTs:
 *   - stage the stream to a local temp file (Content-Length must be known),
 *   - ≤ 4 GiB: one presigned PUT (R2 allows 5 GiB) - no multipart at all,
 *   - >  4 GiB: manual multipart with each part its own presigned PUT
 *     (independent, individually retried), then a single Complete call.
 * Checksum injection is disabled (R2 501s on x-amz-checksum-crc32).
 *
 * Credentials are DERIVED from the Cloudflare API token in .env - R2's S3 auth
 * accepts (token-id, sha256(token)) as the access-key pair.
 */
export const RUNS_BUCKET = "starfleet-run-saves";

const PART_SIZE = 512 * 1024 * 1024; // manual-multipart part size (big files only)
const SINGLE_PUT_MAX = 4 * 1024 * 1024 * 1024; // stay under R2's 5 GiB PUT cap

let client: S3Client | null = null;
let clientKey = "";

async function s3(env: Record<string, string>): Promise<S3Client> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = env.CLOUDFLARE_API_KEY || "";
  if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_KEY missing from .env");
  if (client && clientKey === token) return client;

  // access key id = the API token's id (stable), secret = sha256 of the token.
  const verify = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await verify.json()) as { success: boolean; result?: { id: string } };
  if (!body.success || !body.result?.id) throw new Error("Cloudflare token verify failed (cannot derive R2 keys)");

  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: body.result.id,
      secretAccessKey: createHash("sha256").update(token).digest("hex"),
    },
    // R2 doesn't implement the SDK's auto-injected CRC32 headers (501).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { requestTimeout: 120_000, connectionTimeout: 15_000 },
  });
  clientKey = token;
  return client;
}

/** One presigned, independent PUT of [start, end) from a staged file. Its own
 *  connection, its own timeout, retried whole - nothing shared that can wedge. */
async function presignedPut(
  url: string,
  file: string,
  start: number,
  end: number,
  attempts = 5
): Promise<string> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    try {
      // A Blob slice gives fetch a known Content-Length (required by PUT) and
      // reads lazily from disk - no buffering the whole part in memory.
      const blob = (await openAsBlob(file)).slice(start, end);
      const res = await fetch(url, {
        method: "PUT",
        body: blob,
        signal: AbortSignal.timeout(30 * 60_000), // covers the FULL body, unlike the SDK
      });
      if (res.ok) return res.headers.get("etag") || "";
      lastErr = `${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** i, 20_000)));
  }
  throw new Error(`presigned PUT failed after ${attempts} attempts: ${lastErr}`);
}

/**
 * Upload a stream to R2 by staging it to a temp file first (a presigned PUT
 * needs Content-Length). No size limit: big files go part-by-part, each part
 * an independent presigned PUT.
 */
export async function uploadStream(
  env: Record<string, string>,
  key: string,
  stream: Readable,
  onProgress?: (loadedBytes: number) => void
): Promise<number> {
  const c = await s3(env);
  const tmp = join(tmpdir(), `sf-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  try {
    await pipeline(stream, createWriteStream(tmp));
    const size = statSync(tmp).size;

    if (size <= SINGLE_PUT_MAX) {
      const url = await getSignedUrl(c, new PutObjectCommand({ Bucket: RUNS_BUCKET, Key: key }), {
        expiresIn: 3600,
      });
      await presignedPut(url, tmp, 0, size);
      onProgress?.(size);
      return size;
    }

    // Manual multipart: presigned part PUTs (independent), then one Complete.
    const { UploadId } = await c.send(
      new CreateMultipartUploadCommand({ Bucket: RUNS_BUCKET, Key: key })
    );
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      for (let start = 0, n = 1; start < size; start += PART_SIZE, n++) {
        const end = Math.min(start + PART_SIZE, size);
        const url = await getSignedUrl(
          c,
          new UploadPartCommand({ Bucket: RUNS_BUCKET, Key: key, UploadId, PartNumber: n }),
          { expiresIn: 3600 }
        );
        const etag = await presignedPut(url, tmp, start, end);
        parts.push({ PartNumber: n, ETag: etag });
        onProgress?.(end);
      }
      await c.send(
        new CompleteMultipartUploadCommand({
          Bucket: RUNS_BUCKET,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: parts },
        })
      );
      return size;
    } catch (e) {
      await c
        .send(new AbortMultipartUploadCommand({ Bucket: RUNS_BUCKET, Key: key, UploadId }))
        .catch(() => {});
      throw e;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Presigned single-PUT URL (R2 caps one PUT at 5 GiB). The VM curls its
 *  archive straight to this - the laptop never touches the bytes. */
export async function presignPut(env: Record<string, string>, key: string, expiresIn = 3600): Promise<string> {
  const c = await s3(env);
  return getSignedUrl(c, new PutObjectCommand({ Bucket: RUNS_BUCKET, Key: key }), { expiresIn });
}

/** Presigned GET URL - the VM curls the archive straight from R2. */
export async function presignGet(env: Record<string, string>, key: string, expiresIn = 3600): Promise<string> {
  const c = await s3(env);
  return getSignedUrl(c, new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }), { expiresIn });
}

/** Manual multipart for >4GiB VM-side uploads: create -> presigned part URLs
 *  (the VM PUTs each part directly) -> complete/abort from the laptop. */
export async function multipartBegin(env: Record<string, string>, key: string): Promise<string> {
  const c = await s3(env);
  const { UploadId } = await c.send(new CreateMultipartUploadCommand({ Bucket: RUNS_BUCKET, Key: key }));
  return UploadId!;
}

export async function presignPart(
  env: Record<string, string>,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600
): Promise<string> {
  const c = await s3(env);
  return getSignedUrl(
    c,
    new UploadPartCommand({ Bucket: RUNS_BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn }
  );
}

export async function multipartFinish(
  env: Record<string, string>,
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[]
): Promise<void> {
  const c = await s3(env);
  await c.send(
    new CompleteMultipartUploadCommand({
      Bucket: RUNS_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export async function multipartAbort(env: Record<string, string>, key: string, uploadId: string): Promise<void> {
  const c = await s3(env);
  await c.send(new AbortMultipartUploadCommand({ Bucket: RUNS_BUCKET, Key: key, UploadId: uploadId })).catch(() => {});
}

export async function putJson(env: Record<string, string>, key: string, obj: unknown): Promise<void> {
  const c = await s3(env);
  await c.send(
    new PutObjectCommand({
      Bucket: RUNS_BUCKET,
      Key: key,
      Body: JSON.stringify(obj, null, 2),
      ContentType: "application/json",
    })
  );
}

export async function getJson<T>(env: Record<string, string>, key: string): Promise<T> {
  const c = await s3(env);
  const res = await c.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
  const text = await res.Body!.transformToString();
  return JSON.parse(text) as T;
}

/** Open a download stream via a presigned GET (plain fetch - no SDK body wrapper). */
export async function downloadStream(env: Record<string, string>, key: string): Promise<Readable> {
  const c = await s3(env);
  const url = await getSignedUrl(c, new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }), {
    expiresIn: 3600,
  });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`R2 download ${key} failed: ${res.status}`);
  const { Readable: NodeReadable } = await import("node:stream");
  return NodeReadable.fromWeb(res.body as import("node:stream/web").ReadableStream);
}

/** List object keys under a prefix (paginated fully). */
export async function listKeys(env: Record<string, string>, prefix: string): Promise<string[]> {
  const c = await s3(env);
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await c.send(
      new ListObjectsV2Command({ Bucket: RUNS_BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents || []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
