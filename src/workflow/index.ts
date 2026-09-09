/**
 * Entry point of the Render Workflow service. Importing the task module
 * registers every task; the SDK starts the task server on its own once
 * RENDER_SDK_SOCKET_PATH is present.
 */
import "./tasks.js";

console.log("n8n-guard workflow: tasks registered, waiting for task runs");
