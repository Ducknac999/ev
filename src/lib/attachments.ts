import { modelLabel, seesImages } from "../providers/catalog";
import type { Attachment, AttachmentKind, ModelRef } from "../types";
import { uid } from "./ids";
import { attachmentSave } from "./ipc";

/** Gemini takes files inline; a request may carry about 20 MB in total. */
export const GEMINI_INLINE_BUDGET = 19 * 1024 * 1024;
/** Text files are pasted into the prompt; longer ones are cut to keep requests sane. */
export const MAX_TEXT_CHARS = 200_000;

/** Image formats Gemini accepts as-is; anything else is converted to PNG on attach. */
const GEMINI_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown csv tsv json jsonl xml yaml yml toml ini cfg conf log env html htm css scss sass less " +
    "js jsx ts tsx mjs cjs py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish sql graphql " +
    "vue svelte astro lua r dart scala clj ex exs erl hs ml tex bib gradle properties gitignore dockerfile makefile"
  ).split(" "),
);

const extension = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** True when the first bytes look like text (no NUL bytes, decodes as UTF-8). */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export function classify(name: string, mime: string, head: Uint8Array): AttachmentKind {
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime === "application/pdf" || extension(name) === "pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "image/svg+xml" || TEXT_EXTENSIONS.has(extension(name))) return "text";
  if (mime === "application/json" || mime === "application/xml") return "text";
  return looksLikeText(head) ? "text" : "binary";
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "images",
  pdf: "PDFs",
  text: "text files",
  audio: "audio",
  video: "video",
  binary: "this file type",
};

/** What each provider can take in. Claude reads files from disk with its Read tool. */
const READABLE: Record<ModelRef["provider"], ReadonlySet<AttachmentKind>> = {
  claude: new Set(["image", "pdf", "text"]),
  gemini: new Set(["image", "pdf", "text", "audio", "video"]),
  groq: new Set(["text"]),
  deepseek: new Set(["text"]),
  openai: new Set(["image", "text"]),
  openrouter: new Set(["text"]),
  xai: new Set(["image", "text"]),
  anthropic: new Set(["image", "text"]),
  mistral: new Set(["text"]),
  ollama: new Set(["text"]),
  custom: new Set(["text"]),
};

/** Why `model` cannot take this attachment, or null when it can. */
export function unsupportedReason(model: ModelRef, attachment: Pick<Attachment, "kind" | "size" | "name">): string | null {
  const readable = attachment.kind === "image" && seesImages(model.model);
  if (!readable && !READABLE[model.provider].has(attachment.kind)) {
    return `${modelLabel(model)} can't read ${KIND_LABEL[attachment.kind]}`;
  }
  if (model.provider === "gemini" && attachment.kind !== "text" && attachment.size > GEMINI_INLINE_BUDGET) {
    return `${attachment.name} is over Gemini's 19 MB limit`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall back to an <img> decode (e.g. formats ImageBitmap rejects) */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(image: ImageBitmap | HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const width = "naturalWidth" in image ? image.naturalWidth : image.width;
  const height = "naturalHeight" in image ? image.naturalHeight : image.height;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode image"))), type, quality),
  );

/**
 * Copies a picked, pasted or dropped file into E.V's attachments folder and describes it.
 * Images get a small preview; formats Gemini can't take (GIF, BMP, TIFF…) are stored as PNG.
 */
export async function prepareAttachment(file: File): Promise<Attachment> {
  return prepareBytes(new Uint8Array(await file.arrayBuffer()), file.name || "pasted-image.png", file.type || mimeFromName(file.name));
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
};

export function mimeFromName(name: string): string {
  return MIME_BY_EXT[extension(name)] ?? "application/octet-stream";
}

/** Same as prepareAttachment, for raw bytes (files dropped from Finder arrive as paths). */
export async function prepareBytes(input: Uint8Array, originalName: string, originalMime: string): Promise<Attachment> {
  let bytes = input;
  let name = originalName;
  let mime = originalMime || "application/octet-stream";
  const kind = classify(name, mime, bytes.subarray(0, 4096));
  let preview: string | undefined;

  if (kind === "image") {
    try {
      const image = await decodeImage(new Blob([bytes as BlobPart], { type: mime }));
      preview = draw(image, 360).toDataURL("image/jpeg", 0.8);
      if (!GEMINI_IMAGE_TYPES.has(mime)) {
        const png = await toBlob(draw(image, 4096), "image/png");
        bytes = new Uint8Array(await png.arrayBuffer());
        mime = "image/png";
        name = name.replace(/\.[^.]+$/, "") + ".png";
      }
    } catch {
      /* undecodable image: keep the original bytes without a preview */
    }
  }
  if (kind === "text" && !mime.startsWith("text/")) mime = "text/plain";

  const path = await attachmentSave(bytes, name);
  return { id: uid("att-"), name, mime, size: bytes.length, kind, path, preview };
}
