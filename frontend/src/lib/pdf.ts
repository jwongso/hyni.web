// Client-side PDF text extraction via pdfjs-dist.
//
// The resume / CV uploaded on the Settings page is sensitive PII. We
// extract its plain text fully in the browser and never send the PDF
// bytes anywhere — the extracted text lives in localStorage and is
// injected into LLM system prompts.
//
// Vite-friendly worker loading: we import the worker as a URL and pin it
// onto pdfjs.GlobalWorkerOptions before first use, which makes the worker
// load from our own origin (no CDN fetch).

import * as pdfjs from 'pdfjs-dist';
// eslint-disable-next-line import/no-unresolved
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let workerInited = false;
function ensureWorker(): void {
  if (workerInited) return;
  (pdfjs as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  workerInited = true;
}

/**
 * Extract plain text from a PDF File.
 *
 * - Joins items on a page with single spaces (pdfjs returns per-glyph runs).
 * - Inserts a blank line between pages.
 * - Trims excessive whitespace runs.
 */
export async function pdfToText(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<string> {
  ensureWorker();
  const ab = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: ab }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it: any) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    pages.push(text);
  }
  return pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function isPdfFile(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return file.name.toLowerCase().endsWith('.pdf');
}
