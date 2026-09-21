export async function recoverWorkerSession({
  createClient,
  moduleUrl,
  moduleOptions = {},
  workspaceStore,
  documents,
}) {
  if (typeof createClient !== "function" || !workspaceStore || !Array.isArray(documents)) {
    throw new TypeError("Worker recovery requires a client factory, workspace store and document list");
  }
  const client = createClient();
  try {
    await client.initialize(moduleUrl, moduleOptions);
  } catch (error) {
    client.terminate?.();
    throw error;
  }

  const restored = [];
  const failed = [];
  let activeDocumentId = null;
  let activeSnapshot = null;
  for (const document of documents) {
    try {
      const recovery = await workspaceStore.restore(document.workspaceId);
      const next = await client.open(recovery.bytes, recovery.manifest.name);
      const item = {
        previousDocumentId: document.documentId,
        documentId: next.documentId,
        workspaceId: document.workspaceId,
        confirmedAtCrash: document.confirmed !== false,
        manifest: recovery.manifest,
        snapshot: next,
      };
      restored.push(item);
      if (document.active) {
        activeDocumentId = next.documentId;
        activeSnapshot = next;
      }
    } catch (error) {
      failed.push({ ...document, error });
    }
  }

  if (!activeSnapshot && restored.length) {
    activeDocumentId = restored.at(-1).documentId;
    activeSnapshot = restored.at(-1).snapshot;
  }
  if (activeDocumentId != null && activeSnapshot?.documentId !== restored.at(-1)?.documentId) {
    activeSnapshot = await client.activateDocument(activeDocumentId);
  }
  return { client, restored, failed, activeSnapshot };
}
