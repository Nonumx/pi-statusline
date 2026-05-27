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

const RESET = "\x1b[0m";

function color(c: string, text: string): string {
  return `${c}${text}${RESET}`;
}

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

function contextProgress(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!contextWindow) return undefined;

  const percent = usage?.percent;
  if (percent === null || percent === undefined) {
    return `(${formatTokens(contextWindow)})`;
  }

  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.min(10, Math.ceil((pct * 10) / 100));
  const bar = `Ctx ${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return `${bar} ${pct}% (${formatTokens(contextWindow)})`;
}

function modelInfo(ctx: ExtensionContext, thinkingLevel: ThinkingLevel) {
  const model = ctx.model?.id || ctx.model?.name || "";
  if (!model) {
    return "";
  }
  return `${model} • ${thinkingLevel}`;
}

export default function (pi: ExtensionAPI) {
  let agentStartMs: number | null = null;

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
        const leftParts: string[] = [shortCwd(ctx)];

        if (footerData.getGitBranch()) {
          leftParts.push(gitBranch(footerData))
        }

        leftParts.push(tokenStats(ctx))
        leftParts.push(contextProgress(ctx))

        const rightParts = [modelInfo(ctx, pi.getThinkingLevel())];
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
    agentStartMs = Date.now()
  })

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;
    if (elapsedMs <= 0) return;

    let input = 0;
    let output = 0;

    for (const message of event.messages) {
      if (!isAssistantMessage(message)) continue;
      input += message.usage.input || 0;
      output += message.usage.output || 0;
    }

    if (output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tokensPerSecond = output / elapsedSeconds;
    const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s., in ${input.toLocaleString()}, out ${output.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
    ctx.ui.setStatus("tps", message);
  })
}
