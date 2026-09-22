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
      let next = await client.open(recovery.bytes, recovery.manifest.name,
        { transferOwnership: true });
      if (recovery.selection) next = await applyRecoveredSelection(client, recovery.selection);
      const item = {
        previousDocumentId: document.documentId,
        documentId: next.documentId,
        workspaceId: document.workspaceId,
        confirmedAtCrash: document.confirmed !== false,
        format: recovery.manifest.format || "psd",
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

export async function applyRecoveredSelection(client, selection) {
  return client.setSelectionMask(selection.bounds, selection.gray,
    { transferOwnership: true });
}

export function checkpointSelection(state) {
  if (state?.selectionMask) return state.selectionMask;
  const rects = state?.selection;
  if (!Array.isArray(rects) || rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const width = right - left;
  const height = bottom - top;
  const area = width * height;
  if (!Number.isSafeInteger(area) || area <= 0 || area > 16 * 1024 * 1024) {
    return null;
  }
  const gray = new Uint8Array(area);
  for (const rect of rects) {
    const startX = rect.x - left;
    for (let y = rect.y - top; y < rect.y - top + rect.height; ++y) {
      gray.fill(255, y * width + startX, y * width + startX + rect.width);
    }
  }
  return { bounds: { x: left, y: top, width, height }, gray };
}
