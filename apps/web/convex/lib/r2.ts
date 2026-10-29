/**
 * NEO-377 — the one place NeonBinder talks to Cloudflare R2 (S3-compatible),
 * where copy photos live. Default runtime: `aws4fetch` signs with Web Crypto,
 * so this runs in actions and HTTP actions without `"use node"`.
 *
 * Four Convex env vars, per deployment (prod: the prod bucket; dev and the
 * preview defaults: the dev bucket, which expires objects after 14 days):
 *   R2_ENDPOINT          https://<account-id>.r2.cloudflarestorage.com
 *   R2_BUCKET            the bucket name
 *   R2_ACCESS_KEY_ID     an R2 API token's key id (Object Read & Write)
 *   R2_SECRET_ACCESS_KEY that token's secret
 * Missing any of them, `r2Config` returns null and callers refuse plainly.
 *
 * Signing is all this module does with the secret: it never leaves the
 * deployment, and only signed URLs (bearer, short-lived) reach a browser.
 */

import { AwsClient } from "aws4fetch";

export type R2Config = { client: AwsClient; base: string };

/** The deployment's R2 client and bucket URL, or null when not set up. */
export function r2Config(): R2Config | null {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  return { client, base: `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}` };
}

function objectUrl(config: R2Config, key: string, expiresSeconds: number): string {
  const url = new URL(`${config.base}/${key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  return url.toString();
}

/**
 * A presigned PUT for one object. The content type and length are SIGNED,
 * so the browser can upload exactly that many bytes of that type and
 * nothing else; R2 refuses any other.
 */
export async function signedPutUrl(
  config: R2Config,
  key: string,
  contentType: string,
  bytes: number,
  expiresSeconds: number,
): Promise<string> {
  const signed = await config.client.sign(objectUrl(config, key, expiresSeconds), {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(bytes) },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

/** A presigned GET for one object. */
export async function signedGetUrl(config: R2Config, key: string, expiresSeconds: number): Promise<string> {
  const signed = await config.client.sign(objectUrl(config, key, expiresSeconds), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

/** An object's size and type, or null when it isn't there. */
export async function headObject(
  config: R2Config,
  key: string,
): Promise<{ bytes: number; contentType: string | null } | null> {
  const res = await config.client.fetch(`${config.base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "HEAD",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD failed: ${res.status}`);
  return { bytes: Number(res.headers.get("content-length") ?? "-1"), contentType: res.headers.get("content-type") };
}

/** Delete one object. A missing one is fine (S3 answers 204 either way). */
export async function deleteObject(config: R2Config, key: string): Promise<void> {
  const res = await config.client.fetch(`${config.base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE failed: ${res.status}`);
}
