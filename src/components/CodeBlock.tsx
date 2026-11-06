import { useRef, useState, type ComponentProps } from "react";
import { Icon } from "./Icon";

/** Fenced code block with language label and copy-to-clipboard. */
export function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const codeClass = (ref.current?.querySelector("code")?.className ?? "") || findLanguageClass(children);
  const language = /language-([\w+-]+)/.exec(codeClass)?.[1];

  const copy = async () => {
    const text = ref.current?.querySelector("code")?.textContent ?? ref.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language ?? "code"}</span>
        <button className="code-copy" onClick={copy} aria-label="Copy code">
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}

function findLanguageClass(children: unknown): string {
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child as { props?: { className?: string } } | null)?.props?.className;
  return typeof className === "string" ? className : "";
}
