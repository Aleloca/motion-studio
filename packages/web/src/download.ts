/** How long a saved Blob's object URL lives: the browser has started the download well before. */
const REVOKE_MS = 60_000;

/** Saves `blob` as the file `name` (the API's routes need the UI token: their files are fetched, then handed over as a Blob). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}
