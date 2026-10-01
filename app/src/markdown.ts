// Markdown -> sanitized HTML rendering for the "Rendered View" toggle. Kept
// separate from editor.ts/CodeMirror entirely: this only ever backs a
// read-only <div>, never an editable view, and involves no CodeMirror
// language mode.

import { marked } from "marked";
import DOMPurify from "dompurify";

/** Converts Markdown source to sanitized HTML safe to assign to
 * innerHTML. Sanitizing is required because Markdown itself is allowed to
 * contain raw HTML. */
export function renderMarkdownToSafeHtml(source: string): string {
  const rawHtml = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml);
}
