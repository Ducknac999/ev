/** Incremental Server-Sent Events parser: feed raw text, receive each event's `data` payload. */
export class SseParser {
  private buffer = "";
  /** First error thrown by the data handler; streaming callbacks cannot propagate it directly. */
  error: Error | null = null;

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.dispatch(block);
    }
  }

  flush(): void {
    if (this.buffer.trim()) this.dispatch(this.buffer);
    this.buffer = "";
  }

  private dispatch(block: string): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || this.error) return;
    try {
      this.onData(data);
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err));
    }
  }
}
