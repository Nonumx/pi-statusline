import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const BRANCH_ICON = "\uf418";
const INPUT_ICON = "\ueaa1";
const OUTPUT_ICON = "\uea9a";

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

function shortCwd(ctx: ExtensionContext) {
  const home = homedir();
  if (ctx.cwd.startsWith(home)) {
    return "~" + ctx.cwd.slice(home.length);
  }
  return ctx.cwd;
}

function gitBranch(footerData: ReadonlyFooterDataProvider) {
  return `${BRANCH_ICON} ${footerData.getGitBranch()}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return Number.isInteger(v) ? `${v}k` : `${v.toFixed(1)}k`;
  }
  return `${Math.max(0, Math.round(n))}`;
}

function tokenStats(ctx: ExtensionContext) {
  const tokens = { input: 0, output: 0 };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const m = entry.message as AssistantMessage;
      tokens.input += m.usage.input;
      tokens.output += m.usage.output;
    }
  }

  const formattedInput = formatTokens(tokens.input);
  const formattedOutput = formatTokens(tokens.output);
  return `${INPUT_ICON} ${formattedInput} ${OUTPUT_ICON} ${formattedOutput}`;
}

function contextProgress(ctx: ExtensionContext, theme: Theme) {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!contextWindow) return undefined;

  const percent = usage?.percent;
  if (percent === null || percent === undefined) {
    return theme.fg("dim", `(${formatTokens(contextWindow)})`);
  }

  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.min(10, Math.ceil((pct * 10) / 100));

  let filledColor: string;
  if (pct < 50) {
    filledColor = theme.fg("success", "█");
  } else if (pct < 80) {
    filledColor = theme.fg("warning", "█");
  } else {
    filledColor = theme.fg("error", "█");
  }

  const bar = theme.fg("dim", "Ctx ") + filledColor.repeat(filled) + theme.fg("dim", "░".repeat(10 - filled));
  return `${bar} ${theme.fg("dim", `${pct}% (${formatTokens(contextWindow)})`)}`;
}

function modelInfo(ctx: ExtensionContext, thinkingLevel: ThinkingLevel) {
  const model = ctx.model?.id || ctx.model?.name || "";
  if (!model) {
    return "";
  }
  return `(${ctx.model.provider}) ${model} • ${thinkingLevel}`;
}

export default function (pi: ExtensionAPI) {
  // Per-agent-phase decode timing accumulators
  let decodeMs = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  // Wall-clock time of the first streaming chunk of the current assistant
  // message. Reset to null after each message_end so multi-turn runs (with
  // tool calls between LLM calls) accumulate decode time correctly.
  let decodeStart: number | null = null;

  const resetPhase = () => {
    decodeMs = 0;
    totalOutputTokens = 0;
    totalInputTokens = 0;
    decodeStart = null;
  };

  const customStatusline = (
    tui: TUI,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    ctx: ExtensionContext,
  ) => {
    return {
      dispose: footerData.onBranchChange(() => tui.requestRender()),
      invalidate() { },
      render(width: number) {
        const leftParts: string[] = [theme.fg("dim", shortCwd(ctx))];

        if (footerData.getGitBranch()) {
          leftParts.push(theme.fg("dim", gitBranch(footerData)))
        }

        leftParts.push(theme.fg("dim", tokenStats(ctx)))
        leftParts.push(contextProgress(ctx, theme))

        const rightParts = [theme.fg("dim", modelInfo(ctx, pi.getThinkingLevel()))];
        const sep = ` │ `;

        const left = leftParts.join(sep);
        const right = rightParts.join(sep);

        if (visibleWidth(right) >= width) {
          return [truncateToWidth(right, width)];
        }

        const maxLeftWidth = Math.max(0, width - visibleWidth(right) - 1);
        const fittedLeft = truncateToWidth(left, maxLeftWidth);
        const padding = " ".repeat(
          Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right)),
        );

        const line1 = fittedLeft + padding + right;
        return [line1];
      },
    };
  };

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) =>
      customStatusline(tui, theme, footerData, ctx),
    );
  });

  pi.on("agent_start", () => {
    resetPhase();
  });

  pi.on("message_update", () => {
    // message_update only fires for assistant streaming updates. Capture the
    // timestamp of the first chunk (post-prefill) to measure decode time.
    if (decodeStart === null) {
      decodeStart = Date.now();
    }
  });

  pi.on("message_end", (event) => {
    if (!isAssistantMessage(event.message)) return;
    if (decodeStart !== null) {
      decodeMs += Date.now() - decodeStart;
      decodeStart = null;
    }
    const m = event.message as AssistantMessage;
    totalInputTokens += m.usage.input || 0;
    totalOutputTokens += m.usage.output || 0;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (totalOutputTokens <= 0) return;

    const decodeSeconds = decodeMs / 1000;
    const tokensPerSecond = decodeSeconds > 0 ? totalOutputTokens / decodeSeconds : 0;
    const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s., ${INPUT_ICON} ${totalInputTokens.toLocaleString()}, ${OUTPUT_ICON} ${totalOutputTokens.toLocaleString()}, ${decodeSeconds.toFixed(1)}s`;
    ctx.ui.notify(message, "info");
  });
}
