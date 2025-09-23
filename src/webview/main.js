const vscode = acquireVsCodeApi();

const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("prompt");

document.getElementById("approve")?.addEventListener("click", () => {
  vscode.postMessage({ type: "approve" });
});
document.getElementById("reject")?.addEventListener("click", () => {
  vscode.postMessage({ type: "reject" });
});
document.getElementById("details")?.addEventListener("click", () => {
  vscode.postMessage({ type: "details" });
});

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  append("user", text);
  vscode.postMessage({ type: "ask", text });
  input.value = "";
  startBotLine();
});

let botDiv = null;
function startBotLine() {
  botDiv = document.createElement("div");
  botDiv.className = "msg bot";
  botDiv.textContent = "";
  chat.appendChild(botDiv);
  chat.scrollTop = chat.scrollHeight;
}

function append(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.type === "delta") {
    if (!botDiv) startBotLine();
    botDiv.textContent += msg.text;
    chat.scrollTop = chat.scrollHeight;
  } else if (msg.type === "done") {
    botDiv = null;
  } else if (msg.type === "error") {
    append("bot", `⚠️ ${msg.message}`);
    botDiv = null;
  }
});
