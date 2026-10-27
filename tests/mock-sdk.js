// A stand-in for Anna's AnnaAppRuntime, for the UI smoke test only: in-memory storage and a scripted model.
const store = new Map();
const calls = (window.__annaCalls = []);
function reply({ systemPrompt, messages }) {
  if (/You work in steps/.test(systemPrompt || "")) {
    const n = messages.length;
    if (n === 1) return '{"tool": "find_areas", "args": {"text": "asyncio"}}';
    if (n === 3) return '{"tool": "who_knows", "args": {"area_ids": ["falkordb/asyncio"]}}';
    return '{"answer": "**@gkorland** knows the async client best: they reviewed [FalkorDB/falkordb-py#236] and wrote #247.\\n\\n- @swilly22 is next."}';
  }
  return "Thanks for the report! This looks related to [FalkorDB/falkordb-py#307]. @gkorland knows this area best.";
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
