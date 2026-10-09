// Remote images for visual answers (entity images, og:image, site icons). The
// adapter owns the SSRF guard (http/https only, private ranges refused, redirects
// re-checked, timeouts, size + type caps) and the disk cache. Every method
// resolves null when nothing usable comes back — the kit then shows a monogram.

export interface MediaBlob {
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly etag: string;
  readonly fetchedAt: number;
}

export interface MediaFetcher {
  // An image URL as written in the spec.
  image(src: string): Promise<MediaBlob | null>;
  // A page's og:image / twitter:image.
  og(pageUrl: string): Promise<MediaBlob | null>;
  // A site's icon by domain (apple-touch-icon → icon → favicon).
  icon(site: string): Promise<MediaBlob | null>;
}
