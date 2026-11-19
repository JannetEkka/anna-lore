// A stand-in for Anna's AnnaAppRuntime, for the UI smoke test only: in-memory storage and a scripted model.
const store = new Map();
const calls = (window.__annaCalls = []);
function reply({ systemPrompt, messages }) {
  const last = messages.at(-1)?.content?.text ?? "";
  // Lore's one follow-up when a text claims too much or promises something (v0.1.2).
  const rewrite = /^These sentences/.test(last);
  // A model that ignores the instructions and the follow-up, to exercise the notes that stay on screen.
  const stubborn = window.__mockOverstates;
  if (/You work in steps/.test(systemPrompt || "")) {
    const n = messages.length;
    if (stubborn) {
      if (n === 1) return '{"tool": "knowledge_risk", "args": {}}';
      return '{"answer": "Only @gkorland knows `falkordb/asyncio` well, so it has a bus factor of one [FalkorDB/falkordb-py#236].\\n\\nBased on the fetched data, @swilly22 has reviewed there too."}';
    }
    if (window.__mockOverclaims) {
      // What Anna's reviewer saw on Nov 17, on a load that wasn't partial.
      if (n === 1) return '{"tool": "who_knows", "args": {"area_ids": ["falkordb", "falkordb/asyncio", "tests"]}}';
      // True to the data: who_knows on these areas of the complete small load.
      if (rewrite) return '{"answer": "In the history Lore read, @Naseem77 has the most activity in these areas: they authored [FalkorDB/falkordb-py#267] and reviewed [FalkorDB/falkordb-py#276], 2 of the 3 merged PRs that touch them. @SantoshDhaladhuli authored [FalkorDB/falkordb-py#276] and @dudizimber authored [FalkorDB/falkordb-py#307]."}';
      return '{"answer": "@Naseem77 is the only person who broadly understands the repository [FalkorDB/falkordb-py#267]."}';
    }
    if (n === 1) return '{"tool": "find_areas", "args": {"text": "asyncio"}}';
    if (n === 3) return '{"tool": "who_knows", "args": {"area_ids": ["falkordb/asyncio"]}}';
    return '{"answer": "**@gkorland** has the most activity in the async client: they reviewed [FalkorDB/falkordb-py#236, FalkorDB/falkordb-py#198] and wrote #247.\\n\\n- @swilly22 has the next most."}';
  }
  if (rewrite && !stubborn) return "Thanks for the report. This looks related to [FalkorDB/falkordb-py#307], which @dudizimber authored and which changed the same retry code.";
  return "Thanks for the report! We'll fix this in the next release. This looks related to [FalkorDB/falkordb-py#307]. @gkorland will take a look this week.";
}
export const AnnaAppRuntime = {
  async connect() {
    return {
      windowUuid: "w-test", appId: "1", versionId: "1", entryPayload: window.__entryPayload || {}, runtimeState: {},
      theme: "light",
      onThemeChange(cb) { cb({ theme: "light" }); return () => {}; },
      on() { return () => {}; },
      llm: {
        async complete(args) {
          calls.push(["llm.complete", args]);
          const text = reply({ systemPrompt: args.systemPrompt, messages: args.messages });
          return { role: "assistant", content: { type: "text", text }, model: "mock", stopReason: "endTurn", usage: {} };
        },
      },
      storage: {
        async get({ key }) { calls.push(["storage.get", key]); return store.has(key) ? { exists: true, value: store.get(key) } : { exists: false, value: null }; },
        async set({ key, value }) { calls.push(["storage.set", key]); store.set(key, JSON.parse(JSON.stringify(value))); return { etag: "x" }; },
      },
      window: { async set_title() { return {}; } },
    };
  },
};
