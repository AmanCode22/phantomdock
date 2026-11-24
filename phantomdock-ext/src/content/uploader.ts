// Cascading skill file uploader: input -> paste -> drop -> chunked inline.
// Constructs a File in a DataTransfer and verifies the attachment chip appears.

import { sleep } from '../shared/protocol';
import type { AdapterDef } from '../adapters/schema';
import { isElementVisible, type InputEl } from './injector';

export type AttachOutcome = { mode: 'upload' } | { mode: 'inline'; reason: string };

export function buildSkillFile(filename: string, content: string): File {
  return new File([content], filename, { type: 'text/markdown' });
}

/** Try the `input` strategy: set files on a (possibly hidden) file input. */
async function tryInput(adapter: AdapterDef, file: File): Promise<boolean> {
  let input: HTMLInputElement | null = null;
  try {
    input = document.querySelector<HTMLInputElement>(adapter.fileUpload.fileInputSelector);
  } catch {
    return false;
  }
  if (!input) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** Try the `paste` strategy: ClipboardEvent with clipboardData on the input box. */
async function tryPaste(inputEl: InputEl | null, file: File): Promise<boolean> {
  if (!inputEl) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  inputEl.focus();
  inputEl.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
  );
  return true;
}

/** Try the `drop` strategy: dragenter -> dragover -> drop on the drop zone. */
async function tryDrop(adapter: AdapterDef, file: File): Promise<boolean> {
  let zone: HTMLElement | null = null;
  try {
    zone = document.querySelector<HTMLElement>(adapter.fileUpload.dropZoneSelector);
  } catch {
    return false;
  }
  if (!zone) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  const rect = zone.getBoundingClientRect();
  const opts = {
    bubbles: true,
    cancelable: true,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    dataTransfer: dt,
  };
  zone.dispatchEvent(new DragEvent('dragenter', opts));
  zone.dispatchEvent(new DragEvent('dragover', opts));
  zone.dispatchEvent(new DragEvent('drop', opts));
  return true;
}

/** Wait for a visible attachment chip & no visible spinner within uploadTimeoutMs. */
async function waitForAttachment(adapter: AdapterDef): Promise<boolean> {
  const deadline = Date.now() + adapter.fileUpload.uploadTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const chips = [...document.querySelectorAll(adapter.fileUpload.attachmentChipSelector)];
      const visibleChip = chips.some((c) => isElementVisible(c));
      if (visibleChip) {
        const spinners = [...document.querySelectorAll(adapter.fileUpload.uploadingSpinnerSelector)];
        const stillUploading = spinners.some((s) => isElementVisible(s));
        if (!stillUploading) return true;
      }
    } catch {
      return false;
    }
    await sleep(300);
  }
  return false;
}

/**
 * Attach a skill file via the adapter's cascade order. Falls back to inline
 * delivery when uploads are unsupported, fail, or the adapter prefers inline.
 */
export async function attachSkillFile(
  adapter: AdapterDef,
  inputEl: InputEl | null,
  filename: string,
  content: string,
): Promise<AttachOutcome> {
  if (!adapter.fileUpload.supported || adapter.fileUpload.preferInlineOverUpload) {
    return {
      mode: 'inline',
      reason: adapter.fileUpload.preferInlineOverUpload
        ? 'adapter prefers inline delivery'
        : 'uploads not supported on this site',
    };
  }
  const file = buildSkillFile(filename, content);

  for (const strategy of adapter.fileUpload.cascadeOrder) {
    let dispatched = false;
    if (strategy === 'input') dispatched = await tryInput(adapter, file);
    else if (strategy === 'paste') dispatched = await tryPaste(inputEl, file);
    else if (strategy === 'drop') dispatched = await tryDrop(adapter, file);
    if (!dispatched) continue;
    if (await waitForAttachment(adapter)) {
      return { mode: 'upload' };
    }
    detachPendingAttachment(adapter);
  }

  if (adapter.fileUpload.fallbackToInlineOnFailure) {
    return { mode: 'inline', reason: 'all upload strategies failed' };
  }
  return { mode: 'inline', reason: 'upload failed and fallback is disabled' };
}

/** Best-effort removal of a dangling attachment chip via its close button. */
function detachPendingAttachment(adapter: AdapterDef): void {
  try {
    const chip = document.querySelector<HTMLElement>(adapter.fileUpload.attachmentChipSelector);
    if (!chip) return;
    const close = chip.querySelector<HTMLElement>(
      "button, [class*='close'], [class*='remove'], [role='button']",
    );
    close?.click();
  } catch {
    /* ignore */
  }
}
