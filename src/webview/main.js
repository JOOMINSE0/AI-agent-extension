const vscode = acquireVsCodeApi();

document.getElementById("approve")?.addEventListener("click", () => {
  vscode.postMessage({ type: "approve", changeId: "chg-1234" });
});
document.getElementById("reject")?.addEventListener("click", () => {
  vscode.postMessage({ type: "reject", changeId: "chg-1234" });
});
document.getElementById("details")?.addEventListener("click", () => {
  vscode.postMessage({ type: "viewDetails", changeId: "chg-1234" });
});

const form = document.getElementById("composer");
const input = document.getElementById("prompt");

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  appendUser(text);
  vscode.postMessage({ type: "ask", text });
  input.value = "";
});

function appendUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  document.getElementById("chat").appendChild(div);
}
