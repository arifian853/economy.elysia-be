import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MAX_EVIDENCE_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

type FileInfo = { name: string; type: string; size: number };
type Validation = { ok: true; safeName?: string } | { ok: false; reason: string };

export function validateEvidenceLink(raw: string): Validation {
  if (raw.length > 2048) return { ok: false, reason: "Tautan maksimal 2048 karakter." };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return { ok: false, reason: "Gunakan tautan HTTPS tanpa informasi login." };
    return { ok: true };
  } catch {
    return { ok: false, reason: "Tautan tidak valid." };
  }
}

export function validateEvidenceFile(file: FileInfo): Validation {
  if (!file.name.trim() || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name)) return { ok: false, reason: "Nama file tidak valid." };
  if (!ALLOWED_TYPES.has(file.type)) return { ok: false, reason: "Format bukti harus JPG, PNG, WebP, atau PDF." };
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_EVIDENCE_BYTES) return { ok: false, reason: "Ukuran file harus di bawah 12 MiB." };
  return { ok: true, safeName: file.name.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, "_") };
}

export function evidenceMagicMatches(type: string, bytes: Uint8Array): boolean {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (type === "application/pdf") return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  return false;
}

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
export function readR2Config(env: Record<string, string | undefined> = process.env): R2Config {
  const { CLOUDFLARE_R2_ACCOUNT_ID: accountId, CLOUDFLARE_R2_ACCESS_KEY_ID: accessKeyId,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: secretAccessKey, CLOUDFLARE_R2_BUCKET: bucket } = env;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("Cloudflare R2 environment is not configured.");
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

let clientCache: { key: string; client: S3Client; bucket: string } | undefined;
function getR2() {
  const config = readR2Config();
  const key = `${config.accountId}:${config.accessKeyId}:${config.bucket}`;
  if (!clientCache || clientCache.key !== key) {
    clientCache = {
      key, bucket: config.bucket,
      client: new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }),
    };
  }
  return clientCache;
}

export async function storeEvidence(userId: string, transactionId: string, file: File, bytes: Uint8Array, safeName: string) {
  const { client, bucket } = getR2();
  const objectKey = `economy/${userId}/${transactionId}/${randomUUID()}`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: file.type, ContentLength: bytes.byteLength,
    Metadata: { filename: encodeURIComponent(safeName) } }));
  return objectKey;
}

export async function createEvidenceReadUrl(objectKey: string): Promise<string> {
  const { client, bucket } = getR2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn: 600 });
}

export async function deleteEvidenceObject(objectKey: string): Promise<void> {
  const { client, bucket } = getR2();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}
