export {};

const BASE_URL = process.env.E2E_BASE_URL || "https://lawcaspro-v5.vercel.app";
const EMAIL = process.env.E2E_FOUNDER_EMAIL;
const PASSWORD = process.env.E2E_FOUNDER_PASSWORD;

if (!EMAIL || !PASSWORD) {
  process.stderr.write("Missing E2E_FOUNDER_EMAIL or E2E_FOUNDER_PASSWORD\n");
  process.exit(2);
}

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as Json;
  } catch {
    return { raw: text };
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await readJson(res);
  assert(res.ok, `login failed: ${res.status} ${JSON.stringify(body)}`);
  const token = body.token;
  assert(typeof token === "string" && token.length > 0, "login did not return token");
  return token;
}

async function api(token: string, path: string, init?: RequestInit): Promise<{ res: Response; body: Json }> {
  const headers: Record<string, string> = {
    ...(init?.headers ? (init.headers as Record<string, string>) : {}),
    Authorization: `Bearer ${token}`,
  };
  const res = await fetch(`${BASE_URL}/api${path}`, { ...init, headers });
  const body = await readJson(res);
  return { res, body };
}

async function auditHas(token: string, action: string, atLeast: number = 1): Promise<void> {
  const { res, body } = await api(token, `/platform/audit-logs?action=${encodeURIComponent(action)}&limit=20`);
  assert(res.ok, `audit query failed: ${action} ${res.status} ${JSON.stringify(body)}`);
  const data = body.data;
  assert(Array.isArray(data), `audit response missing data[] for ${action}`);
  assert(data.length >= atLeast, `audit missing rows for ${action}`);
  const row = data[0] as Record<string, unknown>;
  assert(typeof row.action === "string", `audit row missing action for ${action}`);
  assert(typeof row.created_at === "string" || typeof row.created_at === "object", `audit row missing created_at for ${action}`);
}

function unique(prefix: string): string {
  return `${prefix} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function main() {
  const token = await login();

  const folderNameA = unique("E2E Folder A");
  const { res: createResA, body: folderA } = await api(token, "/platform/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderNameA, parentId: null }),
  });
  assert(createResA.status === 201, `create folder failed: ${createResA.status} ${JSON.stringify(folderA)}`);
  const folderAId = folderA.id;
  assert(typeof folderAId === "number", "create folder did not return id");
  await auditHas(token, "platform.system_folder.create");

  const renamedA = `${folderNameA} RENAMED`;
  const { res: renameResA, body: renamedFolderA } = await api(token, `/platform/folders/${folderAId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: renamedA }),
  });
  assert(renameResA.ok, `rename folder failed: ${renameResA.status} ${JSON.stringify(renamedFolderA)}`);
  await auditHas(token, "platform.system_folder.update");

  const { res: disableResA } = await api(token, `/platform/folders/${folderAId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isDisabled: true }),
  });
  assert(disableResA.ok, `disable folder failed: ${disableResA.status}`);
  await auditHas(token, "platform.system_folder.update");

  const { res: enableResA } = await api(token, `/platform/folders/${folderAId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isDisabled: false }),
  });
  assert(enableResA.ok, `enable folder failed: ${enableResA.status}`);
  await auditHas(token, "platform.system_folder.update");

  const { res: listBeforeRes, body: listBefore } = await api(token, "/platform/folders");
  assert(listBeforeRes.ok, `list folders failed: ${listBeforeRes.status} ${JSON.stringify(listBefore)}`);
  assert(Array.isArray(listBefore), "list folders did not return array");
  const rootBefore = (listBefore as any[]).filter((f) => f && f.parentId == null).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const idxBefore = rootBefore.findIndex((f) => f.id === folderAId);

  const { res: reorderUpRes } = await api(token, "/platform/folders/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderId: folderAId, direction: "up" }),
  });
  assert(reorderUpRes.ok, `reorder(up) failed: ${reorderUpRes.status}`);
  await auditHas(token, "platform.system_folder.reorder");

  const { res: listAfterRes, body: listAfter } = await api(token, "/platform/folders");
  assert(listAfterRes.ok, `list folders(after) failed: ${listAfterRes.status} ${JSON.stringify(listAfter)}`);
  assert(Array.isArray(listAfter), "list folders(after) did not return array");
  const rootAfter = (listAfter as any[]).filter((f) => f && f.parentId == null).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const idxAfter = rootAfter.findIndex((f) => f.id === folderAId);
  assert(idxBefore === -1 || idxAfter !== -1, "folder missing after reorder");
  if (idxBefore > 0) assert(idxAfter < idxBefore, "reorder(up) did not move folder up");

  const { res: reorderDownRes } = await api(token, "/platform/folders/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderId: folderAId, direction: "down" }),
  });
  assert(reorderDownRes.ok, `reorder(down) failed: ${reorderDownRes.status}`);
  await auditHas(token, "platform.system_folder.reorder");

  const { res: deleteFolderResA, body: deleteFolderBodyA } = await api(token, `/platform/folders/${folderAId}`, { method: "DELETE" });
  assert(deleteFolderResA.ok, `delete folder failed: ${deleteFolderResA.status} ${JSON.stringify(deleteFolderBodyA)}`);
  await auditHas(token, "platform.system_folder.delete");

  const folderNameB = unique("E2E Folder Docs");
  const { res: createResB, body: folderB } = await api(token, "/platform/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderNameB, parentId: null }),
  });
  assert(createResB.status === 201, `create folder(B) failed: ${createResB.status} ${JSON.stringify(folderB)}`);
  const folderBId = folderB.id;
  assert(typeof folderBId === "number", "create folder(B) did not return id");

  const fileName = "e2e-upload.txt";
  const contentType = "text/plain";
  const content = new TextEncoder().encode(`hello ${new Date().toISOString()}\n`);

  const { res: reqUrlRes, body: reqUrlBody } = await api(token, "/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: fileName, size: content.byteLength, contentType }),
  });
  assert(reqUrlRes.ok, `request upload url failed: ${reqUrlRes.status} ${JSON.stringify(reqUrlBody)}`);
  const uploadURL = reqUrlBody.uploadURL;
  const objectPath = reqUrlBody.objectPath;
  assert(typeof uploadURL === "string" && uploadURL.length > 0, "missing uploadURL");
  assert(typeof objectPath === "string" && objectPath.startsWith("/objects/"), "missing objectPath");

  const putRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": contentType }, body: content });
  assert(putRes.ok, `PUT upload failed: ${putRes.status}`);

  const docName = unique("E2E Doc");
  const { res: createDocRes, body: doc } = await api(token, "/platform/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: docName,
      description: "e2e",
      category: "general",
      fileName,
      fileType: contentType,
      fileSize: content.byteLength,
      objectPath,
      firmId: null,
      folderId: folderBId,
    }),
  });
  assert(createDocRes.status === 201, `create platform doc failed: ${createDocRes.status} ${JSON.stringify(doc)}`);
  const docId = doc.id;
  assert(typeof docId === "number", "create platform doc did not return id");
  await auditHas(token, "platform.document.create");

  const { res: listDocsRes, body: docs } = await api(token, `/platform/documents?folderId=${folderBId}`);
  assert(listDocsRes.ok, `list docs failed: ${listDocsRes.status} ${JSON.stringify(docs)}`);
  assert(Array.isArray(docs), "list docs did not return array");
  assert(docs.some((d: any) => d.id === docId), "created doc missing from list");

  const downloadRes = await fetch(`${BASE_URL}/api/platform/documents/${docId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(downloadRes.ok, `download failed: ${downloadRes.status}`);
  const dlType = downloadRes.headers.get("content-type") || "";
  assert(dlType.includes("text/plain") || dlType.includes("application/octet-stream"), `unexpected content-type: ${dlType}`);
  const disp = downloadRes.headers.get("content-disposition") || "";
  assert(disp.toLowerCase().includes("attachment"), "missing content-disposition attachment");
  const dlBytes = new Uint8Array(await downloadRes.arrayBuffer());
  assert(dlBytes.length === content.byteLength, "download size mismatch");

  const { res: deleteDocRes, body: deleteDocBody } = await api(token, `/platform/documents/${docId}`, { method: "DELETE" });
  assert(deleteDocRes.ok, `delete doc failed: ${deleteDocRes.status} ${JSON.stringify(deleteDocBody)}`);
  await auditHas(token, "platform.document.delete");

  const { res: listDocsAfterRes, body: docsAfter } = await api(token, `/platform/documents?folderId=${folderBId}`);
  assert(listDocsAfterRes.ok, `list docs(after) failed: ${listDocsAfterRes.status} ${JSON.stringify(docsAfter)}`);
  assert(Array.isArray(docsAfter), "list docs(after) did not return array");
  assert(!docsAfter.some((d: any) => d.id === docId), "deleted doc still present");

  const { res: deleteFolderResB, body: deleteFolderBodyB } = await api(token, `/platform/folders/${folderBId}`, { method: "DELETE" });
  assert(deleteFolderResB.ok, `delete folder(B) failed: ${deleteFolderResB.status} ${JSON.stringify(deleteFolderBodyB)}`);
  await auditHas(token, "platform.system_folder.delete");

  process.stdout.write("OK\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

