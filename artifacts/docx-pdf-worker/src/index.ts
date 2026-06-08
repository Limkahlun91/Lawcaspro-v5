import { createApp } from "./app.js";

const portRaw = process.env.PORT;
const port = typeof portRaw === "string" ? Number(portRaw) : 0;
const listenPort = Number.isFinite(port) && port > 0 ? Math.trunc(port) : 8787;

const app = createApp();
app.listen(listenPort, () => {
  process.stdout.write(`docx-pdf-worker listening on ${listenPort}\n`);
});

