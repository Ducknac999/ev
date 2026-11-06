import { providerStream } from "../lib/ipc";

/**
 * Free models that run on the Mac through Ollama. This is only a list of names: nothing downloads
 * until Install is clicked, and then Ollama fetches it from its own library.
 */
export interface LocalModel {
  name: string;
  label: string;
  /** Download size, GB (about the memory it needs). */
  gb: number;
  about: string;
}

export const LOCAL_MODELS: LocalModel[] = [
  { name: "llama3.2:3b", label: "Llama 3.2 3B", gb: 2.0, about: "Meta · small and quick, good for everyday chat" },
  { name: "llama3.2:1b", label: "Llama 3.2 1B", gb: 1.3, about: "Meta · tiny, fastest" },
  { name: "llama3.1:8b", label: "Llama 3.1 8B", gb: 4.9, about: "Meta · solid all-rounder" },
  { name: "qwen3:4b", label: "Qwen 3 4B", gb: 2.6, about: "Alibaba · smart for its size, thinks step by step" },
  { name: "qwen3:8b", label: "Qwen 3 8B", gb: 5.2, about: "Alibaba · strong reasoning and tools" },
  { name: "qwen3:14b", label: "Qwen 3 14B", gb: 9.3, about: "Alibaba · bigger, smarter" },
  { name: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", gb: 4.7, about: "Alibaba · made for code" },
  { name: "gemma3:4b", label: "Gemma 3 4B", gb: 3.3, about: "Google · small, can read images" },
  { name: "gemma3:12b", label: "Gemma 3 12B", gb: 8.1, about: "Google · capable, can read images" },
  { name: "gemma3:27b", label: "Gemma 3 27B", gb: 17, about: "Google · large, needs a lot of memory" },
  { name: "mistral:7b", label: "Mistral 7B", gb: 4.1, about: "Mistral · classic and fast" },
  { name: "mistral-nemo:12b", label: "Mistral Nemo 12B", gb: 7.1, about: "Mistral · long conversations" },
  { name: "phi4:14b", label: "Phi-4 14B", gb: 9.1, about: "Microsoft · strong at math and logic" },
  { name: "phi4-mini:3.8b", label: "Phi-4 Mini", gb: 2.5, about: "Microsoft · small and sharp" },
  { name: "deepseek-r1:8b", label: "DeepSeek R1 8B", gb: 5.2, about: "DeepSeek · reasons before answering" },
  { name: "deepseek-r1:14b", label: "DeepSeek R1 14B", gb: 9.0, about: "DeepSeek · deeper reasoning" },
  { name: "gpt-oss:20b", label: "GPT-OSS 20B", gb: 14, about: "OpenAI · open model, strong all-round" },
  { name: "llava:7b", label: "LLaVA 7B", gb: 4.7, about: "Reads images" },
  { name: "codellama:7b", label: "Code Llama 7B", gb: 3.8, about: "Meta · code" },
  { name: "smollm2:1.7b", label: "SmolLM2 1.7B", gb: 1.8, about: "Hugging Face · very small" },
];

/** Whether a model fits in this Mac's memory (about 1.3× its size, leaving room for everything else). */
export function fits(model: LocalModel, memoryGb: number): "fits" | "tight" | "too big" {
  if (!memoryGb) return "fits";
  const need = model.gb * 1.3;
  return need <= memoryGb * 0.6 ? "fits" : need <= memoryGb * 0.85 ? "tight" : "too big";
}

/** Downloads a model with Ollama, reporting progress (0–1). Resolves when it's ready. */
export async function pullModel(name: string, onProgress: (fraction: number, status: string) => void, signal: AbortSignal): Promise<void> {
  let buffer = "";
  let failure = "";
  await providerStream(
    "http://localhost:11434/api/pull",
    { "Content-Type": "application/json" },
    { model: name, stream: true },
    (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
          if (event.error) failure = event.error;
          const fraction = event.total ? (event.completed ?? 0) / event.total : event.status === "success" ? 1 : -1;
          onProgress(fraction, event.status ?? "");
        } catch {
          /* a partial line: the rest comes with the next chunk */
        }
      }
    },
    signal,
  );
  if (failure) throw new Error(failure);
}
