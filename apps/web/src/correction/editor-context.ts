import type { Half, Side, StagingGameDocumentV2 } from "@kbo/contracts";
import type { DrawerRequest } from "./event-editor-registry";

export function canonicalIndexForRequest(document: StagingGameDocumentV2, request: DrawerRequest) {
  const eventId = request.mode === "add_event" ? request.beforeEventId : request.eventId;
  if (eventId === null) return document.events.length;
  const index = document.events.findIndex((event) => event.identity.eventId === eventId);
  return index < 0 ? document.events.length : index;
}

export function playerSideForRole(half: Half, role: string): Side {
  if (role === "batter" || role === "runner") return half === "top" ? "away" : "home";
  return half === "top" ? "home" : "away";
}
