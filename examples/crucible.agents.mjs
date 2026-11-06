// Copy to the directory where you run `crucible serve` (or set CRUCIBLE_AGENTS=path/to/this/file).
export default (ctx) => [
  {
    name: "support-triage",
    system: "You triage support tickets. Look up relevant docs, then either answer or escalate billing problems to a human.",
    model: { model: "smart", maxTokens: 800 },
    maxSteps: 6,
    maxCostUsd: 0.25,
    tools: [
      {
        name: "search_docs",
        description: "Search the help-center knowledge base",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        handler: async ({ query }, { projectId }) => {
          const kb = ctx.store.rag.listKbs(projectId)[0];
          if (!kb) return "no knowledge base";
          const hits = await ctx.rag.retrieve(kb, String(query), { k: 3 });
          return hits.map((h) => h.chunk.text).join("\n---\n");
        },
      },
      {
        name: "escalate",
        description: "Escalate the ticket to a human agent",
        inputSchema: { type: "object", properties: { ticketId: { type: "string" }, reason: { type: "string" } }, required: ["ticketId"] },
        requiresApproval: true,
        handler: async ({ ticketId, reason }) => `ticket ${ticketId} escalated (${reason ?? "no reason"})`,
      },
    ],
  },
];
