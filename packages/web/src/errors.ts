/** The text of a thrown value: an Error's message (an ApiError carries the server's explanation), or the value itself. */
export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
