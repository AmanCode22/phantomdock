// Zod validator for loadable adapter.json (schema v2) — validates user edits
// in the popup before they are saved, and bundled presets at build time.

import { z } from 'zod';

const selector = z.string().min(1);
const range = z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine(
  ([min, max]) => min <= max,
  { message: 'range[0] must be <= range[1]' },
);

export const AdapterSchema = z.object({
  $schema: z.literal('phantomdock-adapter-v2'),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  hostMatch: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
  selectors: z.object({
    chatContainer: selector,
    messageList: selector,
    userMessage: selector,
    assistantMessage: selector,
    messageMarkdownBody: selector,
    streamingIndicator: selector,
    inputBox: selector,
    sendButton: selector,
    pillMountAnchor: selector,
    rateLimitBanner: selector,
    challengeBanner: selector,
  }),
  fileUpload: z.object({
    supported: z.boolean(),
    preferInlineOverUpload: z.boolean(),
    cascadeOrder: z.array(z.enum(['input', 'paste', 'drop'])),
    fileInputSelector: selector,
    dropZoneSelector: selector,
    attachmentChipSelector: selector,
    uploadingSpinnerSelector: selector,
    uploadTimeoutMs: z.number().int().min(500),
    fallbackToInlineOnFailure: z.boolean(),
  }),
  inlineSkills: z.object({
    chunkSizeChars: z.number().int().min(200),
    autoSendAllParts: z.boolean(),
  }),
  inputBehavior: z.object({
    inputType: z.enum(['auto', 'textarea', 'contenteditable']),
    submitMethod: z.enum(['click', 'enter']),
    submitDelayRangeMs: range,
    interTurnDelayRangeMs: range,
    sendEnableTimeoutMs: z.number().int().min(200),
    randomizeClickCoords: z.boolean(),
    clearBeforeInsert: z.boolean(),
  }),
  loopProtection: z.object({
    requireVisibleTab: z.boolean(),
    cooldownSeconds: z.number().int().min(1),
    backoffMultiplier: z.number().min(1),
    maxCooldownSeconds: z.number().int().min(1),
    maxConsecutiveAutoTurns: z.number().int().min(1),
    maxAutomatedTurnsPerHour: z.number().int().min(1),
  }),
});

export type AdapterDef = z.infer<typeof AdapterSchema>;

export function validateAdapter(v: unknown): { ok: true; def: AdapterDef } | { ok: false; error: string } {
  const res = AdapterSchema.safeParse(v);
  if (res.success) {
    return { ok: true, def: res.data };
  }
  const issues = res.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
