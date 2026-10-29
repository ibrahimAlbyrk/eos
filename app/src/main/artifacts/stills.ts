import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// JPEG stills of artifact views, one per `slug@version` (versions are immutable,
// so a versioned still never goes stale; "live" = no version known). The panel
// and the peek paint one at once while the live view loads.

const KEEP = 300;

export class StillStore {
  private readonly dir: string;
  private pruning = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(slug: string, version: string | undefined): string {
    const v = version ? version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) : "live";
    return path.join(this.dir, `${slug.replace(/[^A-Za-z0-9-]/g, "")}@${v}.jpg`);
  }

  async has(slug: string, version: string | undefined): Promise<boolean> {
    try {
      await access(this.file(slug, version));
      return true;
    } catch {
      return false;
    }
  }

  async read(slug: string, version: string | undefined): Promise<string | null> {
    try {
      const bytes = await readFile(this.file(slug, version));
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }

  async write(slug: string, version: string | undefined, jpeg: Buffer): Promise<void> {
    const file = this.file(slug, version);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, jpeg);
    await rename(tmp, file);
    void this.prune();
  }

  // Keep the newest KEEP stills.
  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const names = (await readdir(this.dir)).filter((n) => n.endsWith(".jpg"));
      if (names.length <= KEEP) return;
      const dated = await Promise.all(names.map(async (n) => ({
        n,
        at: (await stat(path.join(this.dir, n)).catch(() => null))?.mtimeMs ?? 0,
      })));
      dated.sort((a, b) => b.at - a.at);
      await Promise.all(dated.slice(KEEP).map((d) => unlink(path.join(this.dir, d.n)).catch(() => {})));
    } catch (e) {
      console.error("[eos-artifacts] still prune failed:", e instanceof Error ? e.message : String(e));
    } finally {
      this.pruning = false;
    }
  }
}
