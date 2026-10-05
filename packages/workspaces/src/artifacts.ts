import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, copyFile, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import type { ArtifactManifest } from "./types.ts";
import { safeId } from "./process.ts";

export type ArtifactMetadata = Omit<ArtifactManifest, "id" | "sha256" | "size" | "createdAt" | "deviceId">;

export class ArtifactStore {
  constructor(readonly root: string, readonly deviceId: string) {}

  private objectPath(sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid artifact hash");
    return join(this.root, "objects", sha.slice(0, 2), sha);
  }

  async put(data: string | Uint8Array, metadata: ArtifactMetadata): Promise<ArtifactManifest> {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = this.objectPath(sha256);
    await mkdir(join(this.root, "objects", sha256.slice(0, 2)), { recursive: true });
    try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return this.manifest({ ...metadata, sha256, size: bytes.length });
  }

  async putFile(file: string, metadata: ArtifactMetadata): Promise<ArtifactManifest> {
    const { sha256, size } = await hashFile(file);
    const path = this.objectPath(sha256);
    await mkdir(join(this.root, "objects", sha256.slice(0, 2)), { recursive: true });
    try { await copyFile(file, path, constants.COPYFILE_EXCL); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return this.manifest({ ...metadata, sha256, size });
  }

  private async manifest(value: Omit<ArtifactManifest, "id" | "createdAt" | "deviceId">): Promise<ArtifactManifest> {
    const manifest: ArtifactManifest = { ...value, id: randomUUID(), deviceId: this.deviceId, createdAt: new Date().toISOString() };
    await mkdir(join(this.root, "manifests"), { recursive: true });
    await writeFile(join(this.root, "manifests", `${manifest.id}.json`), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  }

  async get(id: string): Promise<ArtifactManifest> {
    return JSON.parse(await readFile(join(this.root, "manifests", `${safeId(id)}.json`), "utf8")) as ArtifactManifest;
  }

  /** Always verify content before returning it for integration or peer delivery. */
  async path(manifest: ArtifactManifest): Promise<string> {
    const path = this.objectPath(manifest.sha256);
    const actual = await hashFile(path);
    if (actual.sha256 !== manifest.sha256 || actual.size !== manifest.size) throw new Error(`Artifact ${manifest.id} failed integrity verification`);
    return path;
  }

  async read(manifest: ArtifactManifest): Promise<Buffer> { return readFile(await this.path(manifest)); }

  /** The network receiver has already assembled chunks; acceptance verifies the complete object. */
  async importFile(file: string, manifest: ArtifactManifest): Promise<void> {
    const actual = await hashFile(file);
    if (actual.sha256 !== manifest.sha256 || actual.size !== manifest.size) throw new Error("Transferred artifact hash or size does not match its manifest");
    const path = this.objectPath(manifest.sha256);
    await mkdir(join(this.root, "objects", manifest.sha256.slice(0, 2)), { recursive: true });
    try { await copyFile(file, path, constants.COPYFILE_EXCL); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await mkdir(join(this.root, "manifests"), { recursive: true });
    const manifestPath = join(this.root, "manifests", `${safeId(manifest.id)}.json`);
    try { await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await this.get(manifest.id);
      if (JSON.stringify(prior) !== JSON.stringify(manifest)) throw new Error("Artifact identifier already belongs to a different immutable manifest");
    }
  }
}

export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), size: (await stat(file)).size };
}

export async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}
