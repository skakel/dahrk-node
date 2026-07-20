/**
 * The interactive-stage elicitation router (DHK-344): fans a single relayed human-turn stream out into
 * (a) conversational turns the interactive loop reads and (b) a blocking `ask` an injected
 * `AskUserQuestion` shadow tool awaits. One dispatcher is the sole consumer of the turn stream, so the
 * reply to an in-stage question never contends with the interactive loop's own next()-waiter while the
 * SDK is parked inside the tool. Runtime-agnostic and SDK-free, so it is unit-testable without a model.
 */
import type { HumanTurn } from "@dahrk/contracts";
import { ManagedMailbox } from "./mailbox.js";

/** The outcome of surfacing an interactive-stage elicitation (DHK-344) and awaiting the human's turn:
 *  a `reply` carrying the selected value, `noreply` on the idle deadline, `cancel` on abort or the
 *  turn stream ending, or `busy` when an elicit is already outstanding (one at a time). */
export type ElicitOutcome =
  | { kind: "reply"; text: string }
  | { kind: "noreply" }
  | { kind: "cancel" }
  | { kind: "busy" };

/** Map an elicit outcome to the exact tool-result text the model reads. Shared so both adapters
 *  (and the Pi no-handler fallback) return byte-identical strings. */
export function elicitOutcomeReply(outcome: ElicitOutcome): string {
  switch (outcome.kind) {
    case "reply":
      return `The user selected: ${outcome.text}`;
    case "busy":
      return "Only one question can be asked at a time; wait for the current one to be answered, then ask again.";
    case "noreply":
      return "No response from the user; proceed with your best judgement.";
    case "cancel":
      return "The question was cancelled.";
  }
}

/**
 * Fan a single relayed human-turn stream out into (a) conversational turns the interactive loop reads
 * and (b) a blocking `ask` an injected `AskUserQuestion` shadow tool awaits (DHK-344). One dispatcher
 * is the sole consumer of `turns`, so the reply to an in-stage question never contends with the
 * interactive loop's own next()-waiter while the SDK is parked inside the tool. Runtime-agnostic and
 * SDK-free, so it is unit-testable without invoking a model.
 */
export interface ElicitTurnRouter {
  /** Conversational turns: every relayed turn NOT consumed by an in-flight elicit. The interactive
   *  loop reads this in place of the raw turn stream; it ends when the underlying stream ends. */
  readonly conversation: AsyncIterable<HumanTurn>;
  /**
   * Surface an elicitation and block until the next relayed turn (reply), the idle deadline
   * (noreply), or abort / stream-end (cancel). Only one elicit may be in flight; a concurrent call
   * returns `busy` immediately without calling `onRaise`. `firstReply` selects the longer
   * opening-reply budget over the inter-turn idle window. `onRaise` fires synchronously once the
   * elicit is registered (not busy), so the caller emits its trace + wire frame exactly when the
   * question is actually raised.
   */
  ask(firstReply: boolean, onRaise: () => void): Promise<ElicitOutcome>;
}

export function createElicitTurnRouter(
  turns: AsyncIterable<HumanTurn>,
  opts: { signal: AbortSignal; firstReplyMs: number; idleMs: number },
): ElicitTurnRouter {
  const conversation = new ManagedMailbox<HumanTurn>();
  // Held on an object so a read in the dispatcher closure keeps the declared type: a bare `let`
  // reassigned only inside `ask` would be narrowed to `null` by control-flow analysis.
  const ref: { settle: ((o: ElicitOutcome) => void) | null } = { settle: null };
  void (async () => {
    try {
      for await (const t of turns) {
        const settle = ref.settle;
        if (settle) settle({ kind: "reply", text: t.text });
        else conversation.push(t);
      }
    } finally {
      conversation.end();
      const settle = ref.settle;
      if (settle) settle({ kind: "cancel" });
    }
  })();
  const ask = (firstReply: boolean, onRaise: () => void): Promise<ElicitOutcome> => {
    if (ref.settle) return Promise.resolve<ElicitOutcome>({ kind: "busy" });
    onRaise();
    return new Promise<ElicitOutcome>((resolve) => {
      let settled = false;
      const finish = (o: ElicitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        ref.settle = null;
        resolve(o);
      };
      const onAbort = (): void => finish({ kind: "cancel" });
      const timer = setTimeout(() => finish({ kind: "noreply" }), firstReply ? opts.firstReplyMs : opts.idleMs);
      if (opts.signal.aborted) {
        finish({ kind: "cancel" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      ref.settle = finish;
    });
  };
  return { conversation, ask };
}
