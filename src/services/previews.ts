import { create } from "zustand";
import { uid } from "../lib/ids";

/**
 * Pictures shown on approval cards (e.g. the drafted Discord message). Held in memory only:
 * they are never written into the saved chat history.
 */
export const usePreviews = create<{ images: Record<string, string> }>(() => ({ images: {} }));

const LIMIT = 30;

export function keepPreview(base64Jpeg: string): string {
  const id = uid("img-");
  usePreviews.setState((s) => {
    const entries = Object.entries(s.images).slice(-(LIMIT - 1));
    return { images: { ...Object.fromEntries(entries), [id]: `data:image/jpeg;base64,${base64Jpeg}` } };
  });
  return id;
}

export function dropPreview(id: string): void {
  usePreviews.setState((s) => {
    const { [id]: _gone, ...rest } = s.images;
    return { images: rest };
  });
}
