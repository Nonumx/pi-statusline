import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export default function (pi: ExtensionAPI) {
    pi.registerCommand("hello", {
        description: "Say hello",
        handler: async (args, ctx) => {
            const name = args.trim() || "world";
            ctx.ui.notify(`Hello, ${name}`, "info");
            ctx.ui.setStatus("my-extension.mode", "Hello");
        }
    })

    pi.registerTool({
        "name": "greet",
        label: "Greet",
        description: "Greet someone by name",
        parameters: Type.Object({
            name: Type.String({ description: "Name to greet" })
        }),
        async execute(_toolCallId, params) {
            return {
                content: [{ type: "text", text: `Hello, ${params.name}!` }],
                details: { greeted: params.name },
            };
        },
    })

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify("my-pi-extension loaded", "info");
    });
}