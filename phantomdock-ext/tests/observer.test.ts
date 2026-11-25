// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import preset from '../src/adapters/chatgpt.json';
import { validateAdapter } from '../src/adapters/schema';
import { StreamObserver } from '../src/content/observer';
import * as parser from '../src/content/parser';

const validation = validateAdapter(preset);
if (!validation.ok) throw new Error('Invalid ChatGPT test adapter');
const adapter = validation.def;
const call = { id: 'call_1', name: 'read_file', args: { path: 'README.md' } };
const fencedCall = '\x60\x60\x60pdock_call\n' + JSON.stringify(call) + '\n\x60\x60\x60';

describe('StreamObserver', () => {
  let observer: StreamObserver;
  let onToolTurn: ReturnType<typeof vi.fn>;
  let assistant: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><article data-message-author-role="assistant"></article></main><aside></aside>';
    assistant = document.querySelector('article')!;
    onToolTurn = vi.fn();
    observer = new StreamObserver(adapter, {
      onToolTurn,
      onToolResultUserMessage: vi.fn(),
    });
    observer.start();
  });

  afterEach(() => {
    observer.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('detects a completed tool call while unrelated UI keeps changing', async () => {
    assistant.textContent = fencedCall;
    const sidebar = document.querySelector('aside')!;
    for (let i = 0; i < 8; i++) {
      sidebar.className = `tick-${i}`;
      await vi.advanceTimersByTimeAsync(135);
    }
    expect(onToolTurn).toHaveBeenCalledTimes(1);
    expect(onToolTurn).toHaveBeenCalledWith([call], assistant);
  });

  it('parses a stable plain answer once and still examines later content', async () => {
    const parse = vi.spyOn(parser, 'parsePdockCallsFromElement');
    assistant.textContent = 'A regular answer.';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(onToolTurn).not.toHaveBeenCalled();

    assistant.textContent = fencedCall;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onToolTurn).toHaveBeenCalledTimes(1);
    expect(onToolTurn).toHaveBeenCalledWith([call], assistant);
  });

  it('waits for a full quiet window after the assistant text changes', async () => {
    assistant.textContent = fencedCall;
    await vi.advanceTimersByTimeAsync(800);
    assistant.textContent = fencedCall + '\nDone.';
    await vi.advanceTimersByTimeAsync(300);
    expect(onToolTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(onToolTurn).toHaveBeenCalledTimes(1);
    expect(onToolTurn).toHaveBeenCalledWith([call], assistant);
  });
});
