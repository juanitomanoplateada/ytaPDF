import type { SavedSession } from "./session";
import { createZip, readZip } from "./zip";

/**
 * Project files (.ytapdf): the whole work in one file that can be opened
 * later, on this or another device. It is a ZIP with the original PDFs, the
 * images placed on the pages and a JSON description of the pages,
 * annotations, form values and page decorations. Passwords are not saved:
 * protected PDFs ask for theirs again.
 */

export const PROJECT_EXTENSION = ".ytapdf";
const MANIFEST = "proyecto.json";

interface ProjectManifest extends Omit<SavedSession, "sources" | "images"> {
  format: "ytapdf-proyecto";
  sources: { id: string; name: string; file: string }[];
  images: { url: string; mime: "image/png" | "image/jpeg"; file: string }[];
}

export function isProjectFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(PROJECT_EXTENSION);
}

export function writeProject(session: SavedSession): Uint8Array {
  const { sources, images, ...rest } = session;
  const manifest: ProjectManifest = {
    ...rest,
    format: "ytapdf-proyecto",
    sources: sources.map((source, i) => ({ id: source.id, name: source.name, file: `documentos/${i + 1}.pdf` })),
    images: images.map((image, i) => ({
      url: image.url,
      mime: image.mime,
      file: `imagenes/${i + 1}.${image.mime === "image/png" ? "png" : "jpg"}`,
    })),
  };
  return createZip([
    { name: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
    ...sources.map((source, i) => ({ name: manifest.sources[i].file, bytes: source.bytes })),
    ...images.map((image, i) => ({ name: manifest.images[i].file, bytes: image.bytes })),
  ]);
}

export async function readProject(bytes: Uint8Array): Promise<SavedSession> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch {
    throw new ProjectError();
  }
  const raw = files.get(MANIFEST);
  if (!raw) throw new ProjectError();
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as ProjectManifest;
  if (manifest.format !== "ytapdf-proyecto" || !Array.isArray(manifest.pages)) throw new ProjectError();
  const { format: _format, sources, images, ...rest } = manifest;
  return {
    ...rest,
    sources: sources
      .filter((source) => files.has(source.file))
      .map((source) => ({ id: source.id, name: source.name, bytes: files.get(source.file)! })),
    images: images
      .filter((image) => files.has(image.file))
      .map((image) => ({ url: image.url, mime: image.mime, bytes: files.get(image.file)! })),
  };
}

export class ProjectError extends Error {
  constructor() {
    super("El archivo no es un proyecto de ytaPDF o está dañado.");
  }
}
