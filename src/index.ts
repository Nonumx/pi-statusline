import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// One Dark palette, matching ~/Developer/cc-statusline.
const GREEN = "\x1b[38;2;152;195;121m";
const RED = "\x1b[38;2;224;108;117m";
const YELLOW = "\x1b[38;2;229;192;123m";
const CYAN = "\x1b[38;2;86;182;194m";
const ORANGE = "\x1b[38;2;209;154;102m";
const GRAY = "\x1b[38;2;151;158;171m";
const DARK_GRAY = "\x1b[38;2;57;62;72m";
const RESET = "\x1b[0m";

const BRANCH_ICON = "\uf418";
const ADDED_ICON = "\ueadc";
const REMOVED_ICON = "\ueadf";
const INPUT_ICON = "\ueaa1";
const OUTPUT_ICON = "\uea9a";

interface TokenStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

interface GitStats {
    added: number;
    removed: number;
    binary: number;
}

function color(c: string, text: string): string {
    return `${c}${text}${RESET}`;
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

function formatProjectPath(cwd: string): string {
    const home = process.env.HOME;
    if (!home) return cwd;

    const normalizedHome = home.replace(/\/+$/, "");
    const normalizedCwd = cwd.replace(/\/+$/, "") || "/";
    if (normalizedCwd === normalizedHome) return "~";
    if (normalizedCwd.startsWith(`${normalizedHome}/`)) return `~/${normalizedCwd.slice(normalizedHome.length + 1)}`;
    return cwd;
}

function hasRole<R extends string>(message: unknown, role: R): message is { role: R; usage?: unknown } {
    return typeof message === "object" && message !== null && "role" in message && (message as { role?: unknown }).role === role;
}

function getAssistantUsage(message: unknown): TokenStats {
    if (!hasRole(message, "assistant")) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const usage = (message as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const u = usage as Record<string, unknown>;
    const cost = typeof u.cost === "object" && u.cost !== null ? (u.cost as Record<string, unknown>).total : 0;
    return {
        input: typeof u.input === "number" ? u.input : 0,
        output: typeof u.output === "number" ? u.output : 0,
        cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
        cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
        cost: typeof cost === "number" ? cost : 0,
    };
}

function collectTokenStats(ctx: ExtensionContext): TokenStats {
    const tokens: TokenStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const usage = getAssistantUsage(entry.message);
        tokens.input += usage.input;
        tokens.output += usage.output;
        tokens.cacheRead += usage.cacheRead;
        tokens.cacheWrite += usage.cacheWrite;
        tokens.cost += usage.cost;
    }

    return tokens;
}

function parseGitNumstat(stdout: string): GitStats {
    const stats: GitStats = { added: 0, removed: 0, binary: 0 };
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const [added, removed] = trimmed.split(/\s+/, 3);
        if (added === undefined || removed === undefined) continue;
        if (added === "-" || removed === "-") {
            stats.binary++;
            continue;
        }

        stats.added += Number.parseInt(added, 10) || 0;
        stats.removed += Number.parseInt(removed, 10) || 0;
    }
    return stats;
}

function sameGitStats(a: GitStats, b: GitStats): boolean {
    return a.added === b.added && a.removed === b.removed && a.binary === b.binary;
}

function modificationsPart(stats: GitStats): string {
    const main = `${color(GREEN, `${ADDED_ICON} ${stats.added}`)} ${color(RED, `${REMOVED_ICON} ${stats.removed}`)}`;
    return stats.binary > 0 ? `${main} ${color(YELLOW, `± ${stats.binary}`)}` : main;
}

function tokenPart(ctx: ExtensionContext): string {
    const stats = collectTokenStats(ctx);
    return color(
        CYAN,
        `${INPUT_ICON} ${formatTokens(stats.input + stats.cacheRead + stats.cacheWrite)} ${OUTPUT_ICON} ${formatTokens(stats.output)}`,
    );
}

function progressPart(ctx: ExtensionContext): string | undefined {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
    if (!contextWindow) return undefined;

    const percent = usage?.percent;
    if (percent === null || percent === undefined) {
        return `${GRAY}?% (${formatTokens(contextWindow)})${RESET}`;
    }

    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    const filled = Math.min(10, Math.ceil((pct * 10) / 100));
    const bar = `Ctx ${GREEN}${"█".repeat(filled)}${DARK_GRAY}${"░".repeat(10 - filled)}${RESET}`;
    return `${bar}${GRAY} ${pct}% (${formatTokens(contextWindow)})${RESET}`;
}

function rightStatus(ctx: ExtensionContext, thinkingLevel: string): string {
    const provider = ctx.model?.provider ?? "no-provider";
    const model = ctx.model?.id || ctx.model?.name || "no-model";
    return color(GRAY, `(${provider}) ${model} • ${thinkingLevel}`);
}

function joinStatusLine(leftParts: string[], right: string, width: number): string {
    const sep = ` ${DARK_GRAY}│${RESET} `;
    const left = leftParts.join(sep);

    if (width <= 0) return "";
    if (visibleWidth(right) >= width) return truncateToWidth(right, width);

    const maxLeftWidth = Math.max(0, width - visibleWidth(right) - 1);
    const fittedLeft = truncateToWidth(left, maxLeftWidth);
    const padding = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right)));
    return truncateToWidth(`${fittedLeft}${padding}${right}`, width);
}

function renderStatusLine(
    ctx: ExtensionContext,
    branch: string | null,
    gitStats: GitStats,
    thinkingLevel: string,
    width: number,
): string {
    const leftParts: string[] = [color(ORANGE, formatProjectPath(ctx.cwd))];

    if (branch) leftParts.push(color(YELLOW, `${BRANCH_ICON} ${branch}`));

    leftParts.push(modificationsPart(gitStats));
    leftParts.push(tokenPart(ctx));

    const progress = progressPart(ctx);
    if (progress) leftParts.push(progress);

    return joinStatusLine(leftParts, rightStatus(ctx, thinkingLevel), width);
}

class StatusFooter implements Component {
    private readonly unsubscribeBranch: () => void;

    constructor(
        private readonly tui: TUI,
        private readonly ctx: ExtensionContext,
        private readonly footerData: { getGitBranch(): string | null; onBranchChange(callback: () => void): () => void },
        private readonly getGitStats: () => GitStats,
        private readonly getThinkingLevel: () => string,
    ) {
        this.unsubscribeBranch = footerData.onBranchChange(() => this.tui.requestRender());
    }

    render(width: number): string[] {
        if (width <= 0) return [""];
        const line = renderStatusLine(this.ctx, this.footerData.getGitBranch(), this.getGitStats(), this.getThinkingLevel(), width);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
        return [line + padding];
    }

    invalidate(): void { }

    dispose(): void {
        this.unsubscribeBranch();
    }
}

export default function (pi: ExtensionAPI) {
    let activeTui: TUI | undefined;
    let activeCtx: ExtensionContext | undefined;
    let enabled = true;
    let gitStats: GitStats = { added: 0, removed: 0, binary: 0 };
    let gitRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let gitRefreshInFlight = false;

    const requestRender = () => activeTui?.requestRender();

    const refreshGitStats = async (ctx = activeCtx) => {
        if (!ctx || gitRefreshInFlight) return;
        gitRefreshInFlight = true;
        try {
            // Compare the whole working tree against HEAD, so a commit clears the counters
            // on the next refresh. This includes both staged and unstaged tracked changes.
            const result = await pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd: ctx.cwd, timeout: 2_000 });
            const next = result.code === 0 ? parseGitNumstat(result.stdout) : { added: 0, removed: 0, binary: 0 };
            if (!sameGitStats(gitStats, next)) {
                gitStats = next;
                requestRender();
            }
        } catch {
            const next = { added: 0, removed: 0, binary: 0 };
            if (!sameGitStats(gitStats, next)) {
                gitStats = next;
                requestRender();
            }
        } finally {
            gitRefreshInFlight = false;
        }
    };

    const stopGitRefresh = () => {
        if (gitRefreshTimer) {
            clearInterval(gitRefreshTimer);
            gitRefreshTimer = undefined;
        }
    };

    const startGitRefresh = (ctx: ExtensionContext) => {
        stopGitRefresh();
        void refreshGitStats(ctx);
        gitRefreshTimer = setInterval(() => void refreshGitStats(ctx), 2_000);
    };

    const install = (ctx: ExtensionContext) => {
        activeCtx = ctx;
        ctx.ui.setFooter((tui, _theme, footerData) => {
            activeTui = tui;
            return new StatusFooter(
                tui,
                ctx,
                footerData,
                () => gitStats,
                () => String(pi.getThinkingLevel()),
            );
        });
        startGitRefresh(ctx);
    };

    pi.registerCommand("statusline", {
        description: "Toggle pi-statusline footer",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            if (enabled) {
                install(ctx);
                ctx.ui.notify("pi-statusline enabled", "info");
            } else {
                ctx.ui.setFooter(undefined);
                activeTui = undefined;
                activeCtx = undefined;
                stopGitRefresh();
                ctx.ui.notify("pi-statusline disabled", "info");
            }
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        gitStats = { added: 0, removed: 0, binary: 0 };
        if (enabled) install(ctx);
    });

    pi.on("session_shutdown", () => {
        activeTui = undefined;
        activeCtx = undefined;
        stopGitRefresh();
    });

    pi.on("model_select", requestRender);
    pi.on("thinking_level_select", requestRender);
    pi.on("turn_end", async () => {
        await refreshGitStats();
        requestRender();
    });
    pi.on("message_end", requestRender);
    pi.on("tool_result", async () => {
        await refreshGitStats();
        requestRender();
    });
}
