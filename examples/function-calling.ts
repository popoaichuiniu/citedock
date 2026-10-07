import {
  createRagService,
  executeTool,
  loadConfig,
  searchTool,
} from "../src/index.js";

// Example for a backend that receives tool_calls from an OpenAI-compatible chat model.
// Send [searchTool] as the request's tools; dispatch only the returned tool call.
export const tools = [searchTool];
const rag = createRagService(loadConfig());
export async function handleToolCall(call: {
  id: string;
  function: { name: string; arguments: string };
}) {
  const result = await executeTool(
    rag,
    call.function.name,
    JSON.parse(call.function.arguments) as unknown,
  );
  return {
    role: "tool" as const,
    tool_call_id: call.id,
    content: JSON.stringify(result),
  };
}
