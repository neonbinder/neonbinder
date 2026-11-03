/** The server's own sentence from a refusal thrown as a ConvexError, if it sent one. */
export function refusalSentence(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown; error?: unknown }).message ?? (data as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}
