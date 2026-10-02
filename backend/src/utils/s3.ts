/**
 * S3-compatible object storage client (Backblaze B2).
 *
 * Used for receipt uploads. All uploads go through this module - feature
 * code should never touch the S3 client directly.
 *
 * Buckets are private. All file access is via short-lived presigned URLs
 * generated per request. Files are never public.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from '../logger';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // required for B2 (and most non-AWS S3 providers)
});

/** Upload a file buffer to the bucket. Returns the object key. */
export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<string> {
  const input: PutObjectCommandInput = {
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  };

  await s3.send(new PutObjectCommand(input));
  logger.info({ key, sizeBytes: body.length, contentType }, 'S3: uploaded');
  return key;
}

/** Generate a presigned URL for temporary download access. Default: 5 minutes. */
export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
  return url;
}

/** Delete an object. Idempotent - deleting a missing key is not an error. */
export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  logger.info({ key }, 'S3: deleted');
}

/** Health check - verifies the bucket is reachable with our credentials. */
export async function testS3(): Promise<
  | { ok: true; latencyMs: number; bucket: string }
  | { ok: false; error: string }
> {
  const start = Date.now();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return { ok: true, latencyMs: Date.now() - start, bucket: env.S3_BUCKET };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}