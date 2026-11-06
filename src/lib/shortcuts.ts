/** Names for the keys E.V can watch from any app (hold to talk, approval shortcuts). */

export const SINGLE_KEYS: { id: string; label: string }[] = [
  { id: "fn", label: "fn (🌐) on its own" },
  { id: "rightoption", label: "Right Option (⌥) on its own" },
  { id: "rightcommand", label: "Right Command (⌘) on its own" },
  { id: "rightcontrol", label: "Right Control (⌃) on its own" },
  { id: "rightshift", label: "Right Shift (⇧) on its own" },
];
export const COMBOS = ["control+option+space", "command+shift+space", "control+space", "option+space", "f5"];
const MOD_SYMBOL: Record<string, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };

/** "control+option+space" → "⌃⌥Space"; single keys get their name. */
export function shortcutLabel(shortcut: string): string {
  const single = SINGLE_KEYS.find((k) => k.id === shortcut);
  if (single) return single.label;
  const parts = shortcut.split("+");
  const key = parts.pop() ?? "";
  return `${parts.map((m) => MOD_SYMBOL[m] ?? m).join("")}${key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)}`;
}
