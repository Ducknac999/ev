export function uid(prefix = ""): string {
  return prefix + crypto.randomUUID();
}
